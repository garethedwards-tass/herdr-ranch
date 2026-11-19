// Codex agents: which conversation each runs, what it shows (model, effort, context), and Restart.
//
// Codex writes each conversation to ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Its
// first line (session_meta) has the conversation's id and folder; `source` is "cli" for one you
// started (a review or other subagent has its own file, with a parent). Each turn adds a
// turn_context (model, effort) and token_count records (the last reply's tokens and the model's
// context window). ~/.codex/session_index.jsonl names conversations ("thread_name"), and Codex
// puts that name first in the terminal's title ("Review code | clif"), which tells two
// conversations in one folder apart.
//
// Restart: Codex quits with /quit (it then prints `codex resume <id>`), and a small script starts
// it again in that folder with the running one's own options and `codex resume <id>`. Typed with
// `hc keys` like revive.js (it explains why), and it stops at anything unexpected.

import { hc, appHome, home, writeTextFile, readTextFile, exec, notify } from "herdr";
import { keysFor, envVar } from "./revive.js";

export const isCodex = (a) => (a.app === "codex" || a.program?.key === "codex") && !a.address.includes("/");

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const field = (line, k) => new RegExp(`(?:^|[\\s{,])"${k}":"((?:[^"\\\\]|\\\\.)*)"`).exec(line)?.[1] ?? null;

// The recent conversations Codex started for you (not subagents): [{ id, cwd, file, mtime }], newest
// first. `out` is lines of "<file>\t<mtime>\t<session_meta's fields>": only "id", "cwd",
// "parent_thread_id" and "source" are picked from the first line (grep -o), wherever they are in it,
// so long instructions before them don't matter. No source counts as yours unless it has a parent.
export function parseSessionList(out, dir) {
  const list = [];
  for (const line of (out ?? "").split("\n")) {
    const [file, mtime, ...rest] = line.split("\t");
    const meta = rest.join("\t");
    if (!file) continue;
    if (/"parent_thread_id"/.test(meta) || /"source":\{/.test(meta)) continue;
    if (/"source":"/.test(meta) && !/"source":"cli"/.test(meta)) continue;
    const id = field(meta, "id"), cwd = field(meta, "cwd");
    if (id && cwd) list.push({ id, cwd, file: `${dir}/${file}`, mtime: Number(mtime) || 0 });
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

export async function codexSessions(dir = `${home()}/.codex/sessions`) {
  // Files changed in the last 3 days (a resumed old conversation keeps writing its own day's file),
  // listed by find, so no command line holds every file ever written; the newest 60.
  const script = 'cd "$1" 2>/dev/null || exit 0; find . -name "rollout-*.jsonl" -mtime -3 -exec sh -c \'for f; do m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"); printf "%s %s\\n" "$m" "$f"; done\' sh {} + 2>/dev/null | sort -rn | head -60 | while read -r m f; do printf "%s\\t%s\\t" "${f#./}" "$m"; head -n 1 "$f" | grep -o -E \'"(id|cwd|parent_thread_id)":"[^"]*"|"source":("[a-z]*"|\\{)\' | head -n 8 | tr "\\n\\t" "  "; echo; done';
  const r = await exec("sh", ["-c", script, "sh", dir], { timeout: 15000 }).catch(() => null);
  return parseSessionList(r?.stdout, dir);
}

// Conversation names by id, from the newest lines of session_index.jsonl.
export function parseIndex(out) {
  const names = new Map();
  for (const line of (out ?? "").split("\n")) {
    try { const j = JSON.parse(line); if (j?.id && j.thread_name) names.set(j.id, j.thread_name); } catch { /* a cut line */ }
  }
  return names;
}
export async function codexNames(file = `${home()}/.codex/session_index.jsonl`) {
  const r = await exec("tail", ["-n", "400", file]).catch(() => null);
  return parseIndex(r?.stdout);
}

// The terminal's conversation: the one in its folder whose name starts its title, else the newest
// there. `sure` when the name matched, or no other Codex terminal shares the folder (`sharing`):
// Restart only resumes a conversation it is sure of.
export function pickCodex(list, cwd, title, names, sharing = 1) {
  const here = list.filter((s) => s.cwd === cwd);
  const name = (title ?? "").split(" | ")[0].trim();
  const named = name ? here.find((s) => names?.get(s.id) === name) : null;
  if (named) return { ...named, sure: true };
  return here[0] ? { ...here[0], sure: sharing <= 1 } : null;
}

// The newest turn_context and token_count after `offset`, and the file's size, from one sh call.
export function parseRead(out) {
  const lines = (out ?? "").split("\n");
  const size = Number(/^SIZE (\d+)$/m.exec(out ?? "")?.[1]) || null;
  const st = {};
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j?.type === "turn_context") { st.model = j.payload?.model ?? st.model; st.effort = j.payload?.effort ?? st.effort; }
    if (j?.type === "event_msg" && j.payload?.type === "token_count" && j.payload.info) {
      const i = j.payload.info;
      if (i.last_token_usage?.total_tokens != null) st.context = i.last_token_usage.total_tokens;
      if (i.model_context_window) st.window = i.model_context_window;
    }
  }
  return { st, size };
}
export async function readCodex(file, offset = 0) {
  // Whole lines only: a line Codex is still writing is left for next time (SIZE stops before it).
  // A token_count without usage (info null: a rate-limit update) doesn't replace one with usage.
  const script = 'export LC_ALL=C; s=$(wc -c < "$1" | tr -d " "); [ "$s" -gt "$2" ] || { echo "SIZE $s"; exit 0; }; if [ "$(tail -c +$s "$1" | head -c 1 | od -An -tx1 | tr -d " \\n")" != 0a ]; then p=$(tail -c +$(($2 + 1)) "$1" | head -c $((s - $2)) | tail -n 1 | wc -c | tr -d " "); s=$((s - p)); fi; tail -c +$(($2 + 1)) "$1" | head -c $((s - $2)) | awk \'/"type":"turn_context"/{a=$0} /"type":"token_count"/ && /"last_token_usage"/{b=$0} END{if(a!="")print a; if(b!="")print b}\'; echo "SIZE $s"';
  const r = await exec("sh", ["-c", script, "sh", file, String(offset)], { timeout: 15000 }).catch(() => null);
  return parseRead(r?.stdout);
}

// What the menu shows, as plain data.
export function codexSnapshot(c, title) {
  const st = c.st;
  return { kind: "codex", title: title || "Codex", model: st.model ?? null, effort: st.effort ?? null, context: st.context ?? 0, window: st.window ?? 0, session: c.id };
}
// "gpt-6.1-sol" → "GPT-6.1-Sol" (what Codex shows).
export const codexModel = (id) => (id ?? "Codex").split("-").map((w, i) => (i === 0 && /^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1))).join("-");
// For the pill: the model's last word ("Sol"), or its number when it has none ("GPT-6.1").
export const codexShort = (id) => { const w = (id ?? "").split("-"); return w.length > 2 && /^[a-z]+$/i.test(w.at(-1)) ? codexModel(w.at(-1)) : id ? codexModel(id) : "Codex"; };

// Each tick: every Codex agent here gets its conversation and what was added since.
const LIST_EVERY = 15000, IDLE_EVERY = 20000;
export async function refreshCodex(v, mine, all) {
  v.codex ??= new Map();
  if (!mine.length) { const had = v.codex.size > 0; v.codex.clear(); return had; }
  const now = Date.now();
  if (!v.codexList || now - (v.codexListAt ?? 0) > LIST_EVERY) { v.codexList = await codexSessions(); v.codexNames = await codexNames(); v.codexListAt = now; }
  const cwd = new Map(all.map((t) => [t.address, t.cwd]));
  const sharing = new Map();
  for (const a of mine) sharing.set(cwd.get(a.address), (sharing.get(cwd.get(a.address)) ?? 0) + 1);
  let changed = false;
  const seen = new Set();
  for (const a of mine) {
    seen.add(a.address);
    const s = pickCodex(v.codexList, cwd.get(a.address), a.title, v.codexNames, sharing.get(cwd.get(a.address)));
    let c = v.codex.get(a.address);
    if (!s) { if (c) { v.codex.delete(a.address); changed = true; } continue; }
    if (c && c.sure !== s.sure) { c.sure = s.sure; changed = true; }
    if (!c || c.id !== s.id) {
      const { st, size } = await readCodex(s.file, 0);
      v.codex.set(a.address, { id: s.id, file: s.file, cwd: s.cwd, sure: s.sure, st, offset: size ?? 0, read: now });
      changed = true;
      continue;
    }
    if (a.status !== "working" && now - c.read < IDLE_EVERY) continue;
    c.read = now;
    const more = await readCodex(c.file, c.offset);
    if (more.size != null && more.size !== c.offset) {
      const before = JSON.stringify(c.st);
      Object.assign(c.st, more.st); c.offset = more.size;
      if (JSON.stringify(c.st) !== before) changed = true;
    }
  }
  for (const k of [...v.codex.keys()]) if (!seen.has(k)) { v.codex.delete(k); changed = true; }
  return changed;
}

// Restart -----------------------------------------------------------------------------------

// Codex's options by what follows them (`codex resume --help`, 0.170). Positional words (a first
// prompt, or the session `resume` was given) are dropped: the script names the session itself.
const ONE = new Set(["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m", "--model",
  "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval"]);
const NONE = new Set(["--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--worktree",
  "--search", "--no-alt-screen", "--no-daemon", "--strict-config", "--include-non-interactive", "--full-auto", "--yolo"]);
const DROP = new Set(["--last", "--all"]);
// The script already goes to the conversation's folder (the one -C chose): -C is left out. A
// relative path after -C was relative to the folder before it, which isn't known: it stops.
const CD = new Set(["-C", "--cd"]), PATHS = new Set(["--add-dir", "-i", "--image"]);
export function codexResumeArgs(args, id) {
  const pairs = [], flags = [];
  const a = [...args];
  if (a[0] === "resume") a.shift();
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (DROP.has(x)) continue;
    if (/^--[\w-]+=/.test(x)) { const k = x.split("="), name = k[0]; if (!ONE.has(name)) throw new Error(`Unknown Codex option ${name}`); pairs.push([name, x.slice(name.length + 1), true]); continue; }
    if (ONE.has(x)) { if (i + 1 >= a.length) throw new Error(`${x} has no value`); pairs.push([x, a[++i], false]); continue; }
    if (NONE.has(x)) { flags.push(x); continue; }
    if (/^-/.test(x)) throw new Error(`Unknown Codex option ${x}`);
    // a prompt or a session: left out
  }
  const cd = pairs.some(([k]) => CD.has(k));
  const keep = [];
  for (const [k, val, joined] of pairs) {
    if (CD.has(k)) continue;
    if (cd && PATHS.has(k) && !/^[/~]/.test(val)) throw new Error(`${k} ${val} is relative to a folder -C changed`);
    keep.push(...(joined ? [`${k}=${val}`] : [k, val]));
  }
  keep.push(...flags);
  return ["resume", ...keep, id];
}

export function codexScript(cwd, setup, args) {
  return [
    "# herdr-ranch: resume a Codex conversation (written by the Agents list)",
    `cd ${q(cwd)} || exit 1`,
    setup,
    `exec codex ${args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

// Codex's prompt line ("› …"), from the bottom of a screen.
export function codexPrompt(screen) {
  const lines = (screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const m = /^›[  ]?(.*)$/.exec(lines[i]); if (m) return m[1].trimEnd(); }
  return null;
}
// What Codex prints as it quits: "codex resume <id>".
export const resumedId = (screen) => [...(screen ?? "").matchAll(/codex resume ([0-9a-f-]{36})/g)].at(-1)?.[1] ?? null;
const busy = (screen) => /esc to interrupt/i.test((screen ?? "").split("\n").slice(-8).join("\n"));

const get = async (t) => { const r = await hc(["get", t, "--json"]).catch(() => null); try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
const read = async (t) => (await hc(["read", t]).catch(() => null))?.stdout ?? "";
const keys = (t, ks) => hc(["keys", t, ...ks]);
const inFront = (g) => /(^|\/)codex$/.test(g?.foreground?.argv?.[0] ?? "") || g?.foreground?.name === "codex";

// Restarts terminal `t`'s Codex on conversation `session` ({ id, cwd }). Null when done, else why not.
export async function restartCodex(t, session, cx) {
  let g = await get(t);
  if (!g || !inFront(g)) return "Codex isn't in front in that terminal.";
  if (g.status?.state === "working") return "It's working: try again when it's done.";
  const { id, cwd } = session ?? {};
  if (!id || !/^[\w-]+$/.test(id) || !cwd) return "Couldn't tell which conversation it is: restart it by hand.";
  if (!session.sure) return "Another Codex terminal shares its folder, so which conversation is its own isn't certain: restart it by hand.";
  if (String(g.pid) === String(g.foreground.pid)) return "Codex is the terminal's own program, with no shell behind it: restart it by hand.";
  let args;
  try { args = codexResumeArgs(g.foreground.argv.slice(1), id); } catch (e) { return `${e.message}: restart it by hand.`; }
  // CODEX_HOME (another Codex login), when the running one has it.
  const env = await exec("ps", ["eww", "-o", "command=", "-p", String(g.foreground.pid)]).catch(() => null);
  const codexHome = envVar(env?.stdout, g.foreground.argv, "CODEX_HOME");
  const setup = codexHome ? `export CODEX_HOME=${q(codexHome)}` : "unset CODEX_HOME";
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-codex-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return "The script's path can't be typed into the terminal.";
  await exec("mkdir", ["-p", dir]);
  const write = async (a) => writeTextFile(path, codexScript(cwd, setup, a), await readTextFile(path).catch(() => null));
  await write(args);

  // From here on the terminal is touched: look before each key.
  const screen = await read(t);
  if (busy(screen)) return "It's working: try again when it's done.";
  // An empty prompt shows a placeholder: a typed x shows alone only when nothing was drafted.
  await keys(t, ["x"]);
  let typed = null;
  for (let i = 0; i < 12 && typed !== "x"; i++) { await cx.sleep(200); typed = codexPrompt(await read(t)); }
  await keys(t, ["backspace"]);
  if (typed !== "x") return "It has an unsent message in its prompt: send or clear it first.";
  await keys(t, keysFor("/quit"));
  await cx.sleep(400);
  if (codexPrompt(await read(t)) !== "/quit") { await keys(t, ["ctrl+u"]); return "Couldn't type /quit into Codex: restart it by hand."; }
  await keys(t, ["enter"]);
  let out = false;
  for (let i = 0; i < 20 && !out; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (g && g.state !== "live") return "The terminal ended when Codex quit.";
    out = Boolean(g?.foreground) && !inFront(g);
    if (!out && i === 4) { await keys(t, ["ctrl+c"]); await keys(t, ["ctrl+c"]); }
  }
  if (!out) return "Codex didn't quit: check the terminal.";
  // Codex names the conversation as it quits: trust that over the folder match.
  const said = resumedId(await read(t));
  if (said && said !== id) await write([...args.slice(0, -1), said]);
  const started = Date.now();
  await keys(t, [...line, "enter"]);
  for (let i = 0; i < 40; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (inFront(g) && g.status?.app && (g.status_ms ?? 0) >= started) return null;
  }
  return "Codex started again but isn't reporting yet: check the terminal.";
}

export function restartCodexAgent(v, a, cx) {
  if (v.reviving.has(a.address)) return;
  const session = v.codex?.get(a.address) ?? null;
  v.reviving.add(a.address);
  cx.notify();
  cx.spawn(async (cx) => {
    let why;
    try { why = await restartCodex(a.address, session, cx); } catch (e) { why = String(e?.message ?? e); }
    v.reviving.delete(a.address);
    const name = a.space_name ?? a.name ?? "the agent";
    notify(why ? { title: `Couldn't restart ${name}`, body: why, level: "warning" } : { title: `Restarted ${name}`, level: "success", timeout: 3000 });
    cx.notify();
  });
}
