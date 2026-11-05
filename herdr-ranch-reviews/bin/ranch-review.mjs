#!/usr/bin/env node
// ranch-review: ask for a review in Herdr, wait for it, print the feedback.
//   ranch-review annotate <file.md> [--json]   a Markdown file
//   ranch-review last [--stdin] [--json]       the agent's last message (or the text on stdin)
// Run it from an agent in a Herdr app terminal. It writes the review to
// ~/.config/herdr-app/data/herdr-ranch-reviews/<id>.json, opens the Reviews mod beside the
// agent's pane, and waits until the review is sent, approved or dismissed. The output is the
// same as `plannotator annotate` and `plannotator last`: the feedback, "The user approved.", or
// nothing. Exit codes: 0 done, 2 can't start a review, 130 stopped (the review is then closed
// as abandoned).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MOD, MAX_TEXT, MAX_BYTES, KEEP_DAYS, newId, outcomeText, lastClaudeText, lastCodexText, docKey, splitBlocks, carryDraft, abandon, orphaned } from "../mods/herdr-ranch-reviews/reviews.js";

const HOME = os.homedir();
const APP = process.env.HERDR_APP_HOME || path.join(HOME, ".config", "herdr-app");
const DIR = path.join(APP, "data", MOD);
const POLL = 400;

const fail = (msg) => { process.stderr.write(`ranch-review: ${msg}\n`); process.exit(2); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });

function herdrApp(args) {
  for (const bin of ["herdr-app", path.join(HOME, ".local", "bin", "herdr-app")]) {
    try { return run(bin, args); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  throw new Error("herdr-app isn't installed");
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Changes a review the mod may write too: only when the file still holds what `change` was given
// (the mod writes compare-and-swap; this keeps the CLI from undoing its last write).
function updateReview(file, change) {
  for (let i = 0; i < 5; i++) {
    let raw; try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
    let r; try { r = JSON.parse(raw); } catch { continue; }
    const next = change(r);
    if (!next) return r;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    let now = null; try { now = fs.readFileSync(file, "utf8"); } catch { /* gone */ }
    if (now === raw) { fs.renameSync(tmp, file); return next; }
    fs.rmSync(tmp, { force: true });
  }
  return null;
}
const readReview = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// The agent's pane: HC_TERMINAL_ID names its terminal, `herdr-app ls` its pane and app.
// The repository a folder belongs to (git's common dir, the same for all its worktrees), so the
// list can show a worktree's reviews in the space of its main checkout.
function repoOf(dir) {
  try { return run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim() || null; } catch { return null; }
}

// The agent's terminal device: the first process up from here that has one (the skill's command
// itself runs without). Writing a status report there is the agent reporting it.
function agentTty() {
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    let line = "";
    try { line = run("ps", ["-o", "ppid=,tty=", "-p", String(pid)]).trim(); } catch { return null; }
    const [ppid, tty] = line.split(/\s+/);
    if (tty && tty !== "??" && tty !== "-") return `/dev/${tty.startsWith("tty") ? tty : `tty${tty}`}`;
    pid = Number(ppid);
  }
  return null;
}

// The agent's status in Herdr (OSC 7501, as Claude Code reports its own): "blocked" puts it under
// Needs you in the Agents panel while the review waits; "working" once the answer is in. Best
// effort: without a terminal device, nothing changes.
function reportStatus(tty, app, state, msg = null) {
  if (!tty) return;
  const parts = [`state=${state}`, ...(app ? [`app=${app}`] : [])];
  if (state === "blocked") parts.push("kind=question");
  if (msg) parts.push(`msg=${Buffer.from(msg).toString("base64")}`);
  try { fs.writeFileSync(tty, `\x1b]7501;${parts.join(":")}\x07`); } catch { /* not ours to write */ }
}

function agentPane() {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) fail("run this inside a Herdr terminal, from the agent that asks for the review (HC_TERMINAL_ID isn't set).");
  let ls;
  try { ls = JSON.parse(herdrApp(["ls"])); } catch (e) { fail(`can't ask Herdr for the panes: ${e.message}`); }
  for (const space of ls?.spaces ?? []) for (const tab of space.tabs ?? []) for (const t of tab.terminals ?? []) {
    if (t.terminal === terminal) return { terminal, pane: t.pane ?? null, app: t.app ?? null, space: space.id, tab: tab.id };
  }
  // `ls` can answer null (seen 2026-11-02 with the window open): fall back to what the window
  // shows, so the review opens beside the focused pane; delivery only needs the terminal.
  // The app from herdr-core; the space and tab are filled in by the mod (Herdr's agents()).
  let st = null, app = null;
  try { st = JSON.parse(herdrApp(["status"])); } catch { /* the window is closed */ }
  try { app = JSON.parse(run("hc", ["ls", "--json"])).terminals?.find((t) => t.address === terminal)?.agent ?? null; } catch { /* no hc */ }
  return { terminal, pane: st?.focused_pane ?? null, app, space: null, tab: null };
}

// --- The last message ------------------------------------------------------------------------

const parentOf = (pid) => { try { return Number(run("ps", ["-o", "ppid=", "-p", String(pid)]).trim()) || 0; } catch { return 0; } };

function claudeSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  // Like Plannotator: the nearest ancestor with ~/.claude/sessions/<pid>.json.
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 32; pid = parentOf(pid), hops++) {
    try { return JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "sessions", `${pid}.json`), "utf8")).sessionId; } catch { /* not this one */ }
  }
  return null;
}

function claudeTranscript() {
  const id = claudeSessionId(), root = path.join(HOME, ".claude", "projects");
  if (id) {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, dir.name, `${id}.jsonl`);
      if (dir.isDirectory() && fs.existsSync(file)) return file;
    }
  }
  // Else the newest transcript of this folder (its slug: every other character becomes "-").
  const slugDir = path.join(root, process.cwd().replace(/[^a-zA-Z0-9-]/g, "-"));
  try {
    return fs.readdirSync(slugDir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(slugDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}

// Codex: the newest rollout log of this folder, its last assistant message (unverified on
// this machine: Codex isn't installed here).
function codexLastMessage() {
  const root = path.join(HOME, ".codex", "sessions");
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push(p); } };
  try { walk(root); } catch { return null; }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files.slice(0, 20)) {
    const { cwd, text } = lastCodexText(fs.readFileSync(file, "utf8").split("\n"));
    if (cwd && path.resolve(cwd) !== process.cwd()) continue;
    if (text) return text;
  }
  return null;
}

function lastMessage(app) {
  const claude = app === "claude-code" || process.env.CLAUDECODE === "1" || Boolean(process.env.CLAUDE_CODE_SESSION_ID);
  if (claude) {
    const file = claudeTranscript();
    if (!file) fail("can't find this Claude Code session's transcript.");
    return lastClaudeText(fs.readFileSync(file, "utf8").split("\n")) ?? fail("the transcript has no assistant message with text yet.");
  }
  if (app === "codex" || process.env.CODEX_THREAD_ID) return codexLastMessage() ?? fail("can't find Codex's last message; pipe it in: ranch-review last --stdin");
  return fail(`can't read the last message of ${app ?? "this agent"}; pipe it in: ranch-review last --stdin`);
}

// --- Main ------------------------------------------------------------------------------------

// Whether a process runs: EPERM means it does (another user's); ESRCH that it is gone.
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function prune() {
  const old = Date.now() - KEEP_DAYS * 86400000;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(DIR, f), r = readReview(file);
    if (r && r.status !== "open" && Date.parse(r.createdAt) < old) fs.rmSync(file, { force: true });
    // Open, but its `ranch-review` is gone (killed, or its session ended without a signal):
    // nobody will read the answer, so it is closed as abandoned.
    else if (orphaned(r, isAlive)) updateReview(file, (x) => (orphaned(x, isAlive) ? abandon(x) : null));
  }
  // Screenshots pasted into comments: kept as long as reviews, since the agent may open them later.
  const img = path.join(DIR, "img");
  for (const f of fs.existsSync(img) ? fs.readdirSync(img) : []) {
    if (fs.statSync(path.join(img, f)).mtimeMs < old) fs.rmSync(path.join(img, f), { force: true });
  }
}

// The newest review of a document that you sent feedback on (status "sent"), or null.
function lastSent(key) {
  let best = null;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const r = readReview(path.join(DIR, f));
    if (r?.status === "sent" && typeof r.text === "string" && docKey(r) === key && (!best || r.id > best.id)) best = r;
  }
  return best;
}

const HELP = `ranch-review: ask for a review in Herdr, and wait for the answer.

  ranch-review annotate <file.md>   review a Markdown file
  ranch-review last                 review the agent's last answer (Claude Code, Codex)
  ranch-review last --stdin         review the text on stdin (any agent)
  --json                            print {"decision", "feedback", "annotationCount"}

The review opens in Herdr's Reviews mod. This command waits until you send, approve or
discard it, then prints the feedback, "The user approved.", or nothing (discarded).
Run it in a Herdr terminal. Exit: 0 answered, 2 couldn't start, 130 stopped (the
review is then closed as abandoned).
A file reviewed again after you sent feedback on it shows what changed since then.
`;

async function main() {
  const args = process.argv.slice(2), json = args.includes("--json"), stdin = args.includes("--stdin");
  const [cmd, target] = args.filter((a) => !a.startsWith("--"));
  if (cmd === "help" || args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return 0; }
  if (!cmd) { process.stderr.write(HELP); return 2; }
  if (cmd !== "annotate" && cmd !== "last") fail(`unknown command ${cmd}; see ranch-review --help`);
  const known = cmd === "last" ? ["--json", "--stdin"] : ["--json"];
  const odd = args.filter((a) => a.startsWith("-") && !known.includes(a));
  if (odd.length) fail(`${cmd} doesn't take ${odd.join(" ")}; see ranch-review --help`);
  const agent = agentPane();
  let text, file = null, title;
  if (cmd === "annotate") {
    if (!target) fail("name a Markdown file: ranch-review annotate <file.md>");
    // Claude Code's file picker inserts `@path`; a slash command passes that through verbatim.
    const named = target.startsWith("@") && !fs.existsSync(target) ? target.slice(1) : target;
    file = path.resolve(named);
    try { text = fs.readFileSync(file, "utf8"); } catch { fail(`can't read ${target}: give the path of a Markdown file.`); }
    title = path.basename(file);
  } else {
    text = stdin ? fs.readFileSync(0, "utf8") : lastMessage(agent.app);
    title = "Last message";
  }
  if (!text.trim()) fail("there is nothing to review: the text is empty.");
  if (text.length > MAX_TEXT) fail(`the text is too long to review (${text.length} characters, at most ${MAX_TEXT}).`);

  fs.mkdirSync(DIR, { recursive: true });
  try { prune(); } catch { /* best effort */ }
  const id = newId(), where = path.join(DIR, `${id}.json`);
  const review = {
    id, kind: cmd === "last" ? "last" : "file", title, path: file, cwd: process.cwd(), repo: repoOf(process.cwd()), text,
    agent, status: "open", createdAt: new Date().toISOString(), waiting: { pid: process.pid },   };
  // One review per document: an open review of the same file (or this agent's last message) is
  // replaced by this one, which takes over its unsent comments.
  const older = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const r = readReview(path.join(DIR, f));
    if (r?.status === "open" && docKey(r) === docKey(review)) older.push(r);
  }
  older.sort((a, b) => (a.id < b.id ? 1 : -1));
  const draft = older.find((r) => r.draft?.length)?.draft;
  if (draft) review.draft = carryDraft(draft, splitBlocks(text));
  // Reviewed before, and you sent feedback on it: the text you saw then, so the mod can show what
  // changed (new and changed blocks; the rest folded). Left out when it would make the file too big.
  if (review.kind === "file") {
    const sent = lastSent(docKey(review));
    if (sent) {
      review.base = { id: sent.id, text: sent.text, sentAt: sent.finishedAt ?? sent.createdAt };
      if (Buffer.byteLength(JSON.stringify(review, null, 2)) > MAX_BYTES) delete review.base;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(review, null, 2));
  if (bytes > MAX_BYTES) fail(`the text is too big to review (${Math.round(bytes / 1024)} KB as a review file, at most ${MAX_BYTES / 1024} KB).`);
  const tty = agentTty();
  // Stopped (the agent's call timed out or was stopped, Ctrl+C, the session ended): nobody will
  // read the answer, so the review is closed as abandoned and leaves the list; the agent stops
  // showing under Needs you.
  const stop = () => {
    updateReview(where, (r) => abandon(r));
    reportStatus(tty, agent.app, "idle");
    process.exit(130);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, stop);
  // (Set before the file exists, so a signal right after it is written still closes it.)
  writeAtomic(where, review);
  for (const r of older) {
    updateReview(path.join(DIR, `${r.id}.json`), (x) => (x.status === "open"
      ? { ...x, status: "dismissed", supersededBy: { id, terminal: agent.terminal ?? null }, draft: null, finishedAt: new Date().toISOString(), result: { decision: "dismissed", comments: [] } }
      : null));
  }
  reportStatus(tty, agent.app, "blocked", `Review ${title} in Herdr`);

  // The mod's watcher (an invisible copy in the mod-buttons layout) sees the new file and shows
  // the toast. Without a live watcher (its heartbeat is older than a minute), a launcher pane
  // beside the agent wakes the mod instead, for a moment.
  let watched = false;
  try { watched = Date.now() - fs.statSync(path.join(DIR, ".watcher")).mtimeMs < 60000; } catch { /* no watcher */ }
  if (!watched) {
    const props = { launch: id };
    const split = agent.pane ? { direction: "right", pane: agent.pane, mod: MOD, props } : { direction: "right", mod: MOD, props };
    try { herdrApp(["do", "pane.split", JSON.stringify(split)]); }
    catch (e) { process.stderr.write(`ranch-review: couldn't open the review beside the agent (${e.message.trim()}); open it from Reviews.\n`); }
  }

  for (;;) {
    // The answer arrives as a change to the file: wake on it at once, or after POLL at the latest.
    await new Promise((resolve) => {
      let w = null;
      const done = () => { clearTimeout(t); try { w?.close(); } catch { /* closed */ } resolve(); };
      const t = setTimeout(done, POLL);
      try { w = fs.watch(DIR, (_e, name) => { if (!name || String(name).startsWith(id)) done(); }); } catch { /* polling only */ }
    });
    const r = readReview(where);
    // Unreadable while the mod writes it: read again. Gone: removed from the list (discarded).
    if (!r && fs.existsSync(where)) continue;
    if (!r) { process.stdout.write(json ? `${JSON.stringify({ decision: "dismissed" })}\n` : ""); reportStatus(tty, agent.app, "working"); return 0; }
    if (r.status === "open") continue;
    // Replaced by a newer review of the same document: this one ends with no answer. Its agent's
    // status stays as the newer review set it when that review is for the same agent.
    if (r.supersededBy) {
      fs.rmSync(where, { force: true });
      process.stdout.write(json ? `${JSON.stringify({ decision: "superseded", by: r.supersededBy.id })}\n` : "A newer review of the same document replaced this one.\n");
      if (r.supersededBy.terminal !== agent.terminal) reportStatus(tty, agent.app, "working");
      return 0;
    }
    // Approved and dismissed reviews are done with: removed. Sent feedback stays in Reviews for a week.
    if (r.status === "approved" || r.status === "dismissed") fs.rmSync(where, { force: true });
    else updateReview(where, (x) => ({ ...x, delivery: "cli", deliveredAt: new Date().toISOString(), waiting: null }));
    const out = outcomeText(r, json);
    if (out) process.stdout.write(`${out}\n`);
    reportStatus(tty, agent.app, "working"); // the agent goes on with the answer
    return 0;
  }
}

main().then((code) => process.exit(code ?? 0), (e) => fail(e?.message ?? String(e)));
