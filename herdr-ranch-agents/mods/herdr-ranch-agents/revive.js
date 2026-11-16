// Bringing back a Claude Code agent that stopped reporting its status to Herdr (OSC 7501): it
// still runs, but Herdr's own lists and next/previous agent skip it. A fresh start reports again.
// Claude Code runs sessions in the background (`/exit` only detaches), so: `/stop` (ends the
// session, keeps the conversation), quit the session list back to the pane's shell, then a small
// script runs `claude --continue` with the session's account folder and model.
//
// It's driven with `hc keys`, which types only unshifted keys and shift+letter (no $ ~ ( ) _), so
// the shell is given `sh <script>`, a path made of typable characters. `hc send` would wrap the
// text in <hc> tags. Every step reads the screen first and stops at anything unexpected: an unsent
// message, a running background agent, a menu that isn't Claude Code's /stop.

import { hc, appHome, writeTextFile, readTextFile, exec, shared, notify } from "herdr";

// Keys that type `text`, or null when a character can't be typed.
export function keysFor(text) {
  const out = [];
  for (const c of text) {
    if (c === " ") out.push("space");
    else if (/[A-Z]/.test(c)) out.push(`shift+${c.toLowerCase()}`);
    else if (/[a-z0-9/.=-]/.test(c)) out.push(c);
    else return null;
  }
  return out;
}

// The prompt line's text (after "❯ "), from the bottom of a screen; null when none shows.
export function promptText(screen) {
  const lines = (screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^❯ ?(.*)$/.exec(lines[i]);
    if (m) return m[1].trimEnd();
  }
  return null;
}

// Whether a background agent of the session is still running (the status bar's "← 2 agents").
export const runningAgents = (screen) => /← \d+ agents?\b/.test((screen ?? "").split("\n").slice(-4).join("\n"));

// Whether a Claude Code title says it's working: a leading glyph that isn't its idle ✳.
export const busyTitle = (title) => { const c = [...(title ?? "").trim()][0]; return Boolean(c) && !/[\p{L}\p{N}✳]/u.test(c); };

// Whether the slash menu's highlighted entry is Claude Code's /stop for a background session.
export const stopOffered = (screen) => /^\s*❯ \/stop\s+Stop this background session/m.test(screen ?? "");

// The model a session was started with (`--model x`), if any.
export function modelOf(argv) {
  const i = (argv ?? []).indexOf("--model");
  return i > 0 && argv[i + 1] && /^[\w.[\]-]+$/.test(argv[i + 1]) ? argv[i + 1] : null;
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The script that resumes the session: its account's Claude Code folder and GitHub login (the token
// is fetched inside, never written down), then `claude --continue`.
export function scriptFor({ configDir = null, ghUser = null, model = null } = {}) {
  return [
    "# herdr-ranch: resume a Claude Code session that stopped reporting its status (written by the Agents list)",
    configDir ? `export CLAUDE_CONFIG_DIR=${q(configDir)}` : "",
    ghUser ? `GH_TOKEN=$(gh auth token --user ${q(ghUser)} 2>/dev/null) && export GH_TOKEN` : "",
    `exec claude --continue${model ? ` --model ${q(model)}` : ""}`,
    "",
  ].filter((l, i, all) => l || i === all.length - 1).join("\n");
}

// The running program's CLAUDE_CONFIG_DIR (`ps eww`), if it has one.
async function configDirOf(pid) {
  const r = await exec("ps", ["eww", "-o", "command=", "-p", String(pid)]).catch(() => null);
  const m = /(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/.exec(r?.stdout ?? "");
  return m ? m[1] : null;
}

const get = async (t) => { const r = await hc(["get", t, "--json"]); return r.code === 0 ? JSON.parse(r.stdout) : null; };
const read = async (t) => (await hc(["read", t])).stdout ?? "";
const keys = (t, ks) => hc(["keys", t, ...ks]);

// Brings back terminal `t` (an address on this computer). Resolves to null when done, else why not.
export async function revive(t, cx) {
  const say = (why) => why;
  let g = await get(t);
  const fg = g?.foreground;
  if (!fg || !/claude/.test(fg.argv?.[0] ?? "")) return say("Claude Code isn't in front in that terminal.");
  if (g.status) return null; // reporting again already
  // Claude Code's title starts with ✳ when it waits, a spinner glyph while it works.
  if (busyTitle(g.title)) return say("It looks busy (its title shows a spinner): try again when it's done.");
  let screen = await read(t);
  if (runningAgents(screen)) return say("A background agent of that session is still running: try again when it's done.");
  // A typed draft stays when a key is added; Claude Code's suggested reply is replaced.
  await keys(t, ["x"]);
  const typed = promptText(await read(t));
  await keys(t, ["backspace"]);
  if (typed !== "x") return say("It has an unsent message in its prompt: send or clear it first.");
  await keys(t, keysFor("/stop"));
  await cx.sleep(400);
  if (!stopOffered(await read(t))) { await keys(t, ["esc", "ctrl+u"]); return say("That Claude Code doesn't offer /stop: restart it by hand."); }
  // What to start again with, read before it stops.
  const configDir = await configDirOf(fg.pid);
  const account = (shared("ranch-accounts")?.accounts ?? []).find((a) => a.claudeDir && configDir && configDir.endsWith(a.claudeDir.replace(/^~/, "")));
  const script = scriptFor({ configDir, ghUser: account?.ghUser ?? null, model: modelOf(fg.argv) });
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) { await keys(t, ["esc", "ctrl+u"]); return say("The script's path can't be typed into the terminal."); }
  await exec("mkdir", ["-p", dir]).catch(() => null);
  await writeTextFile(path, script, await readTextFile(path).catch(() => null));
  await keys(t, ["enter"]);
  // /stop leaves Claude Code's session list in front: ctrl+c twice quits it.
  for (let i = 0; i < 20; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (!/claude/.test(g?.foreground?.argv?.[0] ?? "")) break;
    if (i === 3) { await keys(t, ["ctrl+c"]); await keys(t, ["ctrl+c"]); }
  }
  if (/claude/.test(g?.foreground?.argv?.[0] ?? "")) return say("Claude Code didn't stop: check the terminal.");
  await keys(t, [...line, "enter"]);
  for (let i = 0; i < 40; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (g?.status) return null;
  }
  return say("Claude Code started again but isn't reporting yet: check the terminal.");
}

// The click: runs revive() once per terminal, and says how it went.
export function bringBack(v, a, cx) {
  if (v.reviving.has(a.address)) return;
  v.reviving.add(a.address);
  cx.notify();
  cx.spawn(async (cx) => {
    let why;
    try { why = await revive(a.address, cx); } catch (e) { why = String(e?.message ?? e); }
    v.reviving.delete(a.address);
    notify(why ? { title: `Couldn't bring back ${a.space_name}`, body: why, level: "warning" } : { title: `${a.space_name} is reporting again`, level: "success", timeout: 3000 });
    cx.notify();
  });
}
