// Antigravity agents (agy): which conversation each runs, what it shows (model, effort, context),
// and Restart.
//
// agy keeps each conversation in ~/.gemini/antigravity-cli/conversations/<id>.db (sqlite).
// cache/conversation_metadata.json lists them with their title, step count, last update and
// folders (WorkspaceURIs); cache/last_conversations.json names the newest one per folder.
//
// Context: after each turn agy writes a gen_metadata row, a protobuf without a published schema.
// Read from real conversations: field 1 holds the turn; in it 9.10.1 is the tokens in context and
// 9.10.4 the limit compaction works to (512,000 for Gemini 4, below the model's full window).
// A row of another shape (a whole prompt record, or a later agy that moved them) gives nothing,
// never a wrong number. Model and effort are read from agy's footer line on screen
// ("auto · Gemini 4 Neon · high · 1 task(s) · /tasks").
//
// Restart: agy quits on ctrl+d twice at an empty prompt; a small script starts it again in that
// folder with the running one's own options and `--conversation <id>`. Typed with `hc keys` like
// revive.js (it explains why), and it stops at anything unexpected.

import { hc, appHome, home, writeTextFile, readTextFile, exec } from "herdr";
import { keysFor } from "./revive.js";
import { startedOf } from "./codex.js";
import { parseAgyTurn } from "./agy-turn.js";
export { parseAgyTurn };

export const isAgy = (a) => (a.app === "antigravity" || a.program?.key === "antigravity") && !a.address.includes("/");

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const DIR = () => `${home()}/.gemini/antigravity-cli`;
const ID = /^[0-9a-f-]{36}$/;

// The conversations agy knows: [{ id, title, steps, updated (ms), cwds }], newest first, and the
// newest per folder ({ folder: id }).
export function parseAgyConversations(metaText, lastText) {
  let meta = null, last = null;
  try { meta = JSON.parse(metaText ?? "null"); } catch { /* being written */ }
  try { last = JSON.parse(lastText ?? "null"); } catch { /* being written */ }
  const list = Object.values(meta?.conversations ?? {}).map((c) => c?.summary).filter((s) => s && ID.test(s.ID ?? "")).map((s) => ({
    id: s.ID,
    title: String(s.Title ?? ""),
    steps: Number(s.NumSteps) || 0,
    updated: Date.parse(s.UpdatedAt) || 0,
    cwds: (s.WorkspaceURIs ?? []).map((u) => { try { return decodeURIComponent(String(u).replace(/^file:\/\//, "")); } catch { return null; } }).filter(Boolean),
  }));
  return { list: list.sort((a, b) => b.updated - a.updated), last: last && typeof last === "object" ? last : {} };
}

// The terminal's conversation: the folder's newest (as agy names it), else the newest there.
// `sure` only when no other agy terminal shares the folder: Restart resumes one it is sure of.
export function pickAgy({ list, last }, cwd, sharing = 1) {
  const here = list.filter((c) => c.cwds.includes(cwd));
  const named = last?.[cwd] ? here.find((c) => c.id === last[cwd]) ?? (ID.test(last[cwd]) ? { id: last[cwd], title: "", steps: 0, updated: 0, cwds: [cwd] } : null) : null;
  const c = named ?? here[0] ?? null;
  return c ? { ...c, sure: sharing <= 1 } : null;
}

// Turn rows after `since` (their idx), oldest first, read-only (agy may be writing it):
// [{ idx, ...parseAgyTurn }] for the rows that read.
export function parseAgyRows(out) {
  return (out ?? "").split("\n").map((l) => { const [i, h] = l.trim().split("|"); const t = parseAgyTurn(h); return t && /^\d+$/.test(i) ? { idx: Number(i), ...t } : null; }).filter(Boolean);
}
// Adds turn rows to a conversation's state: the newest gives the context, every row its tokens.
export function addAgyRows(st, rows) {
  for (const r of rows) {
    st.context = r.context; st.window = r.window;
    st.calls = (st.calls ?? 0) + 1;
    st.totals = { input: (st.totals?.input ?? 0) + r.input, output: (st.totals?.output ?? 0) + r.output, cacheRead: (st.totals?.cacheRead ?? 0) + r.cacheRead };
    st.since = r.idx;
  }
  return st;
}
export async function readAgy(id, since = -1) {
  if (!ID.test(id ?? "")) return [];
  const sql = `select idx, hex(data) from gen_metadata where idx > ${Number(since) | 0} and length(data) between 1 and 20000 order by idx`;
  // While agy has it open (its -wal file is there) a read-only open sees the newest; once it's
  // closed, read-only needs the file opened as immutable (it can't make the -shm file).
  const script = 'if [ -f "$1-wal" ]; then exec sqlite3 -readonly "$1" "$2"; else exec sqlite3 "file:$1?mode=ro&immutable=1" "$2"; fi';
  const r = await exec("sh", ["-c", script, "sh", `${DIR()}/conversations/${id}.db`, sql], { timeout: 10000 }).catch(() => null);
  return parseAgyRows(r?.code === 0 ? r.stdout : "");
}

// agy's footer line, from the bottom of a screen: { model, effort } (either may be null).
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export function parseAgyFooter(screen) {
  const lines = (screen ?? "").split("\n").slice(-6).reverse();
  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/).at(-1)?.split(" · ").map((s) => s.trim()) ?? [];
    const i = parts.findIndex((s) => /^(Gemini|Claude|GPT|Orchestrator)\b/.test(s));
    if (i >= 0) return { model: parts[i], effort: EFFORTS.has(parts[i + 1]) ? parts[i + 1] : null };
  }
  return { model: null, effort: null };
}
// For the pill: the model's last word that isn't a number ("Gemini 4 Neon" → "Neon").
export function agyShort(name) {
  const words = String(name ?? "").replace(/\(.*?\)/g, "").split(/\s+/).filter((w) => w && !/\d/.test(w));
  return words.length > 1 ? words.at(-1) : words[0] ?? "Antigravity";
}

// What the menu shows, as plain data (the Codex menu's shape: statsMenu draws both).
export function agySnapshot(c) {
  const st = c.st;
  return { kind: "codex", app: "antigravity", title: c.title || "Antigravity", model: st.model ?? null, modelText: st.model ?? "Antigravity",
    effort: st.effort ?? null, context: st.context ?? 0, window: st.window ?? 0, session: c.id,
    calls: st.calls ?? null, totals: st.totals ?? null, started: c.started ?? null };
}

const read = async (t) => (await hc(["read", t]).catch(() => null))?.stdout ?? "";

// The conversation a terminal's agy has open: it holds brain/<id> open (lsof). For two agy
// terminals in one folder, where the folder alone can't tell them apart.
export const heldAgyId = (lsofOut) => /\/antigravity-cli\/brain\/([0-9a-f-]{36})$/m.exec(lsofOut ?? "")?.[1] ?? null;
async function heldAgy(t) {
  const g = await get(t), pid = g?.foreground?.pid;
  if (!pid || !inFront(g)) return null;
  const r = await exec("lsof", ["-nP", "-Fn", "-p", String(pid)], { timeout: 5000 }).catch(() => null);
  return heldAgyId((r?.stdout ?? "").split("\n").map((l) => l.replace(/^n/, "")).join("\n"));
}

// Each tick: every agy agent here gets its conversation, its numbers and its footer.
const LIST_EVERY = 15000, IDLE_EVERY = 20000;
export async function refreshAgy(v, mine, all) {
  v.agy ??= new Map();
  if (!mine.length) { const had = v.agy.size > 0; v.agy.clear(); return had; }
  const now = Date.now();
  if (!v.agyList || now - (v.agyListAt ?? 0) > LIST_EVERY) {
    // cat, not readTextFile: a mod reads files outside its own folders through a program.
    const cat = async (f) => { const r = await exec("cat", [`${DIR()}/cache/${f}`], { timeout: 5000 }).catch(() => null); return r?.code === 0 ? r.stdout : null; };
    const [meta, last] = await Promise.all([cat("conversation_metadata.json"), cat("last_conversations.json")]);
    v.agyList = parseAgyConversations(meta, last); v.agyListAt = now;
  }
  const cwd = new Map(all.map((t) => [t.address, t.cwd]));
  const sharing = new Map();
  for (const a of mine) sharing.set(cwd.get(a.address), (sharing.get(cwd.get(a.address)) ?? 0) + 1);
  let changed = false;
  const seen = new Set();
  for (const a of mine) {
    seen.add(a.address);
    let s = pickAgy(v.agyList, cwd.get(a.address), sharing.get(cwd.get(a.address)));
    if (s && !s.sure) {
      const held = await heldAgy(a.address);
      if (held) s = { ...(v.agyList.list.find((x) => x.id === held) ?? { id: held, title: "", cwds: [] }), sure: true };
    }
    let c = v.agy.get(a.address);
    if (!s) { if (c) { v.agy.delete(a.address); changed = true; } continue; }
    if (!c || c.id !== s.id) { c = { id: s.id, cwd: cwd.get(a.address), sure: s.sure, title: s.title, st: {}, read: 0, started: await startedOf(a.address) }; v.agy.set(a.address, c); changed = true; }
    if (c.sure !== s.sure || c.title !== s.title) { c.sure = s.sure; c.title = s.title; changed = true; }
    if (c.read && a.status !== "working" && now - c.read < IDLE_EVERY) continue;
    c.read = now;
    const before = JSON.stringify(c.st);
    addAgyRows(c.st, await readAgy(c.id, c.st.since ?? -1));
    const foot = parseAgyFooter(await read(a.address));
    if (foot.model) c.st.model = foot.model;
    if (foot.model) c.st.effort = foot.effort;
    if (JSON.stringify(c.st) !== before) changed = true;
  }
  for (const k of [...v.agy.keys()]) if (!seen.has(k)) { v.agy.delete(k); changed = true; }
  return changed;
}

// Restart -----------------------------------------------------------------------------------

// agy's options by what follows them (`agy --help`, 1.5). A first prompt (-p, -i) and a session
// choice (-c, --conversation) are dropped: the script names the conversation itself.
const ONE = new Set(["--add-dir", "--agent", "--effort", "--mode", "--model", "--project", "--settings", "--log-file"]);
const NONE = new Set(["--dangerously-skip-permissions", "--sandbox", "--remote-control", "--new-project", "--disable-slash-commands"]);
const DROP_ONE = new Set(["--conversation", "-p", "--print", "--prompt", "-i", "--prompt-interactive", "--output-format", "--input-format", "--json-schema", "--print-timeout"]);
const DROP = new Set(["-c", "--continue"]);
export function agyResumeArgs(args, id) {
  const keep = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (DROP.has(x)) continue;
    const eq = /^(--[\w-]+)=(.*)$/s.exec(x);
    const name = eq ? eq[1] : x;
    if (DROP_ONE.has(name)) { if (!eq) i++; continue; }
    if (ONE.has(name)) { if (eq) keep.push(x); else { if (i + 1 >= args.length) throw new Error(`${x} has no value`); keep.push(x, args[++i]); } continue; }
    if (NONE.has(x)) { keep.push(x); continue; }
    if (x === "--remote-agent") throw new Error("A remote-agent session");
    if (/^-/.test(x)) throw new Error(`Unknown agy option ${x}`);
    throw new Error("agy was started with a subcommand or prompt");
  }
  return [...keep, "--conversation", id];
}

export function agyScript(cwd, args) {
  return [
    "# herdr-ranch: resume an Antigravity conversation (written by the Agents list)",
    `cd ${q(cwd)} || exit 1`,
    `exec agy ${args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

// agy's prompt line ("> …", between two rules), from the bottom of a screen.
export function agyPrompt(screen) {
  const lines = (screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const m = /^>[  ]?(.*)$/.exec(lines[i]); if (m) return m[1].trimEnd(); }
  return null;
}
// What agy prints as it quits: "agy --conversation=<id>".
export const resumedAgyId = (screen) => [...(screen ?? "").matchAll(/agy --conversation[= ]([0-9a-f-]{36})/g)].at(-1)?.[1] ?? null;
const busy = (screen) => /esc to (interrupt|cancel)/i.test((screen ?? "").split("\n").slice(-8).join("\n"));

const get = async (t) => { const r = await hc(["get", t, "--json"]).catch(() => null); try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
const keys = (t, ks) => hc(["keys", t, ...ks]);
const inFront = (g) => /(^|\/)agy$/.test(g?.foreground?.argv?.[0] ?? "") || g?.foreground?.name === "agy";

// Restarts terminal `t`'s agy on conversation `session` ({ id, cwd, sure }). Null when done, else why not.
export async function restartAgy(t, session, cx) {
  let g = await get(t);
  if (!g || !inFront(g)) return "Antigravity isn't in front in that terminal.";
  if (g.status?.state === "working") return "It's working: try again when it's done.";
  const { id, cwd } = session ?? {};
  if (!ID.test(id ?? "") || !cwd) return "Couldn't tell which conversation it is: restart it by hand.";
  if (!session.sure) return "Another Antigravity terminal shares its folder, so which conversation is its own isn't certain: restart it by hand.";
  if (String(g.pid) === String(g.foreground.pid)) return "agy is the terminal's own program, with no shell behind it: restart it by hand.";
  let args;
  try { args = agyResumeArgs(g.foreground.argv.slice(1), id); } catch (e) { return `${e.message}: restart it by hand.`; }
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/revive-agy-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return "The script's path can't be typed into the terminal.";
  await exec("mkdir", ["-p", dir]);
  const write = async (a) => writeTextFile(path, agyScript(cwd, a), await readTextFile(path).catch(() => null));
  await write(args);

  // From here on the terminal is touched: look before each key.
  const screen = await read(t);
  if (busy(screen)) return "It's working: try again when it's done.";
  // An empty prompt can show a placeholder ("Auto mode: …"): a typed x shows alone only when
  // nothing was drafted.
  await keys(t, ["x"]);
  let typed = null;
  for (let i = 0; i < 12 && typed !== "x"; i++) { await cx.sleep(200); typed = agyPrompt(await read(t)); }
  await keys(t, ["backspace"]);
  if (typed !== "x") return "It has an unsent message in its prompt: send or clear it first.";
  await cx.sleep(200);
  await keys(t, ["ctrl+d"]);
  await cx.sleep(300);
  await keys(t, ["ctrl+d"]);
  let out = false;
  for (let i = 0; i < 20 && !out; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (g && g.state !== "live") return "The terminal ended when agy quit.";
    out = Boolean(g?.foreground) && !inFront(g);
  }
  if (!out) return "agy didn't quit: check the terminal.";
  // agy names the conversation as it quits ("agy --conversation=<id>"): trust that over the folder.
  const said = resumedAgyId(await read(t));
  if (said && said !== id) await write([...args.slice(0, -1), said]);
  const started = Date.now();
  await keys(t, [...line, "enter"]);
  for (let i = 0; i < 40; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (inFront(g) && g.status?.app && (g.status_ms ?? 0) >= started) return null;
  }
  return "agy started again but isn't reporting yet: check the terminal.";
}

export function restartAgyAgent(v, a, cx, notify) {
  if (v.reviving.has(a.address)) return;
  const session = v.agy?.get(a.address) ?? null;
  v.reviving.add(a.address);
  cx.notify();
  cx.spawn(async (cx) => {
    let why;
    try { why = await restartAgy(a.address, session, cx); } catch (e) { why = String(e?.message ?? e); }
    v.reviving.delete(a.address);
    const name = a.space_name ?? a.name ?? "the agent";
    notify(why ? { title: `Couldn't restart ${name}`, body: why, level: "warning" } : { title: `Restarted ${name}`, level: "success", timeout: 3000 });
    cx.notify();
  });
}
