// Right-click menus. The list opens itself as a popup at the pointer with
//   { menu: <space id>, git: "main" | "linked" | null }  a space: Link space, the worktree actions, Rename, Close
//   { menu: "checkout", path, main, on, branch }        a worktree without a space: Create space, Delete, Copy path
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, spaces } from "herdr";
import { openLinkDialog } from "./links.js";
import { openWorktree, openNew, openRemove, openGit, openAccount, ICONS } from "./actions.js";
import { accounts, argvAs } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;

// [label, icon path, action(cx)]
export function menuItems(p) {
  const acct = p.account ? accounts().find((a) => a.id === p.account) ?? null : null;
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
    ...(acct ? [
      [`New tab as ${acct.label}`, CHROME("terminal"), () => run("tab.new", { space: id, name: acct.label, argv: argvAs(acct) })],
      [`New Claude Code as ${acct.label}`, CHROME("terminal"), () => run("tab.new", { space: id, name: `Claude Code · ${acct.label}`, argv: argvAs(acct, "claude") })],
    ] : []),
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
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const p = props(), it = menuItems(p)[i];
    if (!it) return;
    it[2](cx);
    closeOverlay(p.overlay);
  }

  render() {
    const t = theme(), p = props(), list = menuItems(p);
    return v_flex().id("spaces-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") return this.choose(this.at, cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .children(list.map(([label, icon], i) => h_flex().id(`spaces-menu-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.choose(i, cx))
        .child(svg(icon).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().truncate().child(label))));
  }
}
