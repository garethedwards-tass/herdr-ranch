// Bringing back a Claude Code agent that stopped reporting its status to Herdr (OSC 7501): it
// still runs, but Herdr's own lists and next/previous agent skip it. A fresh start reports again.
// Claude Code runs sessions in the background (`/exit` only detaches), so: `/stop` (ends the
// session, keeps the conversation), quit the session list back to the pane's shell, then a small
// script starts Claude Code again with the running one's own options and `--resume <session id>`,
// so it reopens this conversation and no other.
//
// The account: the script runs in the shell Claude Code was started from, so it inherits that
// shell's environment. When Claude Code's CLAUDE_CONFIG_DIR or GH_TOKEN differ from the shell's
// (a Spaces account set only for it), the script sets them again from the account it names
// (HERDR_RANCH_ACCOUNT, from shared/accounts.js envScript), with the same envScript. Anything it
// can't account for, it refuses rather than guess.
//
// It's driven with `hc keys`, which types only unshifted keys and shift+letter (no $ ~ ( ) _), so
// the shell is given `sh <script>`, a path made of typable characters. `hc send` would wrap the
// text in <hc> tags. Everything that can fail without touching the terminal happens first; then
// every step reads the screen and stops at anything unexpected.

import { hc, appHome, home, writeTextFile, readTextFile, exec, notify } from "herdr";
import { accounts, envScript } from "./accounts.js";

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

// Vim mode shows "-- INSERT --" while typing adds text; anywhere else a key would edit the draft.
export const vimInsert = (screen) => /-- INSERT --/.test(bottom(screen, 8));

// Whether the slash menu's highlighted entry is Claude Code's /stop for a background session.
export const stopOffered = (screen) => /^\s*❯ \/stop\s+Stop this background session/m.test(screen ?? "");

// Claude Code 2.1's options (`claude --help`) by what follows them: nothing, one value, an
// optional value, or several values. SESSION ones choose a conversation and are replaced.
const NONE = "--allow-dangerously-skip-permissions --ax-screen-reader --bg --background --bare --brief --chrome --dangerously-skip-permissions --disable-slash-commands --exclude-dynamic-system-prompt-sections --forward-subagent-text --ide --include-hook-events --include-partial-messages --no-chrome --no-session-persistence --replay-user-messages --restricted --safe-mode --strict-mcp-config --verbose --tmux";
const ONE = "--agent --agents --append-system-prompt --append-system-prompt-file --system-prompt-file --autocompact --debug-file --effort --environment --fallback-model --input-format --json-schema --max-budget-usd --model -n --name --output-format --permission-mode --permission-prompts --plugin-dir --plugin-url --remote-control-session-name-prefix --setting-sources --settings --system-prompt --system-prompt-snapshot";
const OPTIONAL = "-d --debug --prompt-suggestions --remote-control";
const MANY = "--add-dir --allowedTools --allowed-tools --betas --disallowedTools --disallowed-tools --file --mcp-config --tools";
const SESSION = { "-c": 0, "--continue": 0, "--fork-session": 0, "--desktop": 0, "--session-id": 1, "-r": "?", "--resume": "?", "--from-pr": "?", "--teleport": "?", "--cloud": "?", "-w": "?", "--worktree": "?" };
const ARITY = Object.fromEntries([...NONE.split(" ").map((o) => [o, 0]), ...ONE.split(" ").map((o) => [o, 1]),
  ...OPTIONAL.split(" ").map((o) => [o, "?"]), ...MANY.split(" ").map((o) => [o, "*"])]);

// Claude Code's arguments to start it again: its options as given, without its first prompt or any
// session choice, then `--resume <id>`. Throws on an option it doesn't know (or `--print`), as
// Claude Code would read the next argument differently.
export function resumeArgs(args, id) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break; // prompts only from here
    if (!a.startsWith("-") || a === "-") continue; // a prompt
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), true] : [a, false];
    const session = name in SESSION, arity = session ? SESSION[name] : ARITY[name];
    if (arity === undefined) throw new Error(`it was started with ${name}, which this doesn't know how to repeat`);
    const take = [a];
    if (!inline) {
      if (arity === 1 && i + 1 < args.length) take.push(args[++i]);
      if (arity === "?" && i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
      if (arity === "*") while (i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
    }
    if (!session) out.push(...take);
  }
  return [...out, "--resume", id];
}

// A variable's value in `ps eww` output (the first space ends it, the same for both sides).
export const envOf = (ps, k) => new RegExp(`(?:^|\\s)${k}=(\\S*)`).exec(ps ?? "")?.[1];

// The account setup the script needs, from Claude Code's and its shell's environments: "" when
// the shell already has Claude Code's account, envScript(account) when Claude Code's names one,
// else null (refuse). `list`: the accounts (shared/accounts.js).
export function setupFor(claudePs, shellPs, list) {
  const same = ["CLAUDE_CONFIG_DIR", "GH_TOKEN"].every((k) => envOf(claudePs, k) === envOf(shellPs, k));
  if (same) return "";
  const id = envOf(claudePs, "HERDR_RANCH_ACCOUNT");
  const a = id && list.find((x) => x.id === id);
  return a ? envScript(a) : null;
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

// Whether Claude Code's prompt uses vim keys (its config's editorMode).
async function vimMode(configDir) {
  const dirs = configDir ? [configDir.replace(/^~(?=\/)/, home())] : [home(), `${home()}/.claude`];
  for (const d of dirs) {
    const text = await readTextFile(`${d}/.claude.json`).catch(() => null);
    if (text) { try { return JSON.parse(text).editorMode === "vim"; } catch { return false; } }
  }
  return false;
}

const get = async (t) => { const r = await hc(["get", t, "--json"]).catch(() => null); try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
const read = async (t) => (await hc(["read", t]).catch(() => null))?.stdout ?? "";
const keys = (t, ks) => hc(["keys", t, ...ks]);
const ps = async (args) => (await exec("ps", args).catch(() => null))?.stdout ?? "";
const isClaude = (g) => /(^|\/)claude$/.test(g?.foreground?.argv?.[0] ?? "");

// Brings back terminal `t` (an address on this computer) to session `id`. Resolves to null when
// done, else why not.
export async function revive(t, id, cx) {
  let g = await get(t);
  if (!g || !isClaude(g)) return "Claude Code isn't in front in that terminal.";
  if (g.status) return null; // reporting again already
  if (!id || !/^[\w-]+$/.test(id)) return "Couldn't tell which conversation it is: restart it by hand.";
  const pid = String(g.foreground.pid);
  let args;
  try { args = resumeArgs(g.foreground.argv.slice(1), id); } catch (e) { return `${e.message}: restart it by hand.`; }
  const claudePs = await ps(["eww", "-o", "command=", "-p", pid]);
  const shell = (await ps(["-o", "ppid=", "-p", pid])).trim();
  if (!claudePs || !/^\d+$/.test(shell)) return "Couldn't read how it runs: restart it by hand.";
  const setup = setupFor(claudePs, await ps(["eww", "-o", "command=", "-p", shell]), accounts());
  if (setup === null) return "Its account settings differ from its shell's and name no account here: restart it by hand.";
  const vim = await vimMode(envOf(claudePs, "CLAUDE_CONFIG_DIR"));
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return "The script's path can't be typed into the terminal.";
  await exec("mkdir", ["-p", dir]);
  await writeTextFile(path, scriptFor(setup, args), await readTextFile(path).catch(() => null));

  // From here on the terminal is touched: look before each key.
  const screen = await read(t);
  if (busyTitle(g.title) || busyScreen(screen)) return "It looks busy: try again when it's done.";
  if (runningAgents(screen)) return "A background agent of that session is still running: try again when it's done.";
  if (vim && !vimInsert(screen)) return "Its prompt uses vim keys and isn't in insert mode: press i there, then try again.";
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
