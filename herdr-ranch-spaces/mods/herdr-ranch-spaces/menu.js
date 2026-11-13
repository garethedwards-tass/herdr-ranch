// Right-click menus and the git button's popup. The list opens itself as a popup at the pointer with
//   { menu: "git", space, on, info }                    the git button: its state, Git status, Switch branch,
//                                                        Fetch, Pull, the worktree actions
//   { menu: <space id>, git: "main" | "linked" | null }  a space: Link space, the worktree actions, Rename, Close
//   { menu: "checkout", path, main, on, branch }        a worktree without a space: Create space, Delete, Copy path
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, spaces, knownAgents } from "herdr";
import { openLinkDialog } from "./links.js";
import { openWorktree, openNew, openRemove, openGit, openAccount, ICONS } from "./actions.js";
import { accounts, argvAs, runAs } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;

// [label, icon path, action(cx)]
// [label, icon path, action(cx), program?]; `agents`: the installed agents, for the new-space menu.
export function menuItems(p, agents = []) {
  // A new tab in a space: a terminal or an agent, as the space's account when it has one.
  const newTabs = (id, acct) => [
    ["New terminal", `${ICONS}/square-terminal.svg`, () => run("tab.new", { space: id, ...(acct ? { argv: argvAs(acct) } : {}) })],
    ...agents.map((a) => [`New ${a.name}`, null, () => run("tab.new", { space: id, name: a.name, argv: acct ? runAs(acct, a.run) : a.run }), a]),
  ];
  if (p.menu === "new-tab") return newTabs(p.space, p.account ? accounts().find((a) => a.id === p.account) ?? null : null);
  if (p.menu === "new-space") return [
    ["Terminal", `${ICONS}/square-terminal.svg`, () => run("space.new", { machine: p.machine ?? "" })],
    ...agents.map((a) => [a.name, null, () => run("space.new", { machine: p.machine ?? "", argv: a.run }), a]),
  ];
  const acct = p.account ? accounts().find((a) => a.id === p.account) ?? null : null;
  if (p.menu === "git") {
    const id = p.space, i = p.info ?? {};
    return [
      ["Git status…", CHROME("git-compare"), () => openGit(id, "status")],
      ["Switch branch…", CHROME("git-branch"), () => openGit(id, "branches")],
      // In the Git dialog, which shows how it went (and Pull with rebase when it can't fast-forward).
      ["Fetch", CHROME("git-compare"), () => openGit(id, "status", null, "fetch")],
      [i.behind > 0 ? `Pull ↓${i.behind}` : "Pull", CHROME("git-compare"), () => openGit(id, "status", null, "pull")],
      ["New worktree from a branch…", `${ICONS}/branch-plus.svg`, () => openNew(id, "branch")],
      ["New worktree from an issue…", `${ICONS}/branch-plus.svg`, () => openNew(id, "issue")],
      ["New worktree…", `${ICONS}/branch-plus.svg`, () => openWorktree({ space: id, action: "new" })],
      ["Open worktree…", CHROME("git-compare"), () => openWorktree({ space: id, action: "open" })],
      ...(i.linked ? [["Remove worktree…", CHROME("archive"), () => openWorktree({ space: id, action: "remove" })]] : []),
    ];
  }
  if (p.menu === "checkout") return [
    ["Git: status, pull…", CHROME("git-compare"), () => openGit(null, "status", { folder: p.path, on: p.on })],
    ["Switch branch…", CHROME("git-branch"), () => openGit(null, "branches", { folder: p.path, on: p.on })],
    ["Create space here", CHROME("plus"), () => run("space.new", { folder: p.path, machine: p.on ?? "", ...(acct ? { argv: argvAs(acct) } : {}) })],
    ["Delete worktree…", CHROME("x"), () => openRemove(p)],
    ["Copy path", CHROME("file-text"), (cx) => cx.write_to_clipboard(p.path)],
  ];
  const id = p.menu;
  return [
    ["Link space…", `${ICONS}/link.svg`, () => openLinkDialog(MOD, spaces().find((s) => s.id === id))],
    [acct ? `Account: ${acct.label}…` : "Account…", CHROME("settings"), () => openAccount(id)],
    ...newTabs(id, acct),
    ...(p.git ? [
      ["Git: status, pull…", CHROME("git-compare"), () => openGit(id, "status")],
      ["Switch branch…", CHROME("git-branch"), () => openGit(id, "branches")],
      ["New worktree…", `${ICONS}/branch-plus.svg`, () => openWorktree({ space: id, action: "new" })],
      ["New worktree from a branch…", `${ICONS}/branch-plus.svg`, () => openNew(id, "branch")],
      ["New worktree from an issue…", `${ICONS}/branch-plus.svg`, () => openNew(id, "issue")],
      ["Open worktree…", CHROME("git-compare"), () => openWorktree({ space: id, action: "open" })],
    ] : []),
    ...(p.git === "linked" ? [["Remove worktree…", CHROME("archive"), () => openWorktree({ space: id, action: "remove" })]] : []),
    ["Rename", CHROME("square-pen"), () => run("space.rename", { id })],
    ["Close", CHROME("x"), () => run("space.close", { id })],
  ];
}

export class SpaceMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.agents = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    const m = props()?.menu;
    if (m && m !== "git" && m !== "checkout") cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents({ on: props().machine || null })).filter((a) => a.installed && a.run?.length); } catch { /* Terminal only */ }
      cx.notify();
    });
  }

  choose(i, cx) {
    const p = props(), it = menuItems(p, this.agents)[i];
    if (!it) return;
    it[2](cx);
    closeOverlay(p.overlay);
  }

  render() {
    const t = theme(), p = props(), list = menuItems(p, this.agents), i = p.menu === "git" || p.menu === "checkout" ? p.info : null;
    return v_flex().id("spaces-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      // The git popup's header: repository, branch, and its state.
      .when(Boolean(i), (el) => el.child(v_flex().px(8).pt(4).pb(6).mb(3).gap(2).border_b_1().border_color(t.border)
        .child(h_flex().gap(6).items_center().child(div().font_semibold().text_color(t.foreground).child(i.name)).child(div().min_w(0).truncate().text_color(t.accent).child(i.branch ?? "detached")))
        .child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
          .child(i.changes > 0 ? div().text_color(t.ansi3).child(`●${i.changes} uncommitted`) : i.changes === 0 ? div().text_color(t.ansi2).child("✓ clean") : div().child("…"))
          .when(Math.max(i.ahead ?? 0, i.unpushed ?? 0) > 0, (el) => el.child(div().text_color(t.ansi2).child(`↑${Math.max(i.ahead ?? 0, i.unpushed ?? 0)} to push`)))
          .when(i.behind > 0, (el) => el.child(div().text_color(t.ansi1).child(`↓${i.behind} to pull`)))
          .when(i.worktrees > 1, (el) => el.child(div().child(`${i.worktrees} checkouts`))))))
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") return this.choose(this.at, cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .when(p.menu === "new-space" || p.menu === "new-tab", (el) => el.child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child(p.menu === "new-space" ? "New space with" : "New tab with")))
      .children(list.map(([label, icon, _go, prog], i) => h_flex().id(`spaces-menu-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.choose(i, cx))
        .child(icon ? svg(icon).size(13).flex_none().text_color(t.muted) : prog?.icon ? (prog.tint ? svg(prog.icon).size(13).flex_none().text_color(t.muted) : image(prog.icon).w(13).h(13).flex_none()) : div().w(13).flex_none())
        .child(div().flex_1().truncate().child(label))));
  }
}
