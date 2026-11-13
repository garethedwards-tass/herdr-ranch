// Git for the History panel: the log, and one commit's files from `git show`, in the shape
// the diff view reads (diff.js prepareFile). Runs on the space's machine.

import { exec } from "herdr";
import { prepareFile, parseShow } from "./diff.js";

export const LOG = 300;
const US = "\x1f", RS = "\x1e";

async function git(args, where, timeout = 20000) {
  const r = await exec("git", args, { cwd: where.cwd, on: where.on ?? undefined, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `git ${args[0]} failed`);
  return r.stdout;
}

// The repository of a folder: its top level and current branch, or null outside one.
export async function repoOf(cwd, on) {
  try {
    const out = await git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { cwd, on });
    const [top, branch] = out.trim().split("\n");
    return top ? { top, branch: branch === "HEAD" ? null : branch, on: on ?? null } : null;
  } catch { return null; }
}

// What HEAD (and with `all`, every branch) points at now: a cheap check before reloading.
export async function tip(repo, all) {
  const args = all ? ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"] : ["rev-parse", "HEAD"];
  return (await git(args, { cwd: repo.top, on: repo.on }).catch(() => "")).trim();
}

// The last LOG commits: of HEAD, or of every branch with `all`, newest first.
export async function log(repo, all) {
  const args = ["log", `--max-count=${LOG}`, "--date=iso-strict", "--no-color", `--format=%H${US}%h${US}%an${US}%ad${US}%P${US}%D${US}%s${RS}`, ...(all ? ["--all"] : [])];
  return parseLog(await git(args, { cwd: repo.top, on: repo.on }));
}

export function parseLog(out) {
  return out.split(RS).map((r) => r.replace(/^\n/, "")).filter((r) => r.trim()).map((r) => {
    const [sha, short, author, at, parents, refs, title] = r.split(US);
    return {
      sha, short, author, at, title: (title ?? "").trim(), merge: (parents ?? "").trim().split(" ").filter(Boolean).length > 1,
      refs: (refs ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^HEAD -> /, "")).filter((x) => x !== "HEAD"),
    };
  });
}

// One commit: its full message, and its files with patches (renames found, merges against
// their first parent, as GitHub shows them).
export async function show(repo, sha) {
  const where = { cwd: repo.top, on: repo.on };
  const [msg, patch] = await Promise.all([
    git(["show", "-s", "--format=%B", sha], where),
    git(["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "-M", "--first-parent", "--diff-merges=first-parent", sha], where),
  ]);
  return { body: msg.trim().split("\n").slice(1).join("\n").trim(), files: parseShow(patch).map(prepareFile) };
}

// A search query → git log arguments. Plain words match the message or the author (two
// searches, merged: git ANDs --grep with --author), case-insensitive, as fixed text. Prefixes narrow it:
//   author:ann   message:fix   path:login.cfc (a file or folder, any depth)
//   code:getUser (commits that add or remove that text, git log -S; slower)
//   since:2.weeks   until:2026-10-01   a sha prefix (4 to 40 hex digits) finds that commit.
export function searchArgs(query) {
  const args = [], words = [], paths = [];
  let sha = null;
  for (const tok of query.match(/\S+:"[^"]*"|"[^"]*"|\S+/g) ?? []) {
    const m = /^(author|message|msg|path|file|code|since|after|until|before):(.+)$/i.exec(tok);
    const val = (m ? m[2] : tok).replace(/^"|"$/g, "");
    if (!val) continue;
    const key = m?.[1].toLowerCase();
    if (key === "author") args.push(`--author=${val}`);
    else if (key === "message" || key === "msg") args.push(`--grep=${val}`);
    else if (key === "path" || key === "file") paths.push(`:(icase,glob)**/*${val}*`, `:(icase,glob)**/*${val}*/**`);
    else if (key === "code") args.push(`-S${val}`);
    else if (key === "since" || key === "after") args.push(`--since=${val}`);
    else if (key === "until" || key === "before") args.push(`--until=${val}`);
    else if (/^[0-9a-f]{4,40}$/i.test(val) && !m) sha = val;
    else words.push(val);
  }
  return { args: ["-i", "-F", ...args], words: words.join(" "), paths, sha };
}

// The whole history (of HEAD, or every branch with `all`) searched by git, newest first.
// `code:` reads every commit's diff, so a search may take a minute.
export async function search(repo, query, all) {
  const { args, words, paths, sha } = searchArgs(query);
  const where = { cwd: repo.top, on: repo.on };
  const fmt = [`--max-count=${LOG}`, "--date=iso-strict", "--no-color", `--format=%H${US}%h${US}%an${US}%ad${US}%P${US}%D${US}%s${RS}`];
  const run = (extra) => git(["log", ...fmt, ...args, ...extra, ...(all ? ["--all"] : []), ...(paths.length ? ["--", ...paths] : [])], where, 60000).then(parseLog);
  const searches = words ? [run([`--grep=${words}`]), run([`--author=${words}`])] : sha && args.length === 2 && !paths.length ? [] : [run([])];
  const [exact, ...found] = await Promise.all([
    sha ? git(["log", ...fmt, "-1", sha, "--"], where).then(parseLog).catch(() => []) : [],
    ...searches,
  ]);
  const seen = new Set(exact.map((c) => c.sha));
  const rest = found.flat().filter((c) => !seen.has(c.sha) && seen.add(c.sha)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return [...exact, ...rest].slice(0, LOG);
}

// The name git signs commits with here (for the Mine filter), or null.
export async function me(repo) {
  return (await git(["config", "user.name"], { cwd: repo.top, on: repo.on }).catch(() => "")).trim() || null;
}
