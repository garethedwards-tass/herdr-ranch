// History: the git commit history of the repository you're looking at (the focused terminal's
// folder, on its space's machine), newest first, with branch and tag names. A click opens a
// commit: its message and its files as diffs, unified or split. The mod-buttons tab bar gives
// it a History button (mod.json `button`). Read only: it runs `git log` and `git show`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, focused, spaces } from "herdr";
import { repoOf, tip, log, show, search, me, LOG } from "./git.js";
import { FIRST_LINES, MORE_LINES } from "./diff.js";
import { filesTab } from "./files-tab.js";
import { highlightFiles } from "./highlight.js";
import { fs, readSizes, kit, segmented, REFRESH_ICON, writeRefreshIcon } from "./ui.js";

const MONO = "Menlo", SPINNER = "mods/workspace-chrome/spinner.svg";
const WIDE = 720, WEEK = 7 * 24 * 3600 * 1000;
// Every typed word must match somewhere; a word with a capital matches case-sensitively (as in
// Herdr Ranch's lists). Words with a prefix (author:, path:...) are git's alone.
const words = (q) => q.split(/\s+/).filter((w) => w && !/^\w+:/.test(w));
const hay = (c) => { const raw = `${c.short} ${c.sha} ${c.title} ${c.author} ${c.refs.join(" ")}`; return { raw, lower: raw.toLowerCase() }; };
const matches = (h, ws) => ws.every((w) => (/[A-Z]/.test(w) ? h.raw : h.lower).includes(w));
const dayOf = (iso) => (iso ?? "").slice(0, 10);
function dayLabel(day) {
  const today = new Date(), d = new Date(`${day}T12:00:00`);
  const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (day === key(today)) return "Today";
  if (day === key(y)) return "Yesterday";
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
const OPEN_LINES = 800, ALL_LINES = 2500;
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this session only */ } };

function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return "";
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
}

export default class History extends View {
  init(_props, cx) {
    writeRefreshIcon().then(() => cx.notify()).catch(() => null);
    this.repo = null; this.commits = null; this.error = null; this.loading = false;
    this.scope = load("scope", "head"); this.mode = load("diff-mode", "unified");
    this.open = null; this.detail = new Map(); this.fileOpen = new Map(); this.fileLimit = new Map();
    this.cursor = 0; this.query = ""; this.filter = null; this.width = Number(load("width", "0")) || 0; this.keys = false;
    this.handle = cx.focus_handle();
    // Typing filters the loaded commits at once; a pause searches the whole history with git.
    this.found = null; this.searching = false; this.searchSeq = 0;
    this.search = InputState.new({ placeholder: "Search commits" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value(); this.cursor = 0; this.found = null;
      const seq = ++this.searchSeq, q = this.query.trim();
      if (q) cx.timer.after(450, (cx) => { if (seq === this.searchSeq) this.runSearch(q, seq, cx); });
      cx.notify();
    });
    this.refresh(cx);
    // Follows the focused folder and new commits: a cheap check, a full reload only on a change.
    cx.timer.every(4000, (cx) => this.refresh(cx));
  }

  // Where to look: the focused pane's live folder, on its space's machine.
  where() {
    const f = focused();
    if (!f?.cwd) return null;
    const machine = spaces().find((s) => s.id === f.space)?.machine ?? null;
    return { cwd: f.cwd, on: machine };
  }

  refresh(cx, force = false) {
    if (this.loading) return;
    const w = this.where();
    const key = w ? `${w.on ?? ""}|${w.cwd}` : null;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let repo = this.repo;
        // No focused folder (the panel itself has the keyboard): stay on the last repository.
        if (key && key !== this.whereKey) { repo = await repoOf(w.cwd, w.on); this.whereKey = key; }
        const changed = repo?.top !== this.repo?.top || repo?.on !== this.repo?.on;
        if (changed) { this.repo = repo; this.commits = null; this.open = null; this.cursor = 0; this.tip = null; this.error = null; }
        if (!repo) { this.loading = false; cx.notify(); return; }
        const now = await tip(repo, this.scope === "all");
        if (!force && now === this.tip && this.commits) { this.loading = false; return; }
        this.tip = now;
        const fresh = await repoOf(repo.top, repo.on);
        if (fresh) this.repo = fresh;
        if (changed || this.me === undefined) this.me = await me(this.repo);
        this.commits = await log(this.repo, this.scope === "all");
        this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      this.loading = false;
      cx.notify();
    });
  }

  runSearch(q, seq, cx) {
    if (!this.repo) return;
    const repo = this.repo, all = this.scope === "all";
    this.searching = true; this.searchError = null; cx.notify();
    cx.spawn(async (cx) => {
      let got = null, err = null;
      try { got = await search(repo, q, all); } catch (e) { err = String(e?.message ?? e); }
      if (seq !== this.searchSeq) return;
      this.searching = false; this.found = got ? { query: q, list: got } : null; this.searchError = err;
      // Commits found here open like listed ones.
      for (const c of got ?? []) if (!this.commits?.some((x) => x.sha === c.sha)) (this.extra ??= new Map()).set(c.sha, c);
      cx.notify();
    });
  }

  // The whole history's matches once git answers; until then, the loaded commits that match.
  // Then the filter: Mine (your git user.name), Merges, or Recent (the last 7 days).
  shown() {
    const q = this.query.trim();
    let list;
    if (!q) list = this.commits ?? [];
    else if (this.found?.query === q) list = this.found.list;
    else { const ws = words(q); list = ws.length ? (this.commits ?? []).filter((c) => matches(hay(c), ws)) : []; }
    const f = this.filter, now = Date.now();
    if (f === "mine") list = list.filter((c) => this.me && c.author === this.me);
    else if (f === "merges") list = list.filter((c) => c.merge);
    else if (f === "recent") list = list.filter((c) => now - Date.parse(c.at) < WEEK);
    return list;
  }

  pick(c, cx) {
    this.open = c.sha;
    const at = this.shown().findIndex((x) => x.sha === c.sha);
    if (at >= 0) this.cursor = at;
    if (!this.detail.has(c.sha)) {
      this.detail.set(c.sha, { files: null, body: "", error: null });
      const repo = this.repo;
      cx.spawn(async (cx) => {
        let got;
        try { got = { ...(await show(repo, c.sha)), error: null }; } catch (e) { got = { files: null, body: "", error: String(e?.message ?? e) }; }
        this.detail.set(c.sha, got);
        if (this.detail.size > 30) this.detail.delete(this.detail.keys().next().value);
        if (got.files) {
          let budget = OPEN_LINES;
          for (const f of got.files) {
            const k = `${c.sha}:${f.path}`, cost = Math.min(f.lines, FIRST_LINES);
            const on = !f.why && cost <= budget;
            if (on) budget -= cost;
            if (!this.fileOpen.has(k)) this.fileOpen.set(k, on);
          }
        }
        cx.notify();
        // Then the colors: whole files from this repository (a merge against its first parent).
        const git = repo.on ? null : { cwd: repo.top, oldRev: `${c.sha}^`, newRev: c.sha };
        if (got.files && await highlightFiles(got.files.filter((f) => !f.why), git).catch(() => false)) cx.notify();
      });
    }
    cx.notify();
  }
  back(cx) { this.open = null; cx.notify(); }
  step(by, cx) {
    const list = this.shown(), at = list.findIndex((x) => x.sha === this.open);
    const next = list[at + by];
    if (at >= 0 && next) this.pick(next, cx);
  }

  diffProps(sha) {
    const d = this.detail.get(sha) ?? { files: null, error: null };
    const key = (p) => `${sha}:${p}`;
    return {
      files: d.files, error: d.error, loading: !d.files && !d.error, mode: this.mode, viewed: false, hideGithub: true,
      isOpen: (p) => Boolean(this.fileOpen.get(key(p))), isViewed: () => false,
      limit: (p) => this.fileLimit.get(key(p)) ?? FIRST_LINES,
      toggle: (p, cx) => { const k = key(p); this.fileOpen.set(k, !this.fileOpen.get(k)); cx.notify(); },
      more: (p, cx) => { const k = key(p); this.fileLimit.set(k, (this.fileLimit.get(k) ?? FIRST_LINES) + MORE_LINES); cx.notify(); },
      setMode: (m, cx) => { this.mode = m; save("diff-mode", m); cx.notify(); },
      all: (open, cx) => {
        let budget = ALL_LINES;
        for (const f of d.files ?? []) {
          const k = key(f.path), cost = Math.min(f.lines, this.fileLimit.get(k) ?? FIRST_LINES);
          const on = open && !f.why && cost <= budget;
          if (on) budget -= cost;
          this.fileOpen.set(k, on);
        }
        cx.notify();
      },
      retry: (cx) => { this.detail.delete(sha); const c = this.commits?.find((x) => x.sha === sha) ?? this.extra?.get(sha); if (c) this.pick(c, cx); },
    };
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    if (this.open) {
      if (k === "escape" || k === "backspace") this.back(cx);
      else if (k === "[" || k === "up") this.step(-1, cx);
      else if (k === "]" || k === "down") this.step(1, cx);
      else if (k === "s") { const d = this.diffProps(this.open); d.setMode(d.mode === "split" ? "unified" : "split", cx); }
      else if (k === "e") { const d = this.diffProps(this.open); if (d.files) d.all(!d.files.some((f) => d.isOpen(f.path)), cx); }
      else return;
    } else {
      const list = this.shown();
      if (k === "down") { this.cursor = Math.min(list.length - 1, this.cursor + 1); this.keys = true; }
      else if (k === "up") { this.cursor = Math.max(0, this.cursor - 1); this.keys = true; }
      else if (k === "enter" && list[this.cursor]) { this.pick(list[this.cursor], cx); return; }
      else if (k === "escape" && this.query) { this.search.set_value?.(""); this.query = ""; this.found = null; this.searchSeq++; }
      else return;
      cx.notify();
    }
  }

  render() {
    readSizes();
    const t = theme(), k = kit(t), wide = this.width >= WIDE;
    const root = v_flex().id("history-root").size_full().min_h(0).bg(t.background).text_size(fs.body).text_color(t.foreground)
      .on_size_change((size, cx) => { const w = Math.round(size.width); if (w !== this.width) { this.width = w; save("width", String(w)); cx.notify(); } })
      .track_focus(this.handle).on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* ok */ } })
      .on_key_down((e, cx) => this.key(e, cx));
    if (this.open) return root.child(this.header(t, wide, false)).child(this.commitView(t, k));
    if (!this.repo) return root.child(this.header(t, wide, false)).child(div().p(12).text_color(t.dim)
      .child(this.loading ? "Looking for a git repository…" : "The focused terminal isn't in a git repository. Click into a terminal inside one."));
    if (this.error && !this.commits) return root.child(this.header(t, wide, false)).child(div().p(12).text_color(t.ansi1).child(`git log failed: ${this.error}`));
    return root.child(this.header(t, wide, true)).child(this.listView(t, k));
  }

  // The header, as in the Pull requests list: the title and repository, the search (inline when
  // wide, its own line when narrow), refresh; then the filters and which branches.
  header(t, wide, full) {
    const repo = this.repo ? `${this.repo.top.split("/").pop()}${this.repo.branch ? ` · ${this.repo.branch}` : " · detached"}` : "";
    const iconButton = (id, glyph, click) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(glyph);
    const box = div().min_w(0).px(8).py(3).rounded(6).border_1().border_color(t.input ?? t.border).text_size(fs.meta).child(Input.new(this.search));
    const busy = this.loading || this.searching;
    return v_flex().flex_none().px(12).py(8).gap(6).border_b_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().child("History"))
        .child(div().flex_1().min_w(0).text_size(fs.meta).text_color(t.dim).truncate().child(this.loading && this.commits ? `${repo} · Refreshing…` : repo))
        .when(full && wide, (e) => e.child(box.w(220)))
        .child(iconButton("history-refresh", busy ? svg(SPINNER).size(14).spin(900) : svg(REFRESH_ICON).size(13), (cx) => this.refresh(cx, true))))
      .when(full && !wide, (e) => e.child(box.w_full()))
      .when(full, (e) => e.child(h_flex().gap(8).items_center().flex_wrap()
        .child(segmented("filter", [[null, "All"], ["mine", "Mine"], ["merges", "Merges"], ["recent", "Recent"]], this.filter, (v, cx) => { this.filter = v; this.cursor = 0; }, t))
        .child(div().flex_1())
        .child(segmented("scope", [["head", "This branch"], ["all", "All branches"]], this.scope, (v, cx) => {
          this.scope = v; save("scope", v); this.refresh(cx, true);
          const q = this.query.trim(); if (q) { this.found = null; this.runSearch(q, ++this.searchSeq, cx); }
        }, t))));
  }

  listView(t, k) {
    const list = this.shown(), q = this.query.trim();
    const heading = (label, count) => h_flex().h(fs.body + 13).flex_none().px(10).gap(6).items_end().text_size(fs.meta).text_color(t.dim)
      .child(div().font_semibold().child(label)).child(div().child(String(count)));
    const row = (c, i) => h_flex().id(`c-${c.sha}`).h(fs.body + 17).gap(8).items_center().px(10).mx(0).rounded(6).text_size(fs.meta).cursor_pointer()
      .when(this.keys && i === this.cursor, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.keys = false; this.pick(c, cx); })
      .child(div().w(10).flex_none().text_color(c.merge ? t.ansi5 : t.dim).child(c.merge ? "⑂" : "○"))
      .child(div().flex_none().font_family(MONO).text_color(t.dim).child(c.short.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().text_size(fs.body).text_color(c.merge ? t.muted : t.foreground).child(c.title || "(no message)"))
      .children(c.refs.slice(0, 2).map((r) => k.pill(r.replace(/^tag: /, ""), r.startsWith("tag: ") ? t.ansi3 : r.includes("/") ? t.ansi4 : t.ansi2)))
      .when(this.width >= 520, (e) => e.child(div().flex_none().max_w(140).truncate().text_color(t.muted).child(c.author)))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(ago(c.at)));
    // Commits by day, newest first, under a heading with their count.
    const items = [];
    let day = null, at = 0, group = null;
    for (const c of list) {
      const d = dayOf(c.at);
      if (d !== day) { day = d; group = { label: dayLabel(d), n: 0 }; items.push(group); }
      group.n++; items.push(row(c, at++));
    }
    const status = q ? (this.searchError ? [t.ansi1, `Search failed: ${this.searchError}`]
      : this.searching ? [t.dim, `Searching the whole history${this.scope === "all" ? " (all branches)" : ""}…${/\bcode:/.test(q) ? " code: reads every diff and can take a minute." : ""}`]
      : this.found?.query === q ? [t.dim, `${this.found.list.length >= LOG ? `The newest ${LOG}` : this.found.list.length} in the whole history${this.scope === "all" ? " (all branches)" : ""}. Narrow it with author:, path:, code:, since: or message:.`]
      : null) : null;
    const empty = !this.commits ? "Loading the history…" : this.searching ? "Searching…" : q || this.filter ? "Nothing matches." : "No commits.";
    return v_flex().flex_1().min_h(0)
      .when(Boolean(status), (e) => e.child(div().flex_none().px(14).py(4).text_size(fs.meta).text_color(status[0]).child(status[1])))
      .child(v_flex().id("history-list").w_full().flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .children(items.map((x) => (x.label != null && x.n != null ? heading(x.label, x.n) : x)))
        .when(!list.length, (e) => e.child(div().p(12).text_color(t.dim).child(empty)))
        .when(!q && (this.commits?.length ?? 0) >= LOG && !this.filter, (e) => e.child(div().px(10).py(8).text_size(fs.meta).text_color(t.dim).child(`The last ${LOG} commits. Search to look further back.`))))
      .child(h_flex().flex_none().flex_wrap().gap(14).px(14).py(6).border_t_1().border_color(t.border).bg(t.surface).text_size(fs.tiny).text_color(t.muted)
        .child(h_flex().gap(4).items_center().child(k.kbd("↑")).child(k.kbd("↓")).child("move"))
        .child(h_flex().gap(4).items_center().child(k.kbd("↵")).child("open"))
        .when(Boolean(q), (e) => e.child(h_flex().gap(4).items_center().child(k.kbd("Esc")).child("clear"))));
  }

  commitView(t, k) {
    const c = this.commits?.find((x) => x.sha === this.open) ?? this.extra?.get(this.open);
    if (!c) return div().p(14).text_color(t.dim).child("This commit is no longer in the list.");
    const d = this.detail.get(c.sha) ?? {}, list = this.shown(), at = list.findIndex((x) => x.sha === c.sha);
    const card = v_flex().gap(6).px(12).py(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center().text_size(fs.meta)
        .child(k.button("h-back", "← History", (cx) => this.back(cx), { hint: "Esc" }))
        .child(k.arrow("h-newer", "↑", (cx) => this.step(-1, cx), at > 0))
        .child(k.arrow("h-older", "↓", (cx) => this.step(1, cx), at >= 0 && at < list.length - 1))
        .child(div().flex_1())
        .child(k.button("h-copy", `Copy ${c.short}`, (cx) => cx.write_to_clipboard(c.sha))))
      .child(div().font_semibold().child(c.title || "(no message)"))
      .when(Boolean(d.body), (e) => e.child(div().text_size(fs.meta).text_color(t.muted).font_family(MONO).child(d.body.length > 1500 ? `${d.body.slice(0, 1500)}…` : d.body)))
      .child(h_flex().gap(6).items_center().flex_wrap().text_size(fs.meta).text_color(t.muted)
        .child(div().font_semibold().text_color(t.foreground).child(c.author)).child(`committed ${ago(c.at)} ago`)
        .child(div().font_family(MONO).text_color(t.accent).child(c.short))
        .children(c.refs.map((r) => k.pill(r))));
    return v_flex().id("history-commit").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(10).gap(12)
      .child(card).children(filesTab([], t, k, this.diffProps(c.sha), 0))
      .child(h_flex().flex_none().gap(12).pt(4).text_size(fs.tiny).text_color(t.muted)
        .child("↑ ↓ or [ ] newer / older").child("S unified / split").child("E expand / collapse all").child("Esc back"));
  }
}
