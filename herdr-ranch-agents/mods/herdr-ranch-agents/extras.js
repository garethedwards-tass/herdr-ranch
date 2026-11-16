// What Herdr Ranch adds to Herdr's agents list (main.js is a copy of Herdr's own `agents` mod,
// changed only where it calls into this file; RECIPE.md lists those places): for each Claude Code
// agent on this computer, its context in use (a chip that opens a popup of stats), its task list
// and its running subagents, read from Claude Code's own files (claude.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { openOverlay, closeOverlay, agents, terminals, home, shared, panes, spaces } from "herdr";
import { bringBack } from "./revive.js";
import { liveSessions, configDirs, pickSession, projectDir, firstRead, readSince, subagents, apply, totals, windowOf, tokens, taskList } from "./claude.js";

export const MOD = "herdr-ranch-agents";
const SPIN = "mods/workspace-chrome/spinner.svg";
const TICK = 4000, SESSIONS_EVERY = 15000, IDLE_EVERY = 20000;
const TASK_GLYPH = { completed: "☑", in_progress: "◐", pending: "☐" };

// Herdr's agents() lists only terminals whose agent is reporting a status right now. An agent that
// stopped reporting (Claude Code can go quiet mid-session) would drop off while it still runs.
// liveAgents() keeps it, from its pane: the list and the watcher both use it, so a quiet agent keeps
// its row, chip, tasks and subagents. Its status is the terminal's own word (error counts as
// blocked), "unknown" when it has none. agents()' order is kept; a quiet one goes after the last
// agent of its tab, else of its space or the spaces before it. Pass the snapshots the caller
// already read (each host read copies a whole list).
const WORD = { error: "blocked" };
const STATUSES = new Set(["blocked", "done", "working", "idle"]);
export function liveAgents(list, all = terminals(), ps = panes(), sp = spaces()) {
  const have = new Set(list.map((a) => a.address));
  const tabs = new Map(sp.flatMap((s) => s.tabs.map((tb) => [tb.id, { s, tb }])));
  const spaceAt = new Map(sp.map((s, i) => [s.id, i]));
  const term = new Map(all.map((x) => [x.address, x]));
  const out = [...list];
  for (const p of ps) {
    if (!p.terminal || p.status || have.has(p.terminal) || !tabs.has(p.tab) || !(p.program?.agent || p.app)) continue;
    have.add(p.terminal); // a terminal in two panes: one row
    const { s, tb } = tabs.get(p.tab), x = term.get(p.terminal);
    const word = WORD[x?.status] ?? x?.status;
    const q = { address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: tb.id, tab_index: tb.index, tab_name: tb.name,
      status: STATUSES.has(word) ? word : "unknown", app: p.app, program: p.program, title: p.title, seq: 0,
      pinned: Boolean(x?.labels?.["herdr.pinned"]), focused: p.focused, quiet: true };
    const si = spaceAt.get(s.id);
    let at = -1;
    out.forEach((a, i) => { const ai = spaceAt.get(a.space); if (ai !== undefined && (ai < si || (ai === si && a.tab_index <= q.tab_index))) at = i; });
    out.splice(at + 1, 0, q);
  }
  return out;
}

const isClaude = (a) => (a.app === "claude-code" || a.program?.key === "claude") && !a.address.includes("/");

// The watcher: every few seconds, for each Claude Code agent here, what was added to its session.
export function start(v, cx) {
  v.claude = new Map(); // agent address -> { id, file, dir, st, offset, subs, read, started }
  v.openTasks = new Set();
  v.reviving = new Set(); // agents being brought back (revive.js)
  v.sessions = []; v.sessionsAt = 0;
  const tick = (cx) => {
    if (v.reading) return;
    v.reading = true;
    cx.spawn(async (cx) => {
      try { if (await refresh(v)) cx.notify(); } catch { /* next tick */ }
      v.reading = false;
    });
  };
  tick(cx);
  cx.timer.every(TICK, tick);
}

async function refresh(v) {
  const now = Date.now();
  const all = terminals();
  const mine = liveAgents(agents(), all).filter(isClaude);
  if (!mine.length) { const had = v.claude.size > 0; v.claude.clear(); return had; }
  if (now - v.sessionsAt > SESSIONS_EVERY) { v.sessions = await liveSessions(configDirs(home(), shared("ranch-accounts"))); v.sessionsAt = now; }
  const cwd = new Map(all.map((t) => [t.address, t.cwd]));
  let changed = false;
  const seen = new Set();
  for (const a of mine) {
    seen.add(a.address);
    const at = cwd.get(a.address);
    const candidates = v.sessions.filter((s) => s.cwd === at).map((s) => ({ ...s, title: [...v.claude.values()].find((c) => c.id === s.sessionId)?.st.title }));
    const s = pickSession(candidates, a.title);
    let c = v.claude.get(a.address);
    if (!s) { if (c) { v.claude.delete(a.address); changed = true; } continue; }
    if (!c || c.id !== s.sessionId) {
      const dir = `${projectDir(s.configDir, s.cwd)}/${s.sessionId}`, file = `${dir}.jsonl`;
      const { st, size } = await firstRead(file);
      c = { id: s.sessionId, file, dir, st, offset: size, subs: [], read: now, started: s.startedAt ?? null };
      c.subs = await subagents(dir, file);
      v.claude.set(a.address, c);
      changed = true;
      continue;
    }
    // Working: every tick; otherwise now and then.
    if (a.status !== "working" && now - c.read < IDLE_EVERY) continue;
    c.read = now;
    const more = await readSince(c.file, c.offset);
    if (more.records.length) { apply(c.st, more.records); c.offset = more.offset; changed = true; }
    const subs = await subagents(c.dir, c.file);
    if (JSON.stringify(subs) !== JSON.stringify(c.subs)) { c.subs = subs; changed = true; }
  }
  for (const k of [...v.claude.keys()]) if (!seen.has(k)) { v.claude.delete(k); changed = true; }
  return changed;
}

// What the popup shows, as plain data (the popup is a copy of its own and can't read the list's state).
export function snapshot(c) {
  const st = c.st, tot = totals(st), win = Math.max(windowOf(st), st.context > 200_000 ? 1_000_000 : 0), tl = taskList(st);
  return {
    title: st.title, model: st.model, effort: st.effort, mode: st.mode, context: st.context, window: win, guessed: !/\[1m\]/i.test(`${st.requested ?? ""}`),
    replies: tot.replies, output: tot.output, input: tot.input + tot.cacheWrite, cacheRead: tot.cacheRead, cost: st.cost, started: c.started,
    tasks: tl.list.map((t) => [t.status, t.subject]), tasksDone: tl.done,
    subs: c.subs.map((s) => [s.type, s.description, s.done]), session: c.id,
  };
}

const pct = (c) => Math.round((100 * c.st.context) / Math.max(windowOf(c.st), c.st.context > 200_000 ? 1_000_000 : 0));
const tone = (t, p) => (p >= 85 ? t.ansi1 : p >= 60 ? t.ansi3 : t.dim);

// The chip on a Claude Code row: context in use, a click opens the stats popup.
export function statsChip(v, a, t) {
  const c = v.claude?.get(a.address);
  if (!c?.st.context) return null;
  const p = pct(c);
  return div().id(`stats-${a.address}`).flex_none().px(4).rounded(4).text_size(10.5).text_color(tone(t, p)).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`${tokens(c.st.context)} in context (${p}%). Click for usage, model and tasks`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 320, height: 460, props: { stats: snapshot(c) } }); })
    .child(`${p}%`);
}

// On an agent that stopped reporting its status: a warning that says so and, for Claude Code here,
// a click that brings it back (revive.js). Herdr's own lists and next/previous agent skip it.
export function quietMark(v, a, t) {
  if (!a.quiet) return null;
  const busy = v.reviving?.has(a.address), can = isClaude(a);
  return h_flex().id(`quiet-${a.address}`).flex_none().gap(4).items_center().px(5).h(18).rounded(4)
    .border_1().border_color(t.ansi3 + "66").bg(t.ansi3 + "1a").text_size(12).text_color(t.ansi3)
    .tooltip(busy ? "Bringing it back…" : `Not reporting its status to Herdr: Herdr's own lists and next/previous agent skip it.${can ? "\nClick to bring it back: stops its background session and resumes the conversation." : ""}`)
    .when(can && !busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.ansi3 + "33"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); bringBack(v, a, cx); }))
    .child(busy ? svg(SPIN).size(11).flex_none().spin(900) : div().flex_none().font_semibold().child("!"))
    .child(busy ? "Restarting" : can ? "Bring back" : "Quiet");
}

// Rows under a Claude Code agent: its tasks (a summary that unfolds them) and its running subagents.
export function claudeRows(v, a, t) {
  const c = v.claude?.get(a.address);
  if (!c) return [];
  const out = [];
  const tl = taskList(c.st);
  const row = (id) => h_flex().id(id).pl(39).pr(8).h(24).flex_none().gap(6).items_center().rounded(8).text_size(12).text_color(t.muted);
  if (tl.list.length) {
    const open = v.openTasks.has(a.address);
    out.push(row(`tasks-${a.address}`).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { open ? v.openTasks.delete(a.address) : v.openTasks.add(a.address); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
      .child(div().flex_none().text_color(tl.done === tl.list.length ? t.ansi2 : t.dim).child(`${tl.done}/${tl.list.length}`))
      .child(div().flex_1().min_w(0).truncate().child(tl.active ? tl.active.subject : tl.done === tl.list.length ? "All tasks done" : "Tasks")));
    if (open) for (const task of tl.list.slice(0, 30)) {
      out.push(row(`task-${a.address}-${task.id}`).pl(52)
        .child(div().flex_none().w(12).text_color(task.status === "completed" ? t.ansi2 : task.status === "in_progress" ? t.working ?? t.accent : t.dim).child(TASK_GLYPH[task.status] ?? "☐"))
        .child(div().flex_1().min_w(0).truncate().text_color(task.status === "completed" ? t.dim : t.muted).child(task.subject)));
    }
  }
  for (const s of c.subs.filter((x) => !x.done).slice(0, 6)) {
    out.push(row(`subagent-${a.address}-${s.id}`)
      .child(svg(SPIN).size(11).flex_none().text_color(t.working ?? t.accent).spin(900))
      .child(div().flex_none().text_color(t.dim).child(s.type))
      .child(div().flex_1().min_w(0).truncate().child(s.description)));
  }
  return out;
}

const NAMES = { "claude-opus": "Opus", "claude-sonnet": "Sonnet", "claude-haiku": "Haiku", "claude-fable": "Fable" };
// "claude-opus-5-5" -> "Opus 5.5" (anything else as it is).
export function modelName(id) {
  const m = /^(claude-[a-z]+)-(\d+)-(\d+)/.exec(id ?? "");
  return m && NAMES[m[1]] ? `${NAMES[m[1]]} ${m[2]}.${m[3]}${/\[1m\]/i.test(id) ? " (1M)" : ""}` : id ?? "?";
}
const since = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`; };

// The stats popup (the list opened as a popup with props { stats: snapshot() }).
export function statsView(p, t) {
  const s = p.stats, used = Math.min(1, s.context / s.window);
  const line = (label, value, color) => h_flex().h(22).gap(8).items_center().child(div().w(96).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().text_color(color ?? t.foreground).child(value));
  const head = (text) => div().pt(8).pb(2).text_size(11).text_color(t.muted).child(text);
  return v_flex().id("agent-stats").w_full().p(12).gap(1).bg(t.popover).text_size(12.5)
    .on_key_down((e) => { if (e.key === "escape") closeOverlay(p.overlay); })
    .child(div().font_semibold().truncate().text_color(t.foreground).child(s.title ?? "Claude Code"))
    .child(line("Model", `${modelName(s.model)}${s.effort ? ` · ${s.effort} effort` : ""}`))
    .when(Boolean(s.mode) && s.mode !== "normal", (el) => el.child(line("Mode", s.mode)))
    .child(line("Context", `${tokens(s.context)} of ${s.guessed ? "~" : ""}${tokens(s.window)} (${Math.round(used * 100)}%)`, tone(t, used * 100)))
    .child(div().h(5).w_full().rounded(3).bg(t.hover).child(div().h(5).rounded(3).w(Math.max(4, Math.round(296 * used))).bg(used >= 0.85 ? t.ansi1 : used >= 0.6 ? t.ansi3 : t.accent)))
    .child(head("This conversation"))
    .child(line("Replies", String(s.replies)))
    .child(line("Output", `${tokens(s.output)} tokens`))
    .child(line("Input", `${tokens(s.input)} new · ${tokens(s.cacheRead)} from cache`))
    .when(Boolean(s.cost?.usd), (el) => el.child(line("Cost", `$${s.cost.usd.toFixed(2)} (at its last save)`)))
    .when(s.cost?.linesAdded != null, (el) => el.child(line("Lines", `+${s.cost.linesAdded} −${s.cost.linesRemoved ?? 0}`)))
    .when(Boolean(s.started), (el) => el.child(line("Running for", since(s.started))))
    .when(s.tasks.length > 0, (el) => el.child(head(`Tasks · ${s.tasksDone}/${s.tasks.length} done`))
      .children(s.tasks.slice(0, 8).map(([st, subject], i) => h_flex().id(`st-task-${i}`).h(20).gap(6).items_center()
        .child(div().w(12).flex_none().text_color(st === "completed" ? t.ansi2 : st === "in_progress" ? t.accent : t.dim).child(TASK_GLYPH[st] ?? "☐"))
        .child(div().flex_1().min_w(0).truncate().text_color(st === "completed" ? t.dim : t.foreground).child(subject)))))
    .when(s.subs.length > 0, (el) => el.child(head(`Subagents · ${s.subs.filter((x) => !x[2]).length} running`))
      .children(s.subs.slice(0, 6).map(([type, desc, done], i) => h_flex().id(`st-sub-${i}`).h(20).gap(6).items_center()
        .child(div().flex_none().text_color(done ? t.dim : t.accent).child(done ? "✓" : "●"))
        .child(div().flex_none().text_color(t.dim).child(type))
        .child(div().flex_1().min_w(0).truncate().text_color(done ? t.dim : t.foreground).child(desc)))))
    .child(div().pt(8).text_size(10.5).text_color(t.dim).child(`From Claude Code's files in ~/.claude. ${s.guessed ? "The window size is an estimate." : ""}`));
}
