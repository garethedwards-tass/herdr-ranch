// Bringing back a Claude Code agent that stopped reporting its status to Herdr (OSC 7501): it
// still runs, but Herdr's own lists and next/previous agent skip it. A fresh start reports again.
// Claude Code runs sessions in the background (`/exit` only detaches), so: `/stop` (ends the
// session, keeps the conversation), quit the session list back to the pane's shell, then a small
// script starts Claude Code again the way the terminal first did (the same account setup and
// flags) with `--resume <its session id>`, so it reopens this conversation and no other.
//
// It's driven with `hc keys`, which types only unshifted keys and shift+letter (no $ ~ ( ) _), so
// the shell is given `sh <script>`, a path made of typable characters. `hc send` would wrap the
// text in <hc> tags. Everything that can fail without touching the terminal (reading how it was
// started, writing the script) happens first; then every step reads the screen and stops at
// anything unexpected: busy, an unsent message, a running background agent, a menu that isn't
// Claude Code's /stop.

import { hc, appHome, writeTextFile, readTextFile, exec, notify } from "herdr";

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

const bottom = (screen, n = 5) => (screen ?? "").split("\n").slice(-n).join("\n");

// Whether a background agent of the session is still running (the status bar's "← 2 agents").
export const runningAgents = (screen) => /← \d+ agents?\b/.test(bottom(screen));

// Whether Claude Code is working: "esc to interrupt" in its status bar, or a spinner glyph leading
// its title (✳ when it waits). Either one is enough to leave it alone.
export const busyTitle = (title) => { const c = [...(title ?? "").trim()][0]; return Boolean(c) && !/[\p{L}\p{N}✳]/u.test(c); };
export const busyScreen = (screen) => /esc to interrupt/i.test(bottom(screen, 8));

// Vim mode's normal mode: a typed key would edit the draft instead of adding to it.
export const vimNormal = (screen) => /-- NORMAL --/.test(bottom(screen, 8));

// Whether the slash menu's highlighted entry is Claude Code's /stop for a background session.
export const stopOffered = (screen) => /^\s*❯ \/stop\s+Stop this background session/m.test(screen ?? "");

// Claude Code's options that take a value (`--model opus`); the others stand alone.
const VALUED = new Set(["--model", "--effort", "--permission-mode", "--add-dir", "--settings", "--mcp-config", "--agent", "--agents",
  "--append-system-prompt", "--system-prompt", "--fallback-model", "--allowedTools", "--allowed-tools", "--disallowedTools",
  "--disallowed-tools", "--name", "--output-format", "--input-format", "--plugin-dir", "--betas", "--setting-sources", "--session-id", "--resume", "-r"]);
const SESSION = new Set(["--continue", "-c", "--resume", "-r", "--session-id"]);

// Claude Code's arguments to start it again: its options as given (`--model=x` included), without
// its first prompt or any session choice; then `--resume <id>`.
export function resumeArgs(args, id) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i], name = a.split("=")[0];
    if (!a.startsWith("-")) continue; // a prompt (options' values are taken with their option)
    const valued = VALUED.has(name) && !a.includes("=") && i + 1 < args.length;
    if (SESSION.has(name)) { if (valued) i++; continue; }
    out.push(a);
    if (valued) out.push(args[++i]);
  }
  return [...out, "--resume", id];
}

// How the terminal started Claude Code: the account setup Herdr Ranch put before it (`export
// CLAUDE_CONFIG_DIR=…; GH_TOKEN=$(gh auth token …) …`, from shared/accounts.js), and Claude Code's own
// arguments. null when its command isn't one of those shapes: then it's restarted by hand.
const SETUP = /^(export CLAUDE_CONFIG_DIR=('[^']*'|"\$HOME"'[^']*')|GH_TOKEN=\$\(gh auth token --user '[A-Za-z0-9-]+' 2>\/dev\/null\) && export GH_TOKEN \|\| echo '[^']*' >&2)$/;
export function launchOf(argv) {
  const at = argv.findIndex((x) => x === "claude" || /\/claude$/.test(x));
  if (at < 0) return null;
  let setup = "";
  const c = argv.lastIndexOf("-c", at);
  if (c > 0 && argv[c - 1] === "sh" && c + 1 < at) {
    // runAs: sh -c '<setup>; exec "$@"' sh claude …
    const m = /^(.*); exec "\$@"$/.exec(argv[c + 1]);
    if (!m) return null;
    setup = m[1];
  }
  if (setup && !setup.split("; ").every((part) => SETUP.test(part))) return null;
  return { setup, args: argv.slice(at + 1) };
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function scriptFor(setup, args) {
  return [
    "# herdr-ranch: resume a Claude Code session that stopped reporting its status (written by the Agents list)",
    ...(setup ? [setup] : []),
    `exec claude ${args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

const get = async (t) => { const r = await hc(["get", t, "--json"]).catch(() => null); try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
const read = async (t) => (await hc(["read", t]).catch(() => null))?.stdout ?? "";
const keys = (t, ks) => hc(["keys", t, ...ks]);
const isClaude = (g) => /(^|\/)claude$/.test(g?.foreground?.argv?.[0] ?? "");

// Brings back terminal `t` (an address on this computer) to session `id`. Resolves to null when
// done, else why not.
export async function revive(t, id, cx) {
  let g = await get(t);
  if (!g || !isClaude(g)) return "Claude Code isn't in front in that terminal.";
  if (g.status) return null; // reporting again already
  if (!id || !/^[\w-]+$/.test(id)) return "Couldn't tell which conversation it is: restart it by hand.";
  // The terminal's own command, else (Claude Code typed into its shell) the program's.
  const launch = launchOf(g.argv ?? []) ?? launchOf(g.foreground.argv ?? []);
  if (!launch) return "It wasn't started in a way this can repeat: restart it by hand.";
  // An account setting its launch doesn't make came from elsewhere: don't guess the account.
  const env = (await exec("ps", ["eww", "-o", "command=", "-p", String(g.foreground.pid)]).catch(() => null))?.stdout ?? "";
  for (const k of ["CLAUDE_CONFIG_DIR", "GH_TOKEN"]) {
    if (new RegExp(`(^|\\s)${k}=`).test(env) && !launch.setup.includes(k)) return `It runs with its own ${k}: restart it by hand.`;
  }
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return "The script's path can't be typed into the terminal.";
  const args = resumeArgs(launch.args, id);
  if (!args.every((a) => !/[\n\r]/.test(a))) return "Its arguments can't go in a script line: restart it by hand.";
  await exec("mkdir", ["-p", dir]);
  await writeTextFile(path, scriptFor(launch.setup, args), await readTextFile(path).catch(() => null));

  // From here on the terminal is touched: look before each key.
  let screen = await read(t);
  if (busyTitle(g.title) || busyScreen(screen)) return "It looks busy: try again when it's done.";
  if (runningAgents(screen)) return "A background agent of that session is still running: try again when it's done.";
  if (vimNormal(screen)) return "Its prompt is in vim normal mode: press i there, then try again.";
  // A typed draft stays when a key is added; Claude Code's suggested reply is replaced.
  await keys(t, ["x"]);
  let typed = null;
  for (let i = 0; i < 6 && typed !== "x"; i++) { await cx.sleep(150); typed = promptText(await read(t)); }
  await keys(t, ["backspace"]);
  if (typed !== "x") return "It has an unsent message in its prompt: send or clear it first.";
  await keys(t, keysFor("/stop"));
  await cx.sleep(400);
  if (!stopOffered(await read(t))) { await keys(t, ["esc", "ctrl+u"]); return "That Claude Code doesn't offer /stop: restart it by hand."; }
  await keys(t, ["enter"]);
  // /stop leaves Claude Code's session list in front: ctrl+c twice quits it. Only a terminal that
  // answers and shows its shell counts as out.
  let out = false;
  for (let i = 0; i < 20 && !out; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (g && g.state !== "live") return "The terminal ended when Claude Code stopped.";
    out = Boolean(g?.foreground) && !isClaude(g);
    if (!out && i === 3) { await keys(t, ["ctrl+c"]); await keys(t, ["ctrl+c"]); }
  }
  if (!out) return "Claude Code didn't stop: check the terminal.";
  const started = Date.now();
  await keys(t, [...line, "enter"]);
  for (let i = 0; i < 40; i++) {
    await cx.sleep(500);
    g = await get(t);
    // Reporting again: its new Claude Code said so since it started.
    if (isClaude(g) && g.status?.app && (g.status_ms ?? 0) >= started) return null;
  }
  return "Claude Code started again but isn't reporting yet: check the terminal.";
}

// The click: runs revive() once per terminal, and says how it went. `v.reviving` keeps the row
// (and its spinner) while the pane is a shell between the two Claude Codes.
export function bringBack(v, a, cx) {
  if (v.reviving.has(a.address)) return;
  const id = v.claude?.get(a.address)?.id ?? null;
  v.reviving.add(a.address);
  cx.notify();
  cx.spawn(async (cx) => {
    let why;
    try { why = await revive(a.address, id, cx); } catch (e) { why = String(e?.message ?? e); }
    v.reviving.delete(a.address);
    notify(why ? { title: `Couldn't bring back ${a.space_name}`, body: why, level: "warning" } : { title: `${a.space_name} is reporting again`, level: "success", timeout: 3000 });
    cx.notify();
  });
}
