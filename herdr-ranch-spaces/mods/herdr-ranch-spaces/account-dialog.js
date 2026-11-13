// Account for a space: the list opens itself as a dialog with props { dialog: "account", space }.
// Pick Default or one of your accounts (worktree spaces of the repository follow it), add one (a
// label, a Claude Code config folder, a GitHub login from `gh auth status`), or remove one (only
// the entry here: logins and folders stay). Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, exec, run } from "herdr";
import { spaceRepo } from "./links.js";
import { accounts, accountOf, setAccount, addAccount, removeAccount, checkAccount, parseGhAccounts } from "./accounts.js";

const MOD = "herdr-ranch-spaces";

export class AccountDialog extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
    this.repo = undefined; this.gh = []; this.ghUser = ""; this.error = ""; this.focus = "label";
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.label = InputState.new({ placeholder: "Work, Personal…" });
    this.dir = InputState.new({ placeholder: "~/.claude-<label> (empty: keep the usual login)" });
    for (const [k, s] of [["label", this.label], ["dir", this.dir]]) {
      s.on("focus", (_e, cx) => { this.focus = k; cx.notify(); });
      s.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
      s.on("submit", (_e, cx) => this.add(cx));
    }
    cx.spawn(async (cx) => {
      this.repo = await spaceRepo(this.space).catch(() => null);
      const r = await exec("gh", ["auth", "status"]).catch(() => null);
      this.gh = parseGhAccounts(`${r?.stdout ?? ""}\n${r?.stderr ?? ""}`);
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  pick(a, cx) { setAccount(this.space, this.repo, a); cx.notify(); }

  add(cx) {
    const label = this.label.value().trim();
    const a = { label, claudeDir: this.dir.value().trim() || (label ? `~/.claude-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""), ghUser: this.ghUser };
    const err = checkAccount(a);
    if (err) { this.error = err; cx.notify(); return; }
    const made = addAccount(a);
    setAccount(this.space, this.repo, made);
    this.label.set_value(""); this.dir.set_value(""); this.ghUser = "";
    cx.notify();
  }

  render() {
    const t = theme(), list = accounts(), cur = accountOf(this.space, this.repo);
    const choice = (id, a, label, detail) => {
      const on = (cur?.id ?? null) === (a?.id ?? null);
      return h_flex().id(`acct-${id}`).flex_none().min_h(36).px(10).py(4).gap(10).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(a, cx))
        .child(div().w(14).flex_none().text_color(t.accent).child(on ? "●" : ""))
        .child(v_flex().flex_1().min_w(0).child(div().truncate().text_color(t.foreground).child(label)).child(div().truncate().text_size(11).text_color(t.dim).child(detail)))
        .when(Boolean(a), (el) => el.child(div().id(`acct-rm-${id}`).flex_none().px(6).rounded(4).text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.blocked))
          .tooltip("Remove this account from Herdr Ranch (its login and folder stay)")
          .on_click((_e, cx) => { cx.stop_propagation(); removeAccount(a.id); cx.notify(); }).child("remove")));
    };
    const box = (k, state) => div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(this.focus === k ? t.accent : t.input).bg(t.background).child(Input.new(state));
    return v_flex().id("spaces-account").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(div().font_semibold().text_color(t.foreground).child(`Account for ${this.space?.name ?? "this space"}`))
      .child(div().text_size(12).text_color(t.muted).child("Terminals opened as the account get its Claude Code login (CLAUDE_CONFIG_DIR) and GitHub account (GH_TOKEN). Worktree spaces of this repository follow it."))
      .child(v_flex().id("acct-list").gap(2).max_h(200).overflow_y_scrollbar()
        .child(choice("default", null, "Default", "Your usual Claude Code login and gh account"))
        .children(list.map((a) => choice(a.id, a, a.label, [a.claudeDir && `Claude Code: ${a.claudeDir}`, a.ghUser && `GitHub: ${a.ghUser}`].filter(Boolean).join(" · ")))))
      .child(div().pt(6).text_size(11).text_color(t.muted).child("New account"))
      .child(box("label", this.label))
      .child(box("dir", this.dir))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(div().text_size(11).text_color(t.dim).child("GitHub:"))
        .children(this.gh.map((u) => div().id(`gh-${u}`).px(8).py(1).rounded_full().text_size(11).cursor_pointer()
          .when(this.ghUser === u, (el) => el.bg(t.accent).text_color(t.background)).when(this.ghUser !== u, (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.ghUser = this.ghUser === u ? "" : u; cx.notify(); }).child(u)))
        .when(this.gh.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("none signed in to gh"))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().id("acct-add").px(12).py(4).rounded(6).bg(t.accent).text_color(t.background).font_semibold().text_size(12).cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.add(cx)).child("Add and use")))
      .child(div().text_size(11).text_color(t.dim).child("Log in once: right-click the space, New Claude Code as the account, then /login."))
      .child(div().flex_1())
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("click to choose · esc close"));
  }
}
