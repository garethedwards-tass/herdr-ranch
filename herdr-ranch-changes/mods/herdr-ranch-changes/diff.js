// A pull request's file diffs: GitHub's per-file `patch` (a unified diff without the file
// headers) parsed once, at load, into hunks of numbered lines, and paired into rows for the
// split view. No Herdr calls here, so the tests run it as it is.

// What one file may draw at first, and what "Show more" adds: a long diff laid out in one
// render takes the page past Herdr's time limit.
export const FIRST_LINES = 400, MORE_LINES = 800;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
// Tabs as spaces, so code lines up the same in both columns. A very long line (minified code,
// data on one line) is cut: wrapped whole it fills the page and slows the render.
export const MAX_CHARS = 500;
const untab = (s) => {
  const t = s.replace(/\t/g, "    ");
  return t.length <= MAX_CHARS ? t : `${t.slice(0, MAX_CHARS)} … ${t.length - MAX_CHARS} more characters`;
};

// `patch` → [{ header, context, lines: [{ kind: "add" | "del" | "ctx" | "note", old, new, text }] }].
// "note" is git's "\ No newline at end of file". Lines before the first @@ are ignored.
export function parsePatch(patch) {
  const hunks = [];
  let h = null, o = 0, n = 0;
  // A patch may end in a newline: that isn't an empty line of the file.
  for (const raw of (patch ?? "").replace(/\r?\n$/, "").split(/\r?\n/)) {
    const m = HUNK.exec(raw);
    if (m) {
      o = Number(m[1]); n = Number(m[3]);
      h = { header: raw.slice(0, raw.indexOf("@@", 2) + 2), context: m[5].trim(), oldStart: o, newStart: n, lines: [] };
      hunks.push(h);
      continue;
    }
    if (!h) continue;
    const c = raw[0], text = untab(raw.slice(1));
    if (c === "+") h.lines.push({ kind: "add", old: null, new: n++, text });
    else if (c === "-") h.lines.push({ kind: "del", old: o++, new: null, text });
    else if (c === "\\") h.lines.push({ kind: "note", old: null, new: null, text: raw.slice(2) });
    // A context line starts with a space; an empty one has lost it on the way now and then.
    else if (c === " " || raw === "") h.lines.push({ kind: "ctx", old: o++, new: n++, text });
  }
  return hunks;
}

// The split view's rows for one hunk: context on both sides; a run of deletions beside the run
// of additions that follows it, line by line, the longer run's extra lines against a blank.
export function splitRows(hunk) {
  const rows = [], lines = hunk.lines;
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.kind === "ctx") { rows.push({ left: l, right: l }); i++; continue; }
    if (l.kind === "note") { rows.push({ note: l.text }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

// A file from GitHub's pulls/{n}/files, ready to draw: status, path (and the old path of a
// rename), counts, its hunks (with split rows) and how many lines it has in all. A file
// without a patch (binary, or too large for the API) says why.
export function prepareFile(f) {
  const hunks = f.patch == null ? [] : parsePatch(f.patch);
  for (const h of hunks) h.rows = splitRows(h);
  const lines = hunks.reduce((s, h) => s + h.lines.length + 1, 0);
  // How wide the line numbers are, so the gutter fits the largest one.
  let top = 0;
  for (const h of hunks) for (const l of h.lines) top = Math.max(top, l.old ?? 0, l.new ?? 0);
  const why = f.patch != null ? null
    : f.status === "renamed" && !f.changes ? "Renamed without changes."
    : f.status === "removed" && !f.deletions ? "Empty file removed."
    : f.status === "added" && !f.additions ? "Empty file added."
    : "No diff to show: a binary file, or too large for GitHub's API.";
  return {
    path: f.filename, from: f.previous_filename ?? null, status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0,
    hunks, lines, why, digits: Math.max(3, String(top).length),
  };
}

// The first `limit` lines of a file's diff in the given mode, hunk by hunk: each hunk is
// { header, context, items } (lines, or split rows), cut where the limit runs out.
// Returns { hunks, shown, total } in that mode's units (a hunk header counts as one).
export function visible(file, mode, limit) {
  const out = [];
  let shown = 0, total = 0;
  for (const h of file.hunks) {
    const items = mode === "split" ? h.rows : h.lines;
    total += items.length + 1;
    if (shown >= limit) continue;
    const room = limit - shown - 1;
    const take = items.slice(0, Math.max(0, room));
    out.push({ header: h.header, context: h.context, items: take });
    shown += take.length + 1;
  }
  return { hunks: out, shown: Math.min(shown, total), total };
}

// The key a file's state (open, viewed, lines shown) is kept under, per pull request and
// its head commit: a new push resets what was marked viewed.
export const fileKey = (github, number, head, path) => `${github}#${number}@${head ?? ""}:${path}`;

// `git show` or `git diff` output → [{ filename, previous_filename, status, additions, deletions, changes,
// patch }], one per "diff --git" section; `patch` starts at its first @@ (null for binary or
// mode-only changes), as GitHub's API gives it.
export function parseShow(text) {
  const files = [];
  let f = null;
  const unq = (p) => (p.startsWith("\"") ? p.slice(1, -1) : p);
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      f = { filename: unq(head[2]), previous_filename: null, status: "modified", additions: 0, deletions: 0, changes: 0, patch: null, body: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (f.patch == null && !line.startsWith("@@")) {
      if (line.startsWith("new file mode")) f.status = "added";
      else if (line.startsWith("deleted file mode")) f.status = "removed";
      else if (line.startsWith("rename from ")) { f.status = "renamed"; f.previous_filename = line.slice(12); }
      else if (line.startsWith("copy from ")) { f.status = "copied"; f.previous_filename = line.slice(10); }
      continue;
    }
    f.patch ??= "";
    f.body.push(line);
    if (line.startsWith("+")) f.additions++;
    else if (line.startsWith("-")) f.deletions++;
  }
  for (const x of files) {
    x.patch = x.body.length ? x.body.join("\n") : null;
    x.changes = x.additions + x.deletions;
    delete x.body;
  }
  return files;
}
