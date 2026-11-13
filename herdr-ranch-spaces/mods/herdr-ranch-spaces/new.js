// New worktree, from a branch or an issue: the list opens itself as a dialog with
// props { dialog: "new", space, mode: "branch" | "issue" }.
// Branch: the repository's branches, newest first (remote ones without a local branch too), and
// "Create branch <typed name>" from the space's checkout. Issue: your open issues from the
// space's link (Jira, Linear or GitHub), or one typed by its key; its branch is reused when one
// starts with its key, else "KEY-short-title" is made. A branch already checked out opens (or
// shows) that worktree's space instead. The checkout goes to ~/.herdr/worktrees/<repo>/<branch>,
// as Herdr's own worktree dialog puts it, and a space opens there.
// Tab switches Branch / Issue, ↑/↓ choose, Enter creates, Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, run, home } from "herdr";
import { place, probe, worktrees, branches, addArgs, worktreePath, issueBranch, homeOn } from "./git.js";
import { linkOf, detectGithub } from "./links.js";
import { source, mine, lookup, looksLikeKey } from "./issues.js";
import { accountOf, argvAs } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const MAX_ROWS = 100;
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const ago = (s) => {
  if (!s) return "";
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

export class NewDialog extends View {
  init(_props, cx) {
    const p = props();
    this.mode = p.mode === "issue" ? "issue" : "branch";
    this.space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
    this.on = this.space?.machine ?? null;
    this.g = undefined; // undefined: looking, null: not in git
    this.list = []; this.issues = undefined; this.issueError = ""; this.found = null;
    this.text = ""; this.at = 0; this.busy = false; this.error = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: this.placeholder() });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.error = ""; this.find(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(this.rows()[this.at], cx));
    this.input.focus();
    cx.spawn(async (cx) => {
      try {
        const folder = place(this.space, panes());
        const g = folder ? await probe(folder, this.on) : null;
        if (g) {
          const checkouts = await worktrees(g.main, this.on);
          [this.list, this.home] = await Promise.all([branches(g.main, this.on, checkouts), homeOn(this.on, home())]);
          this.checkouts = checkouts;
        }
        this.g = g;
        cx.notify();
        if (g) this.loadIssues(cx);
      } catch (e) { this.g = null; this.error = String(e?.message ?? e); cx.notify(); }
      cx.timer.after(50, () => { try { this.input.focus(); } catch { /* closed */ } });
    });
  }

  placeholder() { return this.mode === "issue" ? "Filter your issues, or type a key (ABC-12, #12)" : "Filter branches, or type a new branch name"; }

  async loadIssues(cx) {
    const repo = { main: this.g.main, on: this.on };
    this.src = source(linkOf(this.space, repo), await detectGithub(repo).catch(() => null));
    if (!this.src) { this.issues = []; this.issueError = "This space isn't linked to an issue tracker: use Link space."; cx.notify(); return; }
    try { this.issues = await mine(this.src); } catch (e) { this.issues = []; this.issueError = String(e?.message ?? e); }
    cx.notify();
  }

  // A typed key that isn't among your issues is looked up, once typing stops.
  find(cx) {
    const key = this.text.trim();
    this.found = null;
    if (this.mode !== "issue" || !this.src || !looksLikeKey(key) || this.issues?.some((i) => i.key === key)) return;
    const asked = (this.asked = key);
    cx.timer.after(350, () => cx.spawn(async (cx) => {
      if (this.asked !== asked) return;
      const i = await lookup(this.src, asked).catch(() => null);
      if (this.asked === asked) { this.found = i ?? { key: asked, title: "", missing: true }; cx.notify(); }
    }));
  }

  // The branch an issue goes on: one that starts with its key, else a new one.
  branchFor(i) {
    const k = i.key.replace("#", "issue-").toLowerCase();
    const b = this.list.find((x) => x.name.toLowerCase() === k || x.name.toLowerCase().startsWith(`${k}-`));
    return b ?? { name: issueBranch(i.key, i.title), fresh: true };
  }

  rows() {
    const f = this.text.trim(), lf = f.toLowerCase();
    if (this.mode === "branch") {
      const hits = this.list.filter((b) => !lf || b.name.toLowerCase().includes(lf));
      const exact = this.list.some((b) => b.name === f);
      return [...(f && !exact ? [{ kind: "create", name: f }] : []), ...hits.map((b) => ({ kind: "branch", b }))].slice(0, MAX_ROWS);
    }
    const hits = (this.issues ?? []).filter((i) => !lf || `${i.key} ${i.title}`.toLowerCase().includes(lf));
    const typed = this.found && !this.found.missing && !hits.some((i) => i.key === this.found.key) ? [this.found] : [];
    return [...typed, ...hits].slice(0, MAX_ROWS).map((i) => ({ kind: "issue", i, b: this.branchFor(i) }));
  }

  // The space a checkout is shown in, if any.
  spaceIn(path) {
    const ps = panes();
    return spaces().find((s) => (s.machine ?? null) === this.on && inside(place(s, ps) ?? "", path));
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  // The new space's first terminal as the repository's account, if it has one.
  asAccount() {
    const a = this.g ? accountOf(this.space, { main: this.g.main, on: this.on }) : null;
    return a ? { argv: argvAs(a) } : {};
  }

  choose(row, cx) {
    if (!row || this.busy || !this.g) return;
    const b = row.kind === "create" ? { name: row.name, fresh: true } : row.b;
    if (b.path) {
      const s = this.spaceIn(b.path);
      this.close();
      if (s) run("space.select", { id: s.id }); else run("space.new", { folder: b.path, machine: this.on ?? "", ...this.asAccount() });
      return;
    }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (b.fresh) {
          const ok = await exec("git", ["check-ref-format", "--branch", b.name], { cwd: this.g.top, on: this.on });
          if (ok.code !== 0) throw new Error(`"${b.name}" isn't a valid branch name.`);
        }
        const path = worktreePath(this.home, this.g.name, b.name);
        const r = await exec("git", addArgs(path, { ...b, exists: !b.fresh && !b.remote }), { cwd: this.g.top, on: this.on, timeout: 600_000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git worktree add failed.").trim());
        this.close();
        // Unnamed, so the space follows its checkout and sits under the repository's space.
        run("space.new", { folder: path, machine: this.on ?? "", ...this.asAccount() });
      } catch (e) { this.error = String(e?.message ?? e); this.busy = false; cx.notify(); }
    });
  }

  setMode(m, cx) {
    if (this.mode === m) return;
    this.mode = m; this.at = 0; this.error = "";
    this.input.set_placeholder?.(this.placeholder());
    this.find(cx);
    cx.notify();
  }

  key(e, cx) {
    const n = this.rows().length;
    if (e.key === "escape") this.close();
    else if (e.key === "tab") this.setMode(this.mode === "branch" ? "issue" : "branch", cx);
    else if ((e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  row(r, i, t) {
    const on = i === this.at;
    const tag = (text, color) => div().flex_none().text_size(11).text_color(color ?? t.dim).child(text);
    const base = h_flex().id(`new-${i}`).flex_none().min_h(34).px(10).py(4).gap(8).items_center().rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.at = i; this.choose(r, cx); });
    if (r.kind === "create") return base.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`Create branch ${r.name}`)).child(tag(`from ${this.g.branch ?? "HEAD"}`));
    if (r.kind === "branch") {
      const s = r.b.path && this.spaceIn(r.b.path);
      return base.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.b.name))
        .when(Boolean(r.b.remote), (el) => el.child(tag(r.b.remote, t.accent)))
        .when(Boolean(r.b.path), (el) => el.child(tag(s ? "open" : "checked out", s ? t.accent : t.dim)))
        .child(tag(ago(r.b.at)));
    }
    const s = r.b.path && this.spaceIn(r.b.path);
    return base.child(v_flex().flex_1().min_w(0)
      .child(h_flex().gap(8).child(div().flex_none().text_color(t.accent).child(r.i.key)).child(div().min_w(0).truncate().text_color(t.foreground).child(r.i.title)))
      .child(div().truncate().text_size(11).text_color(t.dim).child(r.b.fresh ? `new branch ${r.b.name}` : r.b.path ? `${r.b.name} · ${s ? "open" : "checked out"}` : `branch ${r.b.name}`)));
  }

  render() {
    const t = theme(), g = this.g, rows = g ? this.rows() : [];
    const tab = (m, label) => div().id(`new-mode-${m}`).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(this.mode === m, (el) => el.bg(t.selected).text_color(t.foreground)).when(this.mode !== m, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.setMode(m, cx)).child(label);
    const empty = this.mode === "issue"
      ? (this.issues === undefined ? "Loading your issues…" : this.issueError || (this.found?.missing ? `No issue ${this.found.key}.` : "No open issues assigned to you."))
      : "No branches.";
    return v_flex().id("spaces-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`New worktree${g ? ` of ${g.name}` : ""}`))
        .child(h_flex().gap(2).child(tab("branch", "Branch")).child(tab("issue", "Issue"))))
      .when(g === undefined, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(g === null, (el) => el.child(div().text_color(t.muted).child(this.error || "This space isn't in a git repository.")))
      .when(Boolean(g), (el) => el
        .child(div().h(32).px(10).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background).text_color(t.foreground).child(Input.new(this.input)))
        .child(v_flex().id("new-list").flex_1().min_h(0).overflow_y_scrollbar()
          .children(rows.map((r, i) => this.row(r, i, t)))
          .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child(empty))))
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error))))
      .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
        .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(this.busy ? "creating…" : "tab branch/issue · ↑↓ choose · ↵ create · esc close"));
  }
}
