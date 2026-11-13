// Changes: the uncommitted changes of the repository you're working in (the focused terminal's
// folder, on its space's machine), against HEAD, every file as a card with its diff, unified or
// split and syntax highlighted (ranch-highlight), with a commit box like Herdr's own Changes
// panel. It takes that panel's place: the mod-buttons layout's `changes` block shows it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, focused, spaces, panes, watchFolder, notify } from "herdr";
import { repoOf, changes, commitAll, MAX_FILES } from "./git.js";
import { FIRST_LINES, MORE_LINES } from "./diff.js";
import { filesTab } from "./files-tab.js";
import { highlightFiles } from "./highlight.js";
import { fs, readSizes, kit, REFRESH_ICON, writeRefreshIcon } from "./ui.js";

const SPINNER = "mods/workspace-chrome/spinner.svg";
const OPEN_LINES = 800, ALL_LINES = 2500;
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this session only */ } };

// Where to look, as Herdr's Changes panel finds it: the focused pane's live folder, on its
// space's machine (a focused terminal block names its machine in its address).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder;
  return cwd ? { cwd, on } : null;
}

export default class Changes extends View {
  init(_props, cx) {
    writeRefreshIcon().then(() => cx.notify()).catch(() => null);
    this.repo = null; this.files = null; this.error = null; this.loading = false; this.busy = false;
    this.mode = load("diff-mode", "unified"); this.fileOpen = new Map(); this.fileLimit = new Map(); this.hl = new Map();
    this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => { const had = Boolean(this.message.trim()); this.message = this.input.value(); if (had !== Boolean(this.message.trim())) cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    // While the message has the keyboard, S and E type.
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // Follows the focused folder: a cheap check, a reload only when it moved.
    cx.timer.every(1500, (cx) => { const w = location(); if (w && `${w.on ?? ""}|${w.cwd}` !== this.whereKey) this.refresh(cx); });
  }

  // Refreshes when anything under the repository changes (this computer only; others poll).
  watch(root, cx) {
    if (this.repo?.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const w = location();
    const key = w ? `${w.on ?? ""}|${w.cwd}` : null;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        let repo = this.repo;
        // No focused folder (the panel itself has the keyboard): stay on the last repository.
        if (key && key !== this.whereKey) { repo = await repoOf(w.cwd, w.on); this.whereKey = key; }
        if (repo?.root !== this.repo?.root || repo?.on !== this.repo?.on) {
          this.repo = repo; this.files = null; this.fileOpen = new Map(); this.fileLimit = new Map(); this.hl = new Map(); this.error = null; this.watched = null;
        }
        if (!this.repo) { this.files = null; return; }
        const fresh = await repoOf(this.repo.root, this.repo.on);
        if (fresh) this.repo = fresh;
        const got = await changes(this.repo);
        // A file whose diff didn't change keeps its colors; open state carries over by path.
        let budget = OPEN_LINES;
        for (const f of got.files) {
          const kept = this.hl.get(f.path);
          if (kept && kept.patch === patchKey(f)) f.hl = kept.hl;
          const cost = Math.min(f.lines, FIRST_LINES);
          if (!this.fileOpen.has(f.path)) { const on = !f.why && cost <= budget; if (on) budget -= cost; this.fileOpen.set(f.path, on); }
        }
        this.files = got.files; this.limited = got.limited; this.head = got.head; this.error = null;
        this.watch(this.repo.root, cx);
        cx.notify();
        const repo2 = this.repo, git = repo2.on ? null : { cwd: repo2.root, oldRev: got.head ? "HEAD" : null, newRev: "" };
        const todo = got.files.filter((f) => !f.why && !f.hl);
        if (todo.length && await highlightFiles(todo, git).catch(() => false) && this.repo === repo2) {
          for (const f of todo) if (f.hl) this.hl.set(f.path, { patch: patchKey(f), hl: f.hl });
        }
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); if (this.again) this.refresh(cx); }
    });
  }

  commit(cx) {
    const message = this.message.trim(), repo = this.repo;
    if (!message || !repo || this.busy || !this.files?.length) return;
    this.busy = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await commitAll(repo, message);
        this.input.set_value(""); this.message = "";
        notify({ title: "Committed", body: message.split("\n")[0], level: "success", timeout: 2500 });
      } catch (e) { this.note = String(e?.message ?? e); }
      this.busy = false; cx.notify(); this.refresh(cx);
    });
  }

  diffProps() {
    const files = this.files ?? [];
    return {
      files: this.files, error: null, loading: !this.files, mode: this.mode, viewed: false, hideGithub: true,
      isOpen: (p) => Boolean(this.fileOpen.get(p)), isViewed: () => false,
      limit: (p) => this.fileLimit.get(p) ?? FIRST_LINES,
      toggle: (p, cx) => { this.fileOpen.set(p, !this.fileOpen.get(p)); cx.notify(); },
      more: (p, cx) => { this.fileLimit.set(p, (this.fileLimit.get(p) ?? FIRST_LINES) + MORE_LINES); cx.notify(); },
      setMode: (m, cx) => { this.mode = m; save("diff-mode", m); cx.notify(); },
      all: (open, cx) => {
        let budget = ALL_LINES;
        for (const f of files) {
          const cost = Math.min(f.lines, this.fileLimit.get(f.path) ?? FIRST_LINES), on = open && !f.why && cost <= budget;
          if (on) budget -= cost;
          this.fileOpen.set(f.path, on);
        }
        cx.notify();
      },
      retry: (cx) => this.refresh(cx),
    };
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt || this.typing) return;
    const d = this.diffProps();
    if (k === "s") d.setMode(d.mode === "split" ? "unified" : "split", cx);
    else if (k === "e" && this.files) d.all(!this.files.some((f) => d.isOpen(f.path)), cx);
    else return;
    cx.stop_propagation();
  }

  render() {
    readSizes();
    const t = theme(), k = kit(t), files = this.files ?? [];
    const add = files.reduce((s, f) => s + f.additions, 0), del = files.reduce((s, f) => s + f.deletions, 0);
    const where = this.repo ? `${this.repo.root.split("/").pop()}${this.repo.branch ? ` · ${this.repo.branch}` : ""}` : "";
    const head = h_flex().flex_none().gap(8).items_center().px(12).py(8).border_b_1().border_color(t.border)
      .child(div().flex_none().font_semibold().child("Changes"))
      .when(Boolean(this.files), (e) => e.child(div().flex_none().px(6).rounded_full().bg(t.selected).text_size(fs.tiny).text_color(t.muted).child(`${files.length}${this.limited ? "+" : ""} file${files.length === 1 ? "" : "s"}`)))
      .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).text_color(t.dim).child(where))
      .when(files.length > 0, (e) => e.child(div().flex_none().text_size(fs.meta).text_color(t.ansi2).child(`+${add}`)).child(div().flex_none().text_size(fs.meta).text_color(t.ansi1).child(`−${del}`)))
      .child(div().id("changes-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
        .child(this.loading ? svg(SPINNER).size(14).spin(900) : svg(REFRESH_ICON).size(13)));
    const ready = Boolean(this.message.trim()) && files.length > 0 && !this.busy;
    const box = v_flex().flex_none().gap(4).px(10).py(8).border_t_1().border_color(t.border)
      .when(Boolean(this.note), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.note)))
      .child(h_flex().gap(8).items_center()
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(fs.meta)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).text_size(fs.meta)
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).when(ready, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
    const body = !this.repo
      ? div().p(12).text_color(t.dim).child(this.loading ? "Looking for a git repository…" : "The focused terminal isn't in a git repository.")
      : this.error && !this.files ? div().p(12).text_color(t.ansi1).child(`git failed: ${this.error}`)
      : this.files && !files.length ? div().p(12).text_color(t.dim).child("No uncommitted changes.")
      : v_flex().id("changes-files").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(10).gap(12)
        .children(filesTab([], t, k, this.diffProps(), 0))
        .when(Boolean(this.limited), (e) => e.child(div().text_size(fs.meta).text_color(t.dim).child(`The first ${MAX_FILES} changed files.`)));
    return v_flex().id("changes-root").size_full().min_h(0).bg(t.background).text_size(fs.body).text_color(t.foreground)
      .track_focus(this.handle).on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* ok */ } })
      .on_key_down((e, cx) => this.key(e, cx))
      .child(head).child(v_flex().flex_1().min_h(0).child(body)).when(Boolean(this.repo), (e) => e.child(box));
  }
}

// What a file's colors depend on: its hunks' text.
const patchKey = (f) => f.hunks.map((h) => h.header + h.lines.map((l) => l.kind[0] + l.text).join("\n")).join("\n");
