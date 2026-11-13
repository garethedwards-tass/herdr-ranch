// Syntax highlighting for the diff views, from the ranch-highlight helper (tree-sitter, in Rust:
// mods can't load native code). Herdr's exec has no stdin, so each batch of requests goes
// through a file under the app's data folder. Without the helper the diffs stay plain.
//
// A file's two sides are highlighted whole when their commits are in a local repository (a git
// blob, read by the helper itself), so a hunk inside a comment or a string colors right; else
// from the hunk lines alone. The answer is, per side, a Map of line number → spans
// [[start, end, class], ...] in the diff's own columns (a tab counts as 4, as diff.js shows it).

import { exec, appHome, home, writeTextFile } from "herdr";

const DIR = "data/herdr-ranch/highlight", TAB = 4;
let found = null, seq = 0;

// The helper: ~/.local/bin/ranch-highlight (where install.sh links it), else on the PATH. Asked
// once per session; a later install shows after a reload.
async function helper() {
  found ??= (async () => {
    for (const bin of [`${home()}/.local/bin/ranch-highlight`, "ranch-highlight"]) {
      const r = await exec(bin, ["--languages"], { timeout: 5000 }).catch(() => null);
      if (r?.code === 0) return bin;
    }
    return null;
  })();
  return found;
}

// Runs a batch: `reqs` as the helper takes them, each with an `id`. Returns Map id → answer
// ({ lang, lines, error }), or null without the helper.
export async function run(reqs) {
  const bin = await helper();
  if (!bin || !reqs.length) return bin ? new Map() : null;
  const dir = `${appHome()}/${DIR}`, file = `${dir}/req-${Date.now().toString(36)}-${(seq++).toString(36)}.jsonl`;
  await exec("mkdir", ["-p", dir]).catch(() => null);
  try {
    await writeTextFile(file, `${reqs.map((r) => JSON.stringify(r)).join("\n")}\n`, null);
    const r = await exec(bin, ["--requests", file], { timeout: 30000 });
    const out = new Map();
    for (const line of (r.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      try { const a = JSON.parse(line); out.set(a.id, a); } catch { /* a cut line: that file stays plain */ }
    }
    return out;
  } finally { exec("rm", ["-f", file]).catch(() => null); }
}

// One side of a file from its hunks alone: the text, and which diff line each text line is.
function fragment(f, side) {
  const text = [], at = new Map();
  for (const h of f.hunks) {
    if (text.length) text.push("");
    for (const l of h.lines) {
      const n = side === "old" ? l.old : l.new;
      if (n == null || l.kind === "note") continue;
      at.set(n, text.length); text.push(l.text);
    }
  }
  return { text: text.join("\n"), at };
}

// Highlights the given files (prepared by diff.js) in place: each gets `hl = { old, new }`.
// `git`: { cwd, oldRev, newRev } when both commits may be in that local repository, else null;
// a `newRev` of "" means the working tree (the file on disk).
// Sides git can't give (a missing commit, a shallow clone) are done from the hunks.
export async function highlightFiles(files, git) {
  const todo = files.filter((f) => f.hunks.length && !f.hl);
  if (!todo.length) return false;
  const reqs = [], frag = new Map();
  todo.forEach((f, i) => {
    for (const side of ["old", "new"]) {
      const id = `${i}:${side}`, path = side === "old" ? f.from ?? f.path : f.path;
      if ((side === "old" && f.status === "added") || (side === "new" && f.status === "removed")) continue;
      const rev = side === "old" ? git?.oldRev : git?.newRev;
      if (git?.cwd && side === "new" && rev === "") reqs.push({ id, path, file: `${git.cwd}/${path}`, tab: TAB });
      else if (git?.cwd && rev) reqs.push({ id, path, git: { cwd: git.cwd, rev, path }, tab: TAB });
      else { const fr = fragment(f, side); frag.set(id, fr.at); reqs.push({ id, path, text: fr.text, tab: TAB }); }
    }
  });
  let got = await run(reqs);
  if (!got) return false;
  // Sides git couldn't read: again from the hunks.
  const retry = reqs.filter((r) => (r.git || r.file) && (got.get(r.id)?.error || !got.get(r.id))).map((r) => {
    const [i, side] = r.id.split(":"), fr = fragment(todo[Number(i)], side);
    frag.set(r.id, fr.at);
    return { id: r.id, path: r.path, text: fr.text, tab: TAB };
  });
  if (retry.length) for (const [k, v] of (await run(retry)) ?? []) got.set(k, v);
  todo.forEach((f, i) => {
    const hl = { old: new Map(), new: new Map() };
    for (const side of ["old", "new"]) {
      const a = got.get(`${i}:${side}`), at = frag.get(`${i}:${side}`);
      if (!a?.lines?.length) continue;
      if (at) for (const [n, idx] of at) { if (a.lines[idx]?.length) hl[side].set(n, a.lines[idx]); }
      else a.lines.forEach((spans, idx) => { if (spans.length) hl[side].set(idx + 1, spans); });
    }
    f.hl = hl;
  });
  return true;
}

// The spans of one diff line: deletions from the old side, the rest from the new.
export const spansOf = (f, l) => (l.kind === "del" ? f.hl?.old.get(l.old) : f.hl?.new.get(l.new) ?? f.hl?.old.get(l.old)) ?? null;
