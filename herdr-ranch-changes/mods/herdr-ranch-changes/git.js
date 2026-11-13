// Git for the Changes panel: the working tree's changes against HEAD (staged and not), with
// new files as additions, in the diff view's shape (diff.js). Reads write nothing under .git
// (no index refresh, no lock, no fsmonitor cookie): the folder watch would see it and refresh
// again. Runs on the space's machine.

import { exec, readTextFile } from "herdr";
import { prepareFile, parseShow } from "./diff.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const MAX_FILES = 300, NEW_LINES = 1500;

async function git(args, where, timeout = 20000) {
  const r = await exec("git", [...READ, ...args], { cwd: where.cwd, on: where.on ?? undefined, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `git ${args[0]} failed`);
  return r.stdout;
}

// The repository of a folder: { root, branch, on }, or null outside one.
export async function repoOf(cwd, on) {
  const out = await git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { cwd, on }).catch(() => null)
    ?? await git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (!out) return null;
  const [root, branch] = out.trim().split("\n");
  return root ? { root, branch: branch && branch !== "HEAD" ? branch : null, on: on ?? null } : null;
}

// `git status --porcelain=v1 -z` → [{ path, staged, unstaged, fresh, conflict }].
export function parseStatus(out) {
  return out.split("\0").filter(Boolean).map((e) => {
    const x = e[0], y = e[1], path = e.slice(3);
    return { path, fresh: x === "?", staged: x !== " " && x !== "?", unstaged: y !== " " && y !== "?", conflict: x === "U" || y === "U" || (x === y && (x === "A" || x === "D")) };
  });
}

// A new file's text as an all-added patch, as GitHub's API gives one.
export function addedPatch(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  return { patch: `@@ -0,0 +1,${lines.length} @@\n${lines.slice(0, NEW_LINES).map((l) => `+${l}`).join("\n")}`, additions: lines.length };
}

// The changes: { head (a commit exists), files (prepared, each with its status entry), limited }.
export async function changes(repo) {
  const where = { cwd: repo.root, on: repo.on };
  const status = parseStatus(await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], where));
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], where).then(() => true, () => false);
  const diff = await git(["diff", head ? "HEAD" : EMPTY_TREE, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"], where, 60000);
  const byPath = new Map(parseShow(diff).map((f) => [f.filename, f]));
  const files = [];
  for (const s of status.slice(0, MAX_FILES)) {
    let raw = byPath.get(s.path);
    if (!raw && s.fresh) {
      const text = await readTextFile(`${repo.root}/${s.path}`, { on: repo.on }).catch(() => null);
      raw = text == null || text.includes("\0")
        ? { filename: s.path, status: "added", additions: 0, deletions: 0, changes: 0, patch: null }
        : { filename: s.path, status: "added", deletions: 0, ...addedPatch(text) };
    }
    if (!raw) continue; // a staged change undone in the work tree: nothing against HEAD
    files.push({ ...prepareFile(raw), staged: s.staged, unstaged: s.unstaged, fresh: s.fresh, conflict: s.conflict });
  }
  return { head, files, limited: status.length > MAX_FILES };
}

// Commits everything, as Herdr's own Changes panel does: `git add -A`, then `git commit -m`.
export async function commitAll(repo, message) {
  const where = { cwd: repo.root, on: repo.on };
  for (const args of [["add", "-A"], ["commit", "-m", message]]) {
    const r = await exec("git", args, { cwd: where.cwd, on: where.on ?? undefined, timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(0, 3).join(" ") || `git ${args[0]} failed`);
  }
}
