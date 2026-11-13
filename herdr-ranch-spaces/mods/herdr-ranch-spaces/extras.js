// What Herdr Ranch adds to Herdr's spaces list (main.js is a copy of Herdr's own `spaces` mod,
// changed only where it calls into this file; RECIPE.md lists those places). Each function takes
// the list's view (`v`) for its state: v.trees (repo -> worktrees with work), v.unfolded, v.pulling.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { openOverlay, spaces, panes, run, nextCommand } from "herdr";
import { linkOf, openLinkDialog } from "./links.js";
import { LinkDialog } from "./link-dialog.js";
import { SpaceMenu } from "./menu.js";
import { NewDialog } from "./new.js";
import { RemoveDialog } from "./remove.js";
import { GitDialog } from "./git-dialog.js";
import { AccountDialog } from "./account-dialog.js";
import { accountOf } from "./accounts.js";
import { openNew, openGit, openAccount, ICONS } from "./actions.js";
import { linkLabel, base, checkoutAt, hasWork } from "./git.js";

export const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
// A row's icon in a fixed 20px slot: with the row's gap of 7, its text starts where a space's name
// does (avatar 18 + gap 9), whatever the icon's own width.
const slot = (el) => div().w(20).flex_none().flex().items_center().child(el);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this session only */ } };

// The list opened as one of its own dialogs or popups: that view, else null.
export function dialogFor(p, cx) {
  const kind = p?.dialog === "link" ? LinkDialog : p?.dialog === "new" ? NewDialog : p?.dialog === "remove" ? RemoveDialog : p?.dialog === "git" ? GitDialog : p?.dialog === "account" ? AccountDialog : p?.menu ? SpaceMenu : null;
  return kind ? cx.new(kind, p) : null;
}

// The list's own state, and its commands: "focus" (a dialog of ours closed), and "git",
// "branches", "new-worktree" for the shown space (bind them in keys.json).
export function start(v, cx) {
  v.trees = {};
  v.unfolded = new Set(load("spaces.unfolded", []));
  v.pulling = new Set();
  v.openSpaces = new Set(load("spaces.terminals", []));
  v.handle = cx.focus_handle();
  cx.spawn(async () => {
    try {
      for (;;) {
        const c = await nextCommand(), id = spaces().find((s) => s.active)?.id;
        if (c === "focus") { try { v.handle.focus(); } catch { /* not shown */ } }
        else if (id && c === "git") openGit(id, "status");
        else if (id && c === "branches") openGit(id, "branches");
        else if (id && c === "new-worktree") openNew(id, "branch");
      }
    } catch { /* the copy is closing */ }
  });
}

// Right-click on a space: our menu (Link space, Git, worktrees, Rename, Close).
// The checkout's state for the git button's color, most pressing first: uncommitted changes
// (ansi3), behind its upstream (ansi1; with commits to push too, it has diverged), commits to
// push (accent), in sync (ansi2). Unknown until its work is read (no color).
export function gitState(c, g) {
  const up = Math.max(g?.ahead ?? 0, c?.unpushed ?? 0), down = g?.behind ?? 0;
  if (!c || c.changes == null) return { state: "unknown", color: null, say: "Git" };
  if (c.changes > 0) return { state: "dirty", color: "ansi3", say: `${c.changes} uncommitted file${c.changes === 1 ? "" : "s"}` };
  if (down > 0) return { state: up > 0 ? "diverged" : "behind", color: "ansi1", say: up > 0 ? `Diverged: ${up} to push, ${down} to pull` : `${down} to pull` };
  if (up > 0) return { state: "ahead", color: "accent", say: `${up} to push` };
  return { state: "sync", color: "ansi2", say: "In sync: nothing to commit, push or pull" };
}

// The git chip, in the link chip's style and always the same width: a git icon, the branch
// (cut short; whole in the tooltip) and the state in short (✓ in sync, n uncommitted (amber), ↓n to
// pull, ↕ diverged, ↑n to push, … not read yet), tinted by the state's color. A click opens the
// git popup.
// Both chips are this wide, whatever they say: long words end in …, and rows never shift.
const CHIP = 88;
// The git chip of a folder outside git (grey, "no repo"), or not read yet ("…").
function noGitChip(w, known, t) {
  return h_flex().id(`space-git-none-${w.id}`).flex_none().w(CHIP).gap(3).px(5).items_center().rounded(4)
    .border_1().border_color(t.dim + "55").bg(t.dim + "14").text_size(12).text_color(t.dim)
    .child(svg(CHROME("git-branch")).size(10).flex_none())
    .child(div().flex_1().min_w(0).truncate().child(known ? "no repo" : "…"));
}

const SHORT = { sync: () => "✓", dirty: (c) => String(c.changes), behind: (_c, g) => `↓${g.behind}`, diverged: () => "↕", ahead: (c, g) => `↑${Math.max(g.ahead ?? 0, c.unpushed ?? 0)}`, unknown: () => "…" };
function gitChip(v, w, g, at, t) {
  return gitPill(`space-git-menu-${w.id}`, g.branch, checkoutAt(v.trees[g.repo], at), g, t, () => gitMenu(v, w, g, at));
}

// The pill itself: branch and state in the state's color, fixed width. `onClick` null: not a button.
function gitPill(id, branch, c, g, t, onClick) {
  const s = gitState(c, g), color = (s.color && t[s.color]) || t.dim;
  return h_flex().id(id).flex_none().w(CHIP).gap(3).px(5).items_center().rounded(4)
    .border_1().border_color(color + "55").bg(color + "14").text_size(12).text_color(color)
    .when(Boolean(onClick), (el) => el.cursor_pointer().hover((x) => x.bg(color + "2a"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }))
    .child(svg(CHROME("git-branch")).size(10).flex_none())
    .child(div().flex_1().min_w(0).truncate().child(branch ?? "detached"))
    .child(div().flex_none().child(SHORT[s.state](c ?? {}, g ?? {})));
}

// A worktree space under its repository's space: the same compact row as the worktrees without
// a space (in the text color: it has a space), its fold for its terminals, a folder icon and the
// worktree's folder name, and the spaces' git pill (branch and state; a click opens the git
// popup). A click selects the space; right-click its menu.
export function worktreeSpaceRow(v, r, t) {
  const { w, g, at } = r;
  const c = g ? checkoutAt(v.trees[g.repo], at) : null;
  const folder = g?.top ? base(g.top) : "";
  const branch = g?.branch ?? "detached";
  return h_flex().id(`space-${w.id}`).h(26).flex_none().px(8).pl(2).gap(7).items_center().rounded(6).cursor_pointer().text_size(13)
    .text_color(t.foreground).when(w.active, (el) => el.bg(t.selected)).when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click(() => run("space.select", { id: w.id }))
    .on_mouse_down("right", () => spaceMenu(w, g))
    .child(foldChevron(v, w, 0, t))
    .child(slot(svg(CHROME("folder")).size(13).flex_none().text_color(t.muted)))
    .child(div().flex_1().min_w(0).truncate().child(folder || w.name))
    .child(g ? gitPill(`wt-git-${w.id}`, branch, c, g, t, () => gitMenu(v, w, g, at)) : div());
}

// The git button's popup: what the list knows about the checkout, and the git and worktree actions.
function gitMenu(v, w, g, at) {
  const c = checkoutAt(v.trees[g.repo], at);
  const info = { name: g.name, branch: g.branch, ahead: g.ahead, behind: g.behind, changes: c?.changes ?? null, unpushed: c?.unpushed ?? null, top: g.top, linked: g.linked, worktrees: (v.trees[g.repo] ?? []).length };
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 300, height: 440, props: { menu: "git", space: w.id, on: w.machine ?? null, info } });
}

export function spaceMenu(w, g) {
  const account = accountOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 260, height: 420, props: { menu: w.id, git: g ? (g.linked ? "linked" : "main") : null, account: account?.id ?? null } });
}

function button(id, path, tip, t, onClick, color = null) {
  return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(color ?? t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(svg(path).size(13));
}

// What follows a space's name, in place of Herdr's gitTail: the repository and branch (a click
// opens Git), its work, its link chip (or Link space when it has none), and New worktree.
export function spaceTail(v, { w, g, tree, at, known }, t, again) {
  const link = linkOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  const label = linkLabel(link);
  const account = accountOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  // The repository when the name doesn't say it; the branch and state are in the git chip.
  const where = g && !tree && g.name.toLowerCase() !== w.name.toLowerCase() ? g.name : "";
  const id = `space-work-${w.id}`;
  return h_flex().flex_1().min_w(0).gap(5).items_center()
    .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(12.5).text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().id(`space-git-${w.id}`).min_w(0).truncate().px(2).rounded(3)
        .when(Boolean(g), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Git: status, branches, pull")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); openGit(w.id); }))
        .child(where)))
    )
    .when(Boolean(account), (el) => el.child(div().id(`space-account-${w.id}`).flex_none().max_w(70).truncate().px(5).rounded(4).text_size(11).text_color(t.ansi5 ?? t.accent).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`Account: ${account.label}${account.claudeDir ? `\nClaude Code: ${account.claudeDir}` : ""}${account.ghUser ? `\nGitHub: ${account.ghUser}` : ""}\nClick to change`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openAccount(w.id); })
      .child(`@${account.label}`)))
    .when(Boolean(label), (el) => el.child(h_flex().id(`space-link-${w.id}`).flex_none().w(CHIP).gap(3).items_center().px(5).rounded(4)
      .border_1().border_color(t.accent + "55").bg(t.accent + "14").text_size(12).text_color(t.accent).cursor_pointer()
      .hover((s) => s.bg(t.accent + "2a"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
      .child(svg(`${ICONS}/link.svg`).size(10).flex_none()).child(div().flex_1().min_w(0).truncate().child(label))))
    // Not linked: the same chip in grey, "Link".
    .when(!label, (el) => el.child(h_flex().id(`space-link-new-${w.id}`).flex_none().w(CHIP).gap(3).items_center().px(5).rounded(4)
      .border_1().border_color(t.dim + "55").bg(t.dim + "14").text_size(12).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.dim + "2a").text_color(t.muted))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
      .child(svg(`${ICONS}/link.svg`).size(10).flex_none()).child("Link")))
    .child(g ? gitChip(v, w, g, at, t) : noGitChip(w, known, t));
}

// "n worktrees without a space": folds a repository's checkouts that no space shows.
export function moreRow(v, r, t) {
  return h_flex().id(`more-${r.repo}`).h(26).flex_none().px(8).pl(2).gap(7).items_center().rounded(6).cursor_pointer()
    .text_size(13).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
    .on_click((_e, cx) => {
      r.open ? v.unfolded.delete(r.repo) : v.unfolded.add(r.repo);
      save("spaces.unfolded", [...v.unfolded]);
      cx.notify();
    })
    .child(div().w(12).mr(-2).flex_none().flex().justify_center().child(svg(CHROME(r.open ? "chevron-down" : "chevron-right")).size(13)))
    .child(slot(svg(`${ICONS}/unplug.svg`).size(13).flex_none()))
    .child(div().truncate().child(`${r.count} worktree${r.count === 1 ? "" : "s"} without a space`))
    // Which work: uncommitted files (amber), commits on no remote (blue, like the pill's ↑).
    .when(r.dirty > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(`· ${r.dirty} uncommitted`)))
    .when(r.unpushed > 0, (el) => el.child(div().flex_none().text_color(t.accent).child(`· ${r.unpushed} unpushed`)));
}

// A worktree without a space's menu (click or right-click), with the git popup's header.
function checkoutMenu(r) {
  const c = r.c;
  const info = { name: base(c.path), branch: c.branch, ahead: 0, behind: 0, changes: c.changes ?? null, unpushed: c.unpushed ?? null, linked: true };
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 300, height: 260, props: { menu: "checkout", path: c.path, main: r.main, on: r.on ?? null, branch: c.branch, account: accountOf(null, { main: r.main, on: r.on ?? null })?.id ?? null, info } });
}

// Levels line up: a space's children have their icons at 19 (the space's avatar), the rows
// under a worktree space or the "without a space" fold at 38; chevrons sit to the left of them.
// A worktree no space shows: a click opens its Git dialog (with its menu's actions), right-click
// its menu (no space is made either way).
export function looseRow(v, r, t) {
  return h_flex().id(`loose-${r.c.path}`).h(26).flex_none().px(8).pl(38).gap(7).items_center().rounded(6).cursor_pointer().text_size(13)
    .text_color(hasWork(r.c) ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => openGit(null, "status", { folder: r.c.path, on: r.on }))
    .on_mouse_down("right", () => checkoutMenu(r))
    .child(slot(svg(CHROME("folder")).size(13).flex_none().text_color(t.dim)))
    .child(div().flex_1().min_w(0).truncate().child(base(r.c.path)))
    .when(r.c.locked, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("locked")))
    .child(gitPill(`loose-git-${r.c.path}`, r.c.branch, r.c, { ahead: 0, behind: 0 }, t, null));
}

// A space's terminals (every tab's terminal panes): { pane, terminal, title, program, cwd, branch, status }.
function terminalsOf(w) {
  const tabs = new Map((w.tabs ?? []).map((t) => [t.id, t]));
  return panes().filter((p) => p.terminal && tabs.has(p.tab));
}
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

// A small label over a group under an unfolded space ("Terminals", "Worktrees").
export const sectionLabel = (id, text, t) => div().id(id).h(20).flex_none().pl(19).flex().items_end().text_size(11.5).text_color(t.dim).child(text);

// The header's fold button: Collapse all when anything is open (every space and worktree space,
// and the "worktrees without a space" lists), else Expand all (every space and worktree space).
export function foldAllButton(v, t) {
  const any = v.openSpaces.size > 0 || v.unfolded.size > 0;
  return div().id("spaces-fold-all").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(any ? "Collapse all" : "Expand all")
    .on_click((_e, cx) => {
      if (any) { v.openSpaces.clear(); v.unfolded.clear(); }
      else for (const s of spaces()) v.openSpaces.add(s.id);
      save("spaces.terminals", [...v.openSpaces]);
      save("spaces.unfolded", [...v.unfolded]);
      cx.notify();
    })
    .child(svg(`${ICONS}/${any ? "chevrons-down-up" : "chevrons-up-down"}.svg`).size(14));
}

export const isOpen = (v, id) => v.openSpaces?.has(id) ?? false;

// The ▸/▾ at a space's start: folds its terminals and agents, its worktree spaces and its
// worktrees without a space (remembered). A space with none gets the same width, empty.
export function foldChevron(v, w, children, t) {
  const n = children + terminalsOf(w).length;
  if (!n) return div().w(12).mr(-2).flex_none();
  const open = isOpen(v, w.id);
  return div().id(`space-fold-${w.id}`).w(12).mr(-2).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(open ? "Fold" : "Show its terminals and worktrees")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      open ? v.openSpaces.delete(w.id) : v.openSpaces.add(w.id);
      save("spaces.terminals", [...v.openSpaces]);
      cx.notify();
    })
    .child(svg(CHROME(open ? "chevron-down" : "chevron-right")).size(11));
}

// A program's icon from Herdr's program table (Claude Code, Codex…): a one-color glyph (in the
// text color) or a picture. None for a shell: it shows the terminal icon. (Herdr reports
// `agent: false` for an idle agent, so the shell flag decides.)
export function programIcon(program, t, size = 14) {
  if (!program?.icon || program.shell) return null;
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(t.muted) : image(program.icon).w(size).h(size).flex_none();
}

// The + for a new space: a menu of Terminal and each agent Herdr knows is installed there.
export function newSpaceMenu(machine) {
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 240, height: 300, props: { menu: "new-space", machine: machine ?? "" } });
}

const STATUS = { blocked: "blocked", done: "done", working: "working", idle: "idle" };
// Under an unfolded space (deeper under a worktree space): each terminal with its program, title, folder and branch, and its
// agent's status. A click goes to it; the eye peeks at it without leaving the shown space.
export function terminalRows(v, w, t, depth = 1) {
  if (!isOpen(v, w.id)) return [];
  // The space's own folder and branch (its first terminal's): a row repeats them only when its own differ.
  const list = terminalsOf(w), first = list.find((p) => p.cwd) ?? null;
  return [...list.map((p) => terminalRow(p, t, depth, first)), newTabRow(w, t, depth)];
}

// "+ New terminal or agent…" at the end of a space's terminals: a menu of both, as its account.
function newTabRow(w, t, depth) {
  return h_flex().id(`term-new-${w.id}`).h(24).flex_none().pl(depth > 1 ? 38 : 19).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
    .text_size(12.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => {
      const a = accountOf(w, null);
      openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 240, height: 260, props: { menu: "new-tab", space: w.id, account: a?.id ?? null } });
    })
    .child(slot(svg(CHROME("plus")).size(13).flex_none()))
    .child(div().flex_1().min_w(0).truncate().child("New agent or terminal…"));
}

function terminalRow(p, t, depth, first = null) {
    // A title that only says user@host or a path (a shell's default) says nothing: the program's name instead.
    const title = clean(p.title), telling = title && title !== p.program?.name && !title.includes("@") && !/^[~/]/.test(title);
    const name = telling ? title : p.program?.name || "terminal";
    // Only what differs from the space: another folder, another branch.
    const where = [p.cwd && p.cwd !== first?.cwd ? base(p.cwd) : "", p.branch && p.branch !== first?.branch ? p.branch : ""].filter(Boolean).join(" · ");
    const color = t[STATUS[p.status]] ?? t.dim;
    return h_flex().id(`term-${p.pane}`).h(26).flex_none().pl(depth > 1 ? 38 : 19).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(p.focused ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("pane.focus", { pane: p.pane }))
      // An agent shows its own icon (Herdr's program table), a plain terminal the terminal icon.
      .child(slot(programIcon(p.program, t) ?? svg(`${ICONS}/square-terminal.svg`).size(13).flex_none().text_color(t.dim)))
      .child(div().flex_shrink(0).max_w(140).truncate().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where))
      .when(Boolean(p.status), (el) => el.child(div().size(6).flex_none().rounded(3).bg(color)))
      .child(div().id(`peek-${p.pane}`).flex_none().size(18).flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.raised ?? t.hover).text_color(t.foreground)).tooltip("Peek: see it here, without switching spaces")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: p.terminal }); })
        .child(svg(`${ICONS}/eye.svg`).size(14)));
}
