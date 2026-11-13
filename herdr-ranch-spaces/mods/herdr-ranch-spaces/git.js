// The Spaces list's git side: where a space is, what git says about that place (repo, branch,
// ahead/behind, worktree or main checkout), a repository's worktrees, and the rows in order
// (worktree spaces under their repository's space, checkouts without a space after them).
// Plain functions, tested in tests/spaces.test.mjs.

import { exec } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}
// A place as one key: [machine, folder].
export const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
export const base = (path) => (path ?? "").replace(/[/\\]+$/, "").split(/[/\\]/).pop();
// A repository's main checkout from git's common dir ("/x/repo/.git" -> "/x/repo"), as links.js stores it.
export const mainOf = (common) => common.replace(/\/\.git\/?$/, "");

// One place's git: { name, branch, ahead, behind, repo, main, top, linked }, null outside git.
// `repo` is a key ([machine, common dir]) shared by every checkout of one repository.
// Throws when git couldn't be asked (a machine away), so the caller asks again later.
export async function probe(cwd, on) {
  // Ref-only reads: no scan of the worktree, nothing written under .git.
  const [top, common] = await Promise.all([
    exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
    exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
  ]);
  if (top.code !== 0 || common.code !== 0) {
    if (/not a git repository/i.test(top.code !== 0 ? top.stderr : common.stderr)) return null;
    throw new Error((top.stderr || common.stderr || "git failed").trim());
  }
  const t = top.stdout.replace(/\n$/, ""), c = common.stdout.replace(/\n$/, "");
  const [branch, counts] = await Promise.all([
    exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
    exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
  ]);
  const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  return {
    name: c.endsWith("/.git") ? base(c.slice(0, -5)) : base(c).replace(/\.git$/, ""),
    branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : null,
    ahead: ahead || 0, behind: behind || 0,
    repo: JSON.stringify([on ?? null, c]), main: mainOf(c), top: t, linked: c !== `${t}/.git`,
  };
}

// `git worktree list --porcelain` as [{ path, branch, main, locked }], the main checkout first;
// bare and prunable entries left out.
export function parseWorktrees(text) {
  const out = [];
  for (const block of (text ?? "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const skip = lines.some((l) => l === "bare" || l.startsWith("prunable"));
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    if (!skip) out.push({ path, branch, main: out.length === 0 && !skip, locked: lines.some((l) => l.startsWith("locked")) });
    else if (out.length === 0) out.push(null); // the main entry was bare: keep "first is main" honest
  }
  return out.filter(Boolean);
}

export async function worktrees(main, on) {
  const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main, on });
  return r.code === 0 ? parseWorktrees(r.stdout) : [];
}

const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// The rows to draw, in order:
//   { kind: "space", w, i, g, tree, children? }   a space (tree "├─"/"└─" for a worktree under its repo's
//                                       space; `children`: how many rows fold under it)
// Every row under a space has `parent` (that space's id).
//   { kind: "more", repo, count, open } the fold for a repository's checkouts without a space
//   { kind: "loose", repo, c, tree }    one of those checkouts
// `list`: [{ w, i, g, at }] (at: the space's folder now); `trees`: repo key -> parseWorktrees();
// `open`: repo keys whose loose checkouts are unfolded.
export function arrange(list, trees = {}, open = new Set()) {
  const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
  const nested = (r) => r.g?.linked && mains.has(r.g.repo);
  const out = [];
  const placed = new Set();
  for (const r of list) {
    if (nested(r)) continue;
    const head = { kind: "space", ...r, tree: null, children: 0 };
    out.push(head);
    if (!r.g || placed.has(r.g.repo)) continue;
    placed.add(r.g.repo);
    const kids = r.g.linked ? [] : list.filter((k) => nested(k) && k.g.repo === r.g.repo);
    // Checkouts no space of this repository is in (on the same machine).
    const shown = list.filter((k) => k.g?.repo === r.g.repo).map((k) => k.at).filter(Boolean);
    const all = trees[r.g.repo] ?? [];
    const loose = r.g.linked ? [] : all.filter((c) => !c.main && !shown.some((at) => inside(at, c.path) && !all.some((d) => d !== c && d.path.length > c.path.length && inside(at, d.path))));
    const unfolded = open.has(r.g.repo);
    const tail = [
      ...kids.map((k) => ({ kind: "space", ...k })),
      ...(loose.length ? [{ kind: "more", repo: r.g.repo, count: loose.length, busy: loose.filter(hasWork).length, dirty: loose.filter((c) => c.changes > 0).length, unpushed: loose.filter((c) => c.unpushed > 0).length, open: unfolded }] : []),
      ...(unfolded ? loose.map((c) => ({ kind: "loose", repo: r.g.repo, main: r.g.main, c, on: r.w.machine ?? null })) : []),
    ];
    // `parent`: the space they fold under; the loose rows count once, in their own fold.
    head.children = kids.length + (loose.length ? 1 : 0);
    tail.forEach((row, n) => out.push({ ...row, tree: n === tail.length - 1 ? "└─" : "├─", parent: r.w.id }));
  }
  return out;
}

// After the name: the repository when the name doesn't say it, then the branch ("herdr · spike"). The repository goes on a
// worktree row and when the name is the repository. The branch always shows, main and master too.
export function tail(g, tree, name) {
  if (!g) return "";
  const same = (a) => (a ?? "").toLowerCase() === (name ?? "").toLowerCase();
  const branch = g.branch ?? "detached";
  return [tree || same(g.name) ? "" : g.name, branch].filter(Boolean).join(" · ");
}

// A space's link as a short label: the Jira or Linear key, else the GitHub repository's name.
export function linkLabel(link) {
  if (!link) return "";
  if (link.issues === "linear" && link.linear?.key) return link.linear.key;
  if (link.jira?.key && link.issues !== "github") return link.jira.key;
  return link.github ? link.github.split("/").pop() : link.jira?.key ?? "";
}

// How many entries `git status --porcelain=v1 -z --no-renames` lists.
export const countStatus = (out) => (out ?? "").split("\0").filter(Boolean).length;

// Reads that write nothing under .git (no index refresh, no lock), so they don't wake the watch.
const QUIET = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// A checkout's outstanding work: { changes: uncommitted files, unpushed: commits on no remote }.
// `remotes`: the repository has a remote (without one every commit would count as unpushed).
// A count git couldn't give is null.
export async function workIn(path, on, remotes) {
  const [status, ahead] = await Promise.all([
    exec("git", [...QUIET, "status", "--porcelain=v1", "-z", "--no-renames"], { cwd: path, on }),
    remotes ? exec("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: path, on }) : null,
  ]);
  return {
    changes: status.code === 0 ? countStatus(status.stdout) : null,
    unpushed: ahead?.code === 0 ? Number(ahead.stdout.trim()) || 0 : remotes ? null : 0,
  };
}

// A repository's worktrees, each with its work (see workIn).
export async function worktreesWithWork(main, on) {
  const [list, remote] = await Promise.all([worktrees(main, on), exec("git", ["remote"], { cwd: main, on })]);
  const remotes = remote.code === 0 && remote.stdout.trim() !== "";
  await Promise.all(list.map(async (c) => { try { Object.assign(c, await workIn(c.path, on, remotes)); } catch { /* unknown */ } }));
  return list;
}

// Whether a checkout has work that a delete would lose or leave behind.
export const hasWork = (c) => Boolean(c && (c.changes > 0 || c.unpushed > 0));
// "3 changed · 2 unpushed", for tooltips and the delete dialog.
export function workText(c) {
  if (!c) return "";
  return [c.changes > 0 && `${c.changes} uncommitted file${c.changes === 1 ? "" : "s"}`, c.unpushed > 0 && `${c.unpushed} commit${c.unpushed === 1 ? "" : "s"} not pushed anywhere`].filter(Boolean).join(" · ");
}
// The checkout a place is in: the deepest one that holds it.
export function checkoutAt(list, at) {
  return (list ?? []).filter((c) => at && inside(at, c.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

// Where a new worktree goes, as Herdr's worktree dialog puts it: <home>/.herdr/worktrees/<repo>/<branch>.
export const folderSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const worktreePath = (home, repo, branch) => `${home}/.herdr/worktrees/${repo}/${folderSlug(branch)}`;

// A branch name for an issue: "TASS-123-fix-the-login-page", "issue-12-fix-the-login-page".
export function issueBranch(key, title) {
  const words = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 6).join("-").slice(0, 40).replace(/-+$/, "");
  const head = /^#?\d+$/.test(key) ? `issue-${key.replace("#", "")}` : key;
  return words ? `${head}-${words}` : head;
}

// `git for-each-ref --sort=-committerdate --format=%(refname)%09%(committerdate:unix) refs/heads refs/remotes`
// as [{ name, remote, ref, at, path }], newest first: local branches, then remote ones without
// a local branch of that name (remote: "origin"). `path`: the worktree it's checked out in.
export function parseRefs(text, checkouts = []) {
  const at = new Map(checkouts.filter((c) => c.branch).map((c) => [c.branch, c.path]));
  const rows = (text ?? "").split("\n").filter(Boolean).map((l) => { const [ref, when] = l.split("\t"); return { ref, at: Number(when) || 0 }; });
  const local = new Set(rows.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => r.ref.slice(11)));
  const out = [];
  for (const r of rows) {
    if (r.ref.startsWith("refs/heads/")) { const name = r.ref.slice(11); out.push({ name, remote: null, ref: name, at: r.at, path: at.get(name) ?? null }); continue; }
    const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(r.ref);
    if (!m || m[2] === "HEAD" || local.has(m[2]) || out.some((o) => o.name === m[2])) continue;
    out.push({ name: m[2], remote: m[1], ref: `${m[1]}/${m[2]}`, at: r.at, path: null });
  }
  return out;
}

export async function branches(main, on, checkouts) {
  const r = await exec("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes"], { cwd: main, on });
  return r.code === 0 ? parseRefs(r.stdout, checkouts).slice(0, 300) : [];
}

// The arguments for `git worktree add`: an existing local branch is checked out, a remote one
// gets a local branch that tracks it, a new one starts from `from` (the space's HEAD).
export function addArgs(path, b, from = "HEAD") {
  if (b.remote) return ["worktree", "add", "--track", "-b", b.name, path, b.ref];
  if (b.exists) return ["worktree", "add", path, b.name];
  return ["worktree", "add", "-b", b.name, path, from];
}

// The home folder on a machine (null: this computer's).
export async function homeOn(on, local) {
  if (!on) return local;
  let r;
  try { r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }); } catch { /* not a shell */ }
  if (!r || r.code !== 0 || !r.stdout.trim()) r = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error("Couldn't find the home folder there.");
  return r.stdout.trim().replace(/\\/g, "/");
}

// `git status --porcelain=v1 -z --branch --no-renames`: { branch, upstream, ahead, behind, gone,
// files: [{ path, x, y, kind }] }, kind: "conflict" | "untracked" | "staged" | "changed" | "both".
export function parseStatus(out) {
  const parts = (out ?? "").split("\0").filter(Boolean);
  const head = parts[0]?.startsWith("## ") ? parts.shift().slice(3) : "";
  const m = /^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head) ?? [];
  const info = m[3] ?? "";
  const files = parts.map((p) => {
    const x = p[0], y = p[1], path = p.slice(3);
    const kind = x === "?" ? "untracked" : x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D") ? "conflict" : x !== " " && y !== " " ? "both" : x !== " " ? "staged" : "changed";
    return { path, x, y, kind };
  });
  return {
    branch: !m[1] || m[1].startsWith("HEAD (no branch)") ? null : m[1], upstream: m[2] ?? null,
    ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0), gone: info === "gone",
    files,
  };
}

export async function status(top, on) {
  const r = await exec("git", [...QUIET, "status", "--porcelain=v1", "-z", "--branch", "--no-renames"], { cwd: top, on });
  if (r.code !== 0) throw new Error((r.stderr || "git status failed").trim());
  return parseStatus(r.stdout);
}

// `git switch` for a branch from branches(): a remote one gets a local branch that tracks it,
// a new one (fresh) starts from HEAD.
export function switchArgs(b) {
  if (b.fresh) return ["switch", "-c", b.name];
  if (b.remote) return ["switch", "--track", "-c", b.name, b.ref];
  return ["switch", b.name];
}

// git's "can't fast-forward" answers: the pull needs a rebase (or a merge) instead.
export const diverged = (err) => /not possible to fast-forward|diverg|fast-forward/i.test(err ?? "");

// What a branch switch would do with the working tree's files: tracked changes (staged or not)
// come along or block it, conflicts must be resolved first, untracked files stay in the folder.
export function switchRisk(files) {
  const f = files ?? [];
  return { tracked: f.filter((x) => x.kind !== "untracked" && x.kind !== "conflict"), conflicts: f.filter((x) => x.kind === "conflict"), untracked: f.filter((x) => x.kind === "untracked").length };
}
export const stashMessage = (from, to) => `herdr-ranch: ${from ?? "detached"} before switching to ${to}`;

// `git log --format=%h%x09%s%x09%an%x09%ct` lines as [{ hash, subject, author, at }].
export function parseCommits(text) {
  return (text ?? "").split("\n").filter(Boolean).map((l) => { const [hash, subject, author, at] = l.split("\t"); return { hash, subject: subject ?? "", author: author ?? "", at: Number(at) || 0 }; });
}

// The commits on HEAD that no remote has, newest first (at most `max`); [] without a remote.
export async function notPushed(top, on, max = 30) {
  const remote = await exec("git", ["remote"], { cwd: top, on });
  if (remote.code !== 0 || !remote.stdout.trim()) return [];
  const r = await exec("git", ["log", `-n${max}`, "--format=%h%x09%s%x09%an%x09%ct", "HEAD", "--not", "--remotes"], { cwd: top, on });
  return r.code === 0 ? parseCommits(r.stdout) : [];
}
