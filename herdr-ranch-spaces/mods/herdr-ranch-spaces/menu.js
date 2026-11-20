// Right-click menus and the git button's popup. The list opens itself as a popup at the pointer with
//   { menu: <space id>, git: "main" | "linked" | null, info }  a space (right-click, or its git pill): its git
//                                                        state, Git status, Switch branch, the worktree
//                                                        actions, Link space (its links and account; not on a worktree,
//                                                        which uses its repository's), new tabs, Rename, Close
//   { menu: "checkout", path, main, on, branch }        a worktree without a space: Create space, Delete, Copy path
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, spaces, knownAgents } from "herdr";
import { openLinkDialog } from "./links.js";
import { openWorktree, openNew, openRemove, openGit, ICONS } from "./actions.js";
import { accounts, argvAs, runAs, launchAs, accountColor, accountLetter, defaultLabel, defaultLetter, defaultGhUser, defaultBadge } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;

// [label, icon path, action(cx), program?, hint?], or SEP between groups; `agents`: the installed agents.
// hint: [[text, theme color]...] shown at the end of the row (Git status… carries the git state).
export const SEP = "-";
export function menuItems(p, agents = []) {
  // A new tab in a space: a terminal or an agent, as the space's account when it has one.
  const newTabs = (id, chosen, acct = launchAs(chosen)) => [
    ["New terminal", `${ICONS}/square-terminal.svg`, () => run("tab.new", { space: id, ...(acct ? { argv: argvAs(acct) } : {}) })],
    ...agents.map((a) => [`New ${a.name}`, null, () => run("tab.new", { space: id, name: a.name, argv: acct ? runAs(acct, a.run) : a.run }), a]),
  ];
  if (p.menu === "new-tab") return newTabs(p.space, p.account ? accounts().find((a) => a.id === p.account) ?? null : null);
  const acct = p.account ? accounts().find((a) => a.id === p.account) ?? null : null;
  if (p.menu === "checkout") return [
    ["Git: status, pull…", CHROME("git-compare"), () => openGit(null, "status", { folder: p.path, on: p.on })],
    ["Switch branch…", CHROME("git-branch"), () => openGit(null, "branches", { folder: p.path, on: p.on })],
    ["Create space here", CHROME("plus"), () => { const as = launchAs(acct); run("space.new", { folder: p.path, machine: p.on ?? "", ...(as ? { argv: argvAs(as) } : {}) }); }],
    ["Delete worktree…", CHROME("x"), () => openRemove(p)],
    ["Copy path", CHROME("file-text"), (cx) => cx.write_to_clipboard(p.path)],
  ];
  const id = p.menu, i = p.info ?? {};
  return [
    ...(p.git ? [
      ["Git status…", CHROME("git-compare"), () => openGit(id, "status"), null, gitHint(i)],
      ["Switch branch…", CHROME("git-branch"), () => openGit(id, "branches")],
      SEP,
      ["New worktree from a branch…", `${ICONS}/branch-plus.svg`, () => openNew(id, "branch")],
      ["New worktree from an issue…", `${ICONS}/branch-plus.svg`, () => openNew(id, "issue")],
      ["New worktree…", `${ICONS}/branch-plus.svg`, () => openWorktree({ space: id, action: "new" })],
      ["Open worktree…", CHROME("git-compare"), () => openWorktree({ space: id, action: "open" })],
      ...(p.git === "linked" ? [["Remove worktree…", CHROME("archive"), () => openWorktree({ space: id, action: "remove" })]] : []),
      SEP,
    ] : []),
    // A worktree uses its repository space's link and account (linkOf, accountOf): set them there.
    ...(p.git === "linked" ? [] : [
      [acct ? `Link space and account (${acct.label})…` : "Link space and account…", `${ICONS}/link.svg`, () => openLinkDialog(MOD, spaces().find((s) => s.id === id))],
    ]),
    ...newTabs(id, acct),
    SEP,
    ["Rename", CHROME("square-pen"), () => run("space.rename", { id })],
    ["Close", CHROME("x"), () => run("space.close", { id })],
  ];
}

// The checkout's state in short, for the Git status… row: uncommitted, to push, to pull, or clean.
export function gitHint(i) {
  const up = Math.max(i.ahead ?? 0, i.unpushed ?? 0), out = [];
  if (i.changes > 0) out.push([`●${i.changes}`, "ansi3"]);
  if (up > 0) out.push([`↑${up}`, "ansi2"]);
  if (i.behind > 0) out.push([`↓${i.behind}`, "ansi1"]);
  if (!out.length) out.push(i.changes === 0 ? ["✓ clean", "ansi2"] : ["…", "dim"]);
  return out;
}

export class SpaceMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.agents = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    const m = props()?.menu;
    if (m && m !== "checkout") cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents({ on: props().machine || null })).filter((a) => a.installed && a.run?.length); } catch { /* Terminal only */ }
      cx.notify();
    });
  }

  choose(i, cx) {
    const p = props(), it = menuItems(p, this.agents)[i];
    if (!it || it === SEP) return;
    it[2](cx);
    closeOverlay(p.overlay);
  }

  render() {
    const t = theme(), p = props(), list = menuItems(p, this.agents), i = p.info ?? null;
    // The space's account (its own or its repository's) with its coloured letter; "Default" or its name (your usual
    // Claude Code and gh login) without one. Every space menu has it.
    const space = p.menu !== "checkout" && p.menu !== "new-tab";
    const acct = space && p.account ? accounts().find((a) => a.id === p.account) ?? null : null;
    const who = space ? h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
      .child(((b) => div().size(16).flex_none().rounded(3).bg(b ? accountColor(b, t) : t.raised).border_1().border_color(b ? accountColor(b, t) : t.border)
        .flex().items_center().justify_center().text_size(10.5).font_semibold().text_color(b ? t.background : t.dim).child(b ? accountLetter(b) : defaultLetter()))(acct ?? defaultBadge()))
      .child(div().min_w(0).truncate().child(acct ? `${acct.label}${acct.ghUser ? ` · ${acct.ghUser}` : ""}` : `${defaultLabel() === "Default" ? "Default account" : defaultLabel()}${defaultGhUser() ? ` · ${defaultGhUser()}` : ""}`)) : null;
    // ↑/↓ skip the dividers.
    const step = (d) => { let n = this.at; do n = (n + d + list.length) % list.length; while (list[n] === SEP && n !== this.at); this.at = n; };
    return v_flex().id("spaces-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      // The header: repository and branch (the state is on Git status…), and the account.
      .when(!i && Boolean(who), (el) => el.child(v_flex().px(8).pt(4).pb(6).mb(3).border_b_1().border_color(t.border).child(who)))
      .when(Boolean(i), (el) => el.child(v_flex().px(8).pt(4).pb(6).mb(3).gap(2).border_b_1().border_color(t.border)
        .child(h_flex().gap(6).items_center().child(div().font_semibold().text_color(t.foreground).child(i.name)).child(div().min_w(0).truncate().text_color(t.accent).child(i.branch ?? "detached")))
        .when(Boolean(who), (el) => el.child(div().pt(3).child(who)))))
      .on_key_down((e, cx) => {
        if (e.key === "down") step(1);
        else if (e.key === "up") step(-1);
        else if (e.key === "enter") return this.choose(this.at, cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .when(p.menu === "new-tab", (el) => el.child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("New tab with")))
      .children(list.map((item, i) => item === SEP ? div().flex_none().h(1).mx(6).my(4).bg(t.border) : menuRow(this, item, i, t)));
  }
}

function menuRow(v, [label, icon, _go, prog, hint], i, t) {
  return h_flex().id(`spaces-menu-${i}`).flex_none().h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(t.foreground)
        .when(i === v.at, (el) => el.bg(t.selected))
        .when(i !== v.at, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => v.choose(i, cx))
        .child(icon ? svg(icon).size(13).flex_none().text_color(t.muted) : prog?.icon ? (prog.tint ? svg(prog.icon).size(13).flex_none().text_color(t.muted) : image(prog.icon).w(13).h(13).flex_none()) : div().w(13).flex_none())
        .child(div().flex_1().truncate().child(label))
        .when(Boolean(hint), (el) => el.child(h_flex().flex_none().gap(6).text_size(12).children(hint.map(([text, color]) => div().text_color(t[color] ?? t.dim).child(text)))));
}
