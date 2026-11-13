// Claude Code's own records of a session, read from its config folder (~/.claude, or an account's
// CLAUDE_CONFIG_DIR set up in Spaces; read only, this computer only):
//   sessions/<pid>.json                  pid, sessionId, cwd, startedAt, status of each live session
//   projects/<cwd, non-alphanumerics as ->/<sessionId>.jsonl
//                                        the conversation, one JSON record per line
//   projects/…/<sessionId>/subagents/agent-<id>.meta.json
//                                        each subagent: agentType, description, toolUseId, finished?
// These files are Claude Code's internals, not an API: everything here reads what it finds and
// leaves out what doesn't fit, so a changed format shows less, never something wrong.
// The parsing is plain functions, tested in tests/agents.test.mjs.

import { exec } from "herdr";

export const projectDir = (configDir, cwd) => `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9-]/g, "-")}`;
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const sh = (script) => exec("sh", ["-c", script]).then((r) => (r.code === 0 ? r.stdout : "")).catch(() => "");

// The live sessions (sessions/*.json) in each config folder, each with its `configDir`.
export async function liveSessions(dirs) {
  const out = await Promise.all(dirs.map(async (d) => parseJsonLines(await sh(`for f in ${q(d)}/sessions/*.json; do [ -f "$f" ] && tr -d "\\n" < "$f" && echo; done`)).map((s) => ({ ...s, configDir: d }))));
  return out.flat();
}

// The config folders to look in: the usual one and every account's (shared "ranch-accounts").
export function configDirs(home, store) {
  const ex = (p) => (p?.startsWith("~") ? home + p.slice(1) : p);
  return [...new Set([`${home}/.claude`, ...((store?.accounts ?? []).map((a) => ex(a.claudeDir)).filter((p) => p && p.startsWith("/")))])];
}

export function parseJsonLines(text) {
  const out = [];
  for (const l of (text ?? "").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a line cut short */ } }
  return out;
}

// The session a Herdr agent runs: same folder; several there, the one whose title is the agent's.
export function pickSession(candidates, title) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const t = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return candidates.find((c) => c.title && c.title === t) ?? candidates.find((c) => c.name === t) ?? null;
}

export const emptyState = () => ({
  model: null, requested: null, effort: null, mode: null, title: null, context: 0, lastAt: null,
  usage: new Map(), // message id -> { input, cacheRead, cacheWrite, output }
  creating: new Map(), // TaskCreate call id -> subject, until its result names the task's number
  tasks: new Map(), // task number -> { id, subject, status }
  agents: new Map(), // Agent call id -> { id, description, type, background, done }
  cost: null, // the last cost-state record: { usd, linesAdded, linesRemoved }
});

const usageOf = (u) => u && { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };

// Folds conversation records into `st` (see emptyState). Unknown records are skipped.
export function apply(st, records) {
  for (const d of records) {
    const t = d?.type;
    if (t === "ai-title" && d.aiTitle) st.title = d.aiTitle;
    else if (t === "custom-title" && d.customTitle) st.title = d.customTitle;
    else if (t === "mode" && d.mode) st.mode = d.mode;
    else if (t === "cost-state") st.cost = { usd: d.totalCostUSD ?? null, linesAdded: d.totalLinesAdded ?? null, linesRemoved: d.totalLinesRemoved ?? null };
    if (d?.timestamp) st.lastAt = d.timestamp;
    const m = d?.message;
    if (t === "assistant" && m && !d.isSidechain) {
      if (m.model && m.model !== "<synthetic>") st.model = m.model;
      if (d.requestedModel) st.requested = d.requestedModel;
      if (d.effort) st.effort = d.effort;
      const u = usageOf(m.usage);
      if (u && m.id) { st.usage.set(m.id, u); st.context = u.input + u.cacheRead + u.cacheWrite; }
    }
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content) {
      if (c?.type === "tool_use") {
        const i = c.input ?? {};
        if (c.name === "TaskCreate") st.creating.set(c.id, i.subject ?? "");
        else if (c.name === "TaskUpdate" && i.taskId != null) {
          const task = st.tasks.get(String(i.taskId));
          if (i.status === "deleted") st.tasks.delete(String(i.taskId));
          else if (task) Object.assign(task, i.status ? { status: i.status } : {}, i.subject ? { subject: i.subject } : {});
        } else if ((c.name === "Agent" || c.name === "Task") && !st.agents.has(c.id)) {
          st.agents.set(c.id, { id: c.id, description: i.description ?? "", type: i.subagent_type ?? "general-purpose", background: Boolean(i.run_in_background), done: false });
        }
      } else if (c?.type === "tool_result") {
        const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? "").join("") : "";
        if (st.creating.has(c.tool_use_id)) {
          const n = /Task #(\d+)/.exec(text)?.[1];
          if (n) st.tasks.set(n, { id: n, subject: st.creating.get(c.tool_use_id), status: "pending" });
          st.creating.delete(c.tool_use_id);
        }
        // A foreground subagent is done when its call returns; a background one says so in its meta.
        const a = st.agents.get(c.tool_use_id);
        if (a && !a.background) a.done = true;
      }
    }
  }
  return st;
}

// Session totals: tokens over every reply (each counted once), and the context in use now.
export function totals(st) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, replies: st.usage.size };
  for (const u of st.usage.values()) for (const k of ["input", "cacheRead", "cacheWrite", "output"]) sum[k] += u[k];
  return sum;
}

// The context window: 1M when the model was asked for with [1m], else 200k.
export const windowOf = (st) => (/\[1m\]/i.test(`${st.requested ?? ""} ${st.model ?? ""}`) ? 1_000_000 : 200_000);

// "1.2M", "45.3k", "812".
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));

// Reads a conversation the first time: only the lines that matter (titles, mode, cost, task and
// subagent calls and their results), every reply's usage, and the newest reply; then where the
// file ends, so the next read takes only what was added.
export async function firstRead(file) {
  const f = q(file);
  const out = await sh(`
    [ -f ${f} ] || exit 0
    printf 'SIZE\\t%s\\n' "$(wc -c < ${f} | tr -d ' ')"
    echo 'LINES'
    grep -E '"type":"(ai-title|custom-title|mode|cost-state)"|"name":"(TaskCreate|TaskUpdate|Agent|Task)"|Task #[0-9]+ created' ${f}
    echo 'LAST'
    tail -c 2000000 ${f} | grep '"type":"assistant"' | tail -n 1
    echo 'USAGE'
    grep -o -E '"id":"msg_[A-Za-z0-9]+"|"usage":\\{"input_tokens":[0-9]+,"cache_creation_input_tokens":[0-9]+,"cache_read_input_tokens":[0-9]+,"output_tokens":[0-9]+' ${f}
  `);
  return parseFirstRead(out);
}

export function parseFirstRead(out) {
  const st = emptyState();
  let size = 0, part = "", lines = [], last = [], usage = [];
  for (const l of (out ?? "").split("\n")) {
    if (l.startsWith("SIZE\t")) { size = Number(l.slice(5)) || 0; continue; }
    if (l === "LINES" || l === "LAST" || l === "USAGE") { part = l; continue; }
    if (part === "LINES") lines.push(l); else if (part === "LAST") last.push(l); else if (part === "USAGE") usage.push(l);
  }
  apply(st, parseJsonLines(lines.join("\n")));
  apply(st, parseJsonLines(last.join("\n")));
  // Usage pairs: a reply's id, then its usage.
  let id = null;
  for (const l of usage) {
    const m = /^"id":"(msg_[A-Za-z0-9]+)"$/.exec(l);
    if (m) { id = m[1]; continue; }
    const u = /"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+),"output_tokens":(\d+)/.exec(l);
    if (u && id) { st.usage.set(id, { input: +u[1], cacheWrite: +u[2], cacheRead: +u[3], output: +u[4] }); id = null; }
  }
  return { st, size };
}

// What was added since `offset`: whole lines only (a line still being written waits).
export async function readSince(file, offset) {
  const out = await sh(`f=${q(file)}; [ -f "$f" ] || exit 0; s=$(wc -c < "$f" | tr -d ' '); printf 'SIZE\\t%s\\n' "$s"; [ "$s" -gt ${Number(offset) || 0} ] && tail -c +${(Number(offset) || 0) + 1} "$f" | head -c $(( s - ${Number(offset) || 0} ))`);
  const nl = out.indexOf("\n");
  const size = Number(out.slice(5, nl)) || 0;
  const body = out.slice(nl + 1);
  const end = body.lastIndexOf("\n");
  if (end < 0) return { records: [], offset };
  // Byte offsets: the text is UTF-8, so count the bytes of what was used.
  const used = body.slice(0, end + 1);
  return { records: parseJsonLines(used), offset: offset + utf8Length(used), size };
}

export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

// The session's subagents, newest first (at most `max`): meta.json, and whether the call that
// started each one has returned (a foreground one is done then).
export async function subagents(dir, file, max = 8) {
  const out = await sh(`d=${q(dir)}/subagents; [ -d "$d" ] || exit 0; ls -t "$d"/*.meta.json 2>/dev/null | head -n ${max} | while read -r m; do tr -d '\\n' < "$m"; echo; done`);
  const metas = parseJsonLines(out);
  const ids = metas.map((m) => m.toolUseId).filter((x) => /^[A-Za-z0-9_]+$/.test(x ?? ""));
  let returned = new Set();
  if (ids.length) {
    const r = await sh(`grep -o -F ${ids.map((i) => `-e ${q(`"tool_use_id":"${i}"`)}`).join(" ")} ${q(file)} | sort -u`);
    returned = new Set([...r.matchAll(/"tool_use_id":"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  }
  return metas.map((m) => subagentOf(m, returned));
}

export function subagentOf(m, returned) {
  const background = m.requestShape === "background";
  const done = typeof m.finished === "boolean" ? m.finished : !background && returned.has(m.toolUseId);
  return { id: m.toolUseId ?? m.description, type: m.agentType ?? "agent", description: m.description ?? "", background, done };
}

// The tasks in order, and "n of m" done.
export function taskList(st) {
  const list = [...st.tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return { list, done: list.filter((t) => t.status === "completed").length, active: list.find((t) => t.status === "in_progress") ?? null };
}
