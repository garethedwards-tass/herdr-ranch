// Bringing back a Claude Code agent that stopped reporting its status to Herdr (OSC 7501): it
// still runs, but Herdr's own lists and next/previous agent skip it. A fresh start reports again.
// A background session (`/exit` only detaches) ends with `/stop` (keeps the conversation), then its
// session list is quit back to the pane's shell; a plain one ends with `/exit`; then a small
// script starts Claude Code again with the running one's own options and `--resume <session id>`,
// so it reopens this conversation and no other.
//
// The account: the panel already knows which Claude Code config folder holds the session (the
// watcher found it there) and the folder it runs in. The script goes to that folder and points
// CLAUDE_CONFIG_DIR at that config folder (or unsets it for the usual one), so `--resume` finds the
// conversation whatever the shell has. A Spaces account for that folder (or the one Claude Code
// names in HERDR_RANCH_ACCOUNT, when it agrees) also sets its GitHub login, with envScript.
//
// It's driven with `hc keys`, which types only unshifted keys and shift+letter (no $ ~ ( ) _), so
// the shell is given `sh <script>`, a path made of typable characters. `hc send` would wrap the
// text in <hc> tags. Everything that can fail without touching the terminal happens first; then
// every step reads the screen and stops at anything unexpected.

import { hc, appHome, home, writeTextFile, readTextFile, exec, notify } from "herdr";
import { accounts, envScript, expand, defaultGhUser } from "./accounts.js";

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

// The prompt line's text (after "❯ "), from the bottom of a screen; null when none shows. Newer
// Claude Code puts a no-break space (U+00A0) after the ❯, so every match here takes either space.
export function promptText(screen) {
  const lines = (screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^❯[ \u00a0]?(.*)$/.exec(lines[i]);
    if (m) return m[1].trimEnd();
  }
  return null;
}

const bottom = (screen, n = 5) => (screen ?? "").split("\n").slice(-n).join("\n");

// Whether a background agent of the session is still running (the status bar's "← 2 agents").
export const runningAgents = (screen) => /← \d+ agents?\b/.test(bottom(screen));
export const footerAgents = (screen) => Number(/← (\d+) agents?\b/.exec(bottom(screen))?.[1] ?? 0);
// Whether the session's own records say every background agent the footer counts has finished:
// only when there are records, all done, and at least as many as the footer shows (the watcher
// keeps the newest 8, and none when they couldn't be read).
export const recordsCoverFooter = (subs, screen) => Array.isArray(subs) && subs.length > 0 && subs.length >= footerAgents(screen) && subs.every((x) => x.done);

// Whether Claude Code is working: "esc to interrupt" in its status bar, or a spinner glyph leading
// its title (✳ when it waits). Either one is enough to leave it alone.
export const busyTitle = (title) => { const c = [...(title ?? "").trim()][0]; return Boolean(c) && !/[\p{L}\p{N}✳]/u.test(c); };
export const busyScreen = (screen) => /esc to interrupt/i.test(bottom(screen, 8));

// Vim mode shows "-- INSERT --" while typing adds text; anywhere else a key would edit the draft.
export const vimInsert = (screen) => /-- INSERT --/.test(bottom(screen, 8));

// Whether Claude Code says an installed update waits for its own /restart ("Update installed ·
// /restart to apply"); older versions say "Restart to update" and have no /restart.
export const restartOffered = (screen) => /\/restart to apply/i.test(bottom(screen, 10));
// Whether the slash menu's highlighted entry is /restart.
// Every menu match stays on one line ([ \u00a0], not \s, which also takes a newline): the typed
// prompt line followed by padding or a blank line must not count as the menu's entry.
export const restartInMenu = (screen) => /^[ \u00a0]*❯[ \u00a0]\/restart[ \u00a0]{2,}\S/m.test(screen ?? ""); // the menu line, not the prompt

// Whether the slash menu's highlighted entry is Claude Code's /stop for a background session.
// Whether the slash menu's highlighted entry is /exit (a session that isn't in the background).
export const exitOffered = (screen) => /^[ \u00a0]*❯[ \u00a0]\/exit[ \u00a0]{2,}\S/m.test(screen ?? "");
export const stopOffered = (screen) => /^[ \u00a0]*❯[ \u00a0]\/stop[ \u00a0]+Stop this background session/m.test(screen ?? "");

// Claude Code's options by what follows them: nothing (0), one value (1), an optional value ("?"),
// or several ("*"). Read from the installed `claude --help` (helpArity); STATIC is 2.1.325's, for
// when that can't be read. SESSION ones choose a conversation (or folder) and are replaced; REFUSE
// ones make a session that can't be resumed this way.
export function helpArity(text) {
  const out = {};
  // Option lines start near the margin; a description's wrapped lines (which can mention other
  // options) are indented deeper.
  for (const line of (text ?? "").split("\n")) {
    const m = /^ {1,6}((?:-[\w-]+(?:, )?)+)(?: (<[^>]+>|\[[^\]]+\]))?(?:\s|$)/.exec(line);
    if (!m) continue;
    const arg = m[2] ?? "", arity = !arg ? 0 : arg.endsWith("...>") || arg.endsWith("...]") ? "*" : arg.startsWith("[") ? "?" : 1;
    for (const name of m[1].split(", ").map((x) => x.trim()).filter(Boolean)) out[name] = arity;
  }
  return out;
}
const STATIC = helpArity(`
  --add-dir <directories...>
  --agent <agent>
  --agents <json-or-file>
  --allow-dangerously-skip-permissions
  --allowedTools, --allowed-tools <tools...>
  --append-system-prompt <prompt>
  --append-system-prompt-file <file>
  --system-prompt-file <file>
  --autocompact <auto|tokens>
  --ax-screen-reader
  --bg, --background
  --bare
  --betas <betas...>
  --brief
  --chrome
  --cloud [description|session_id|url]
  -c, --continue
  --dangerously-skip-permissions
  -d, --debug [filter]
  --debug-file <path>
  --desktop
  --disable-slash-commands
  --disallowedTools, --disallowed-tools <tools...>
  --effort <level>
  --environment <environment_id>
  --exclude-dynamic-system-prompt-sections
  --fallback-model <model>
  --file <specs...>
  --fork-session
  --forward-subagent-text
  --from-pr [value]
  --ide
  --include-hook-events
  --include-partial-messages
  --input-format <format>
  --json-schema <schema>
  --max-budget-usd <amount>
  --mcp-config <configs...>
  --model <model>
  -n, --name <name>
  --no-chrome
  --no-session-persistence
  --output-format <format>
  --permission-mode <mode>
  --permission-prompts <target>
  --plugin-dir <path>
  --plugin-url <url>
  -p, --print
  --prompt-suggestions [value]
  --remote-control [name]
  --remote-control-session-name-prefix <prefix>
  --replay-user-messages
  --restricted
  -r, --resume [value]
  --safe-mode
  --session-id <uuid>
  --setting-sources <sources>
  --settings <file-or-json>
  --strict-mcp-config
  --system-prompt <prompt>
  --system-prompt-snapshot <on|off>
  --teleport [session]
  --tmux
  --tools <tools...>
  --verbose
  -w, --worktree [name]
`);
const SESSION = new Set(["-c", "--continue", "--fork-session", "--desktop", "--session-id", "-r", "--resume", "--from-pr", "--teleport", "--cloud", "-w", "--worktree"]);
const REFUSE = { "-p": "--print", "--print": "--print", "--no-session-persistence": "--no-session-persistence (its conversation isn't saved)", "-h": "--help", "--help": "--help", "-v": "--version", "--version": "--version" };

// Claude Code's arguments to start it again: its options as given, without its first prompt or any
// session choice, then `--resume <id>`. Throws on an option it doesn't know (or `--print`), as
// Claude Code would read the next argument differently.
export function resumeArgs(args, id, arity = STATIC) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break; // prompts only from here
    if (!a.startsWith("-") || a === "-") continue; // a prompt
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), true] : [a, false];
    if (name in REFUSE) throw new Error(`it was started with ${REFUSE[name]}`);
    const n = arity[name];
    if (n === undefined) throw new Error(`it was started with ${name}, which this doesn't know how to repeat`);
    const take = [a];
    if (!inline) {
      if (n === 1 && i + 1 < args.length) take.push(args[++i]);
      if (n === "?" && i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
      if (n === "*") while (i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
    }
    if (!SESSION.has(name)) out.push(...take);
  }
  return [...out, "--resume", id];
}

// A variable from a process's environment in `ps eww -o command=` output, which is its arguments
// then its environment: the arguments are cut off first so their text can't be read as one.
export function envVar(psOut, argv, k) {
  const head = (argv ?? []).join(" ");
  const text = (psOut ?? "").replace(/\n$/, "");
  if (!text.startsWith(head)) return undefined;
  return new RegExp(`(?:^|\\s)${k}=(\\S*)`).exec(text.slice(head.length))?.[1];
}

// The script's account lines: the session's config folder (unset for the usual one) and, for a
// Spaces account on that folder, its GitHub login. `named`: the account id Claude Code carries,
// used only when that account's folder is this one.
export function setupFor({ configDir, home, named = null, list = [], defaultGh = "" }) {
  const usual = configDir === `${home}/.claude`;
  const on = (a) => (a.claudeDir ? expand(a.claudeDir, home) === configDir : usual);
  const account = list.find((a) => a.id === named && on(a)) ?? (usual ? null : list.find((a) => a.claudeDir && on(a))) ?? null;
  if (account) return [envScript(account), ...(account.claudeDir ? [] : ["unset CLAUDE_CONFIG_DIR"])].join("; ");
  // The usual login with no account: no account's GitHub login, when it has one.
  if (usual) return ["unset CLAUDE_CONFIG_DIR", ...(defaultGh ? [envScript({ ghUser: defaultGh })] : [])].join("; ");
  return `export CLAUDE_CONFIG_DIR=${q(configDir)}`;
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function scriptFor(cwd, setup, args) {
  return [
    "# herdr-ranch: resume a Claude Code session that stopped reporting its status (written by the Agents list)",
    `cd ${q(cwd)} || exit 1`,
    setup,
    `exec claude ${args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

// Whether Claude Code's prompt uses vim keys: its global config's editorMode (~/.claude.json for the
// usual folder, else <folder>/.claude.json). null when that can't be read: then it isn't guessed.
async function vimMode(configDir) {
  const h = home(), file = configDir === `${h}/.claude` ? `${h}/.claude.json` : `${configDir}/.claude.json`;
  const text = await readTextFile(file).catch(() => null);
  if (text == null) return null;
  try { return JSON.parse(text).editorMode === "vim"; } catch { return null; }
}

// The installed Claude Code's options, read once.
let helpRead = null;
const optionTable = () => (helpRead ??= exec("sh", ["-lc", "claude --help"], { timeout: 15000 })
  .then((r) => { const t = helpArity(r?.stdout ?? ""); return Object.keys(t).length > 20 ? t : STATIC; })
  .catch(() => STATIC));

const get = async (t) => { const r = await hc(["get", t, "--json"]).catch(() => null); try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
const read = async (t) => (await hc(["read", t]).catch(() => null))?.stdout ?? "";
const keys = (t, ks) => hc(["keys", t, ...ks]);
const isClaude = (g) => /(^|\/)claude$/.test(g?.foreground?.argv?.[0] ?? "");

// The session's entry in `claude agents --json` (by session id, else by process): its kind
// ("interactive" or "background") and, for a background one, its short id. null when not listed.
export function agentEntry(list, sessionId, pid) {
  if (!Array.isArray(list)) return null;
  return list.find((e) => e?.sessionId === sessionId) ?? list.find((e) => e?.pid != null && String(e.pid) === String(pid)) ?? null;
}
const asAccount = (configDir) => (configDir === `${home()}/.claude` ? "unset CLAUDE_CONFIG_DIR" : `export CLAUDE_CONFIG_DIR=${q(configDir)}`);
async function sessionEntry(configDir, sessionId, pid) {
  const r = await exec("sh", ["-lc", `${asAccount(configDir)}; claude agents --json`], { timeout: 15000 }).catch(() => null);
  try { return agentEntry(JSON.parse(r?.stdout ?? ""), sessionId, pid); } catch { return null; }
}

// Brings back terminal `t` (an address on this computer) to session `id`. Resolves to null when
// done, else why not.
// restart: also when it's reporting (Restart in its menu: e.g. to pick up an installed update).
export async function revive(t, session, cx, restart = false) {
  let g = await get(t);
  if (!g || !isClaude(g)) return "Claude Code isn't in front in that terminal.";
  if (g.status && !restart) return null; // reporting again already
  const { id, configDir, cwd } = session ?? {};
  if (!id || !/^[\w-]+$/.test(id) || !configDir || !cwd) return "Couldn't tell which conversation it is: restart it by hand.";
  // Which kind of session: a background one restarts with `claude respawn` (nothing typed); an
  // interactive one ends with /exit; one Claude Code doesn't list is tried with /stop, then /exit.
  const entry = await sessionEntry(configDir, id, g.foreground.pid);
  if (restart && entry?.kind === "background" && /^[\w-]+$/.test(entry.id ?? "")) {
    if (busyTitle(g.title) || /busy|working/.test(entry.state ?? entry.status ?? "")) return "It looks busy: try again when it's done.";
    const r = await exec("sh", ["-lc", `${asAccount(configDir)}; claude respawn ${q(entry.id)}`], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    return r.code === 0 ? null : `claude respawn failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`;
  }
  const plain = entry?.kind === "interactive";
  // /stop must leave a shell behind to type into: Claude Code can't be the terminal's own program.
  if (String(g.pid) === String(g.foreground.pid)) return "Claude Code is the terminal's own program, with no shell behind it: restart it by hand.";
  let args;
  try { args = resumeArgs(g.foreground.argv.slice(1), id, await optionTable()); } catch (e) { return `${e.message}: restart it by hand.`; }
  const env = await exec("ps", ["eww", "-o", "command=", "-p", String(g.foreground.pid)]).catch(() => null);
  const named = envVar(env?.stdout, g.foreground.argv, "HERDR_RANCH_ACCOUNT") ?? null;
  const setup = setupFor({ configDir, home: home(), named, list: accounts(), defaultGh: defaultGhUser() });
  const vim = await vimMode(configDir);
  if (vim === null) return "Couldn't read its Claude Code settings (vim mode): restart it by hand.";
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return "The script's path can't be typed into the terminal.";
  await exec("mkdir", ["-p", dir]);
  await writeTextFile(path, scriptFor(cwd, setup, args), await readTextFile(path).catch(() => null));

  // From here on the terminal is touched: look before each key.
  const screen = await read(t);
  if (busyTitle(g.title) || busyScreen(screen)) return "It looks busy: try again when it's done.";
  // Claude Code's footer ("← 1 agent") keeps finished background agents too: a restart goes by the
  // session's own records (claude.js subagents) when it has them.
  const recordsIdle = restart && recordsCoverFooter(session.subs, screen);
  if (runningAgents(screen) && !recordsIdle) return "A background agent of that session is still running: try again when it's done.";
  if (vim && !vimInsert(screen)) return "Its prompt uses vim keys and isn't in insert mode: press i there, then try again.";
  // A typed draft stays when a key is added; Claude Code's suggested reply is replaced.
  await keys(t, ["x"]);
  let typed = null;
  for (let i = 0; i < 12 && typed !== "x"; i++) { await cx.sleep(200); typed = promptText(await read(t)); }
  await keys(t, ["backspace"]);
  if (typed !== "x") return "It has an unsent message in its prompt: send or clear it first.";
  // Claude Code's own /restart, where it has one: it restarts in place on the same conversation.
  if (restart && restartOffered(screen)) {
    await keys(t, keysFor("/restart"));
    await cx.sleep(400);
    if (restartInMenu(await read(t))) {
      const asked = Date.now();
      await keys(t, ["enter"]);
      for (let i = 0; i < 40; i++) {
        await cx.sleep(500);
        g = await get(t);
        if (isClaude(g) && g.status?.app && (g.status_ms ?? 0) >= asked) return null;
      }
      return "Claude Code's /restart ran but it isn't reporting yet: check the terminal.";
    }
    await keys(t, ["esc", "ctrl+u"]);
  }
  let stop = false;
  if (!plain) {
    await keys(t, keysFor("/stop"));
    await cx.sleep(400);
    stop = stopOffered(await read(t));
    if (!stop) { await keys(t, ["esc", "ctrl+u"]); await cx.sleep(200); }
  }
  // /exit only detaches a background session, which would leave it running beside the new one:
  // without /stop it is used only for a session Claude Code lists as interactive.
  if (!stop && !plain) return entry ? "That background session doesn't offer /stop: restart it by hand." : "Couldn't tell whether it's a background session (claude agents didn't answer): try again, or restart it by hand.";
  if (!stop) {
    // An interactive session (started as plain `claude`): /exit ends it.
    await keys(t, keysFor("/exit"));
    await cx.sleep(400);
    if (!exitOffered(await read(t))) { await keys(t, ["esc", "ctrl+u"]); return "That Claude Code offers neither /stop nor /exit: restart it by hand."; }
  }
  await keys(t, ["enter"]);
  // /stop leaves Claude Code's session list in front (ctrl+c twice quits it); /exit goes straight to
  // the shell. Only a terminal that answers and shows its shell counts as out.
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
export function bringBack(v, a, cx, restart = false) {
  if (v.reviving.has(a.address)) return;
  const session = v.claude?.get(a.address) ?? null;
  v.reviving.add(a.address);
  cx.notify();
  cx.spawn(async (cx) => {
    let why;
    try { why = await revive(a.address, session, cx, restart); } catch (e) { why = String(e?.message ?? e); }
    v.reviving.delete(a.address);
    const name = a.space_name ?? a.name ?? "the agent";
    notify(why ? { title: `Couldn't ${restart ? "restart" : "bring back"} ${name}`, body: why, level: "warning" }
      : { title: restart ? `Restarted ${name}` : `${name} is reporting again`, level: "success", timeout: 3000 });
    cx.notify();
  });
}
