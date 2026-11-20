// What Herdr Ranch adds to Herdr's spaces list (main.js is a copy of Herdr's own `spaces` mod,
// changed only where it calls into this file; RECIPE.md lists those places). Each function takes
// the list's view (`v`) for its state: v.trees (repo -> worktrees with work), v.unfolded, v.pulling.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { openOverlay, spaces, panes, run, nextCommand, exec, machines, shared } from "herdr";
import { agentsIn, agentsAway, PLACES, STATUS_WORD } from "./agents-at.js";
import { LANES_READ, parseLaneRead, stacksOf, laneAt, hostOf } from "./lanes.js";
import { openLinkDialog } from "./links.js";
import { LinkDialog } from "./link-dialog.js";
import { SpaceMenu } from "./menu.js";
import { NewDialog } from "./new.js";
import { NewSpaceDialog } from "./new-space.js";
import { RemoveDialog } from "./remove.js";
import { GitDialog } from "./git-dialog.js";
import { accounts, accountOf, accountColor, accountLetter, defaultLabel, defaultBadge } from "./accounts.js";
import { openNew, openGit, ICONS } from "./actions.js";
import { base, checkoutAt, hasWork } from "./git.js";

export const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
// A row's icon in a fixed 20px slot: with the row's gap of 7, its text starts where a space's name
// does (avatar 18 + gap 9), whatever the icon's own width.
const INDENT = 8;
const CARET_GAP = 1; // between a worktree row's caret and its icon
const CARET = 12 + CARET_GAP; // a fold chevron and its gap, before a row's icon
// Where a row starts, by depth: a space's children at 19 + INDENT (the space's avatar is at 19),
// a worktree row's caret there too (its icon after it), and the rows under a worktree row one
// INDENT in from that row's icon.
const LEVEL1 = 19 + INDENT, LEVEL2 = LEVEL1 + CARET + INDENT;
const CHEVRON1 = LEVEL1;
// An agent row's icon, centered under a worktree row's caret and folder (CARET + a 13px folder),
// so its name starts where a worktree's does.
// The chevron glyph has room around it, so the drawn caret and folder center 2px right of the box's.
const wide = (el) => div().w(CARET + 13).pl(4).flex_none().flex().items_center().justify_center().child(el);
const ROW = 31, TEXT = 13; // a child row's height and text (agents, terminals, worktrees): text no larger than a space's name (13)
const ICON = 17; // a row's icon without a caret (agents, terminals, New, worktrees without a space)
const slot = (el) => div().w(20).flex_none().flex().items_center().child(el);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this session only */ } };

// The list opened as one of its own dialogs or popups: that view, else null.
export function dialogFor(p, cx) {
  const kind = p?.dialog === "link" ? LinkDialog : p?.dialog === "new" ? NewDialog : p?.dialog === "new-space" ? NewSpaceDialog : p?.dialog === "remove" ? RemoveDialog : p?.dialog === "git" ? GitDialog : p?.menu ? SpaceMenu : null;
  return kind ? cx.new(kind, p) : null;
}

// The list's own state, and its commands: "focus" (a dialog of ours closed), "new-space", and
// "git", "branches", "new-worktree" for the shown space (bind them in keys.json).
export function start(v, cx) {
  v.trees = {};
  v.unfolded = new Set(load("spaces.unfolded", []));
  v.pulling = new Set();
  v.openSpaces = new Set(load("spaces.terminals", []));
  v.accountFilter = load("spaces.account", null);
  v.handle = cx.focus_handle();
  v.lanes = {}; // machine ("" here) -> stacksOf its lane containers, for the worktree rows' lane badges
  v.lanesRead = {}; // machine -> when its lanes were last asked for (0 while a read runs)
  cx.spawn(async (cx) => {
    try { for (;;) { readLanes(v, () => cx.notify()); await cx.sleep(LANES_TICK); } } catch { /* the copy is closing */ }
  });
  cx.spawn(async () => {
    try {
      for (;;) {
        const c = await nextCommand(), id = spaces().find((s) => s.active)?.id;
        if (c === "focus") { try { v.handle.focus(); } catch { /* not shown */ } }
        else if (id && c === "git") openGit(id, "status");
        else if (id && c === "branches") openGit(id, "branches");
        else if (id && c === "new-worktree") openNew(id, "branch");
        else if (c === "new-space") newSpaceMenu(null);
      }
    } catch { /* the copy is closing */ }
  });
}

// Lanes (shared/lanes.js): read from the lane containers' labels on every machine a space is on.
// Each machine on its own every LANES_EVERY, so a slow one holds up no other; a machine that's new
// (or a space just made on one) is read at the next tick. A machine that's away, or a read that
// fails (docker stopped), drops its lanes rather than keep showing old ones.
const LANES_EVERY = 30000, LANES_TICK = 3000;
export function readLanes(v, changed) {
  const away = new Set(machines().filter((m) => m.layout === "unavailable").map((m) => m.name));
  const ons = new Set([null, ...spaces().map((s) => s.machine ?? null)]);
  const set = (key, stacks) => {
    if (JSON.stringify(v.lanes[key] ?? []) === JSON.stringify(stacks ?? [])) return;
    if (stacks) v.lanes[key] = stacks; else delete v.lanes[key];
    changed();
  };
  for (const key of Object.keys(v.lanes)) if (!ons.has(key || null) || away.has(key)) set(key, null);
  for (const on of ons) {
    const key = on ?? "", last = v.lanesRead[key];
    if (away.has(on) || last === 0 || Date.now() - (last ?? -Infinity) < LANES_EVERY) continue;
    v.lanesRead[key] = 0;
    exec("sh", ["-c", LANES_READ], { on: on ?? undefined, timeout: 15000 })
      .then((r) => set(key, r.code === 0 ? stacksOf(parseLaneRead(r.stdout)) : null), () => set(key, null))
      .finally(() => { v.lanesRead[key] = Date.now(); });
  }
}

// The lane serving a checkout (a worktree, or a main checkout a lane serves) as a small badge ("L2", tinted like a held lane); a click opens its
// site. Nothing when no lane serves it.
function laneBadge(v, id, on, path, t) {
  const l = laneAt(v.lanes?.[on ?? ""], path);
  if (!l) return div();
  const color = l.state === "stopped" ? t.dim : t.accent;
  return div().id(id).flex_none().h(PILL).px(5).flex().items_center().rounded(4)
    .border_1().border_color(color + "55").bg(color + "14").text_size(12).text_color(color)
    .tooltip([`Lane ${l.n}${l.url ? ` · ${hostOf(l.url)}` : ""}`, l.state, l.owner || l.branch ? `Held for ${l.owner || l.branch}` : "", l.url ? "Click to open the site" : ""].filter(Boolean).join("\n"))
    .when(Boolean(l.url), (el) => el.cursor_pointer().hover((x) => x.bg(color + "2a"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(l.url); }))
    .child(`L${l.n}`);
}

// The agents working in a checkout now, from other spaces or none (agents-at.js): a bot and their
// number in the most urgent one's status color. A click goes to that agent's terminal; the
// tooltip says who, how they are and from which space. Nothing when none.
const AGENT_COLOR = { blocked: "ansi3", done: "ansi2", working: "accent", idle: "dim" };
function agentBadge(id, list, t) {
  if (!list?.length) return div();
  const a = list[0], color = t[AGENT_COLOR[a.status]] ?? t.dim;
  return h_flex().id(id).flex_none().h(PILL).px(5).gap(3).items_center().rounded(4)
    .border_1().border_color(color + "55").bg(color + "14").text_size(12).text_color(color).cursor_pointer().hover((x) => x.bg(color + "2a"))
    .tooltip(["An agent works here now:", ...list.map((x) => `${x.name} · ${STATUS_WORD[x.status] ?? x.status}${x.spaceName ? ` · space ${x.spaceName}` : ""}`), "Click to go to it"].join("\n"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
    .child(svg(`${ICONS}/bot.svg`).size(12).flex_none())
    .when(list.length > 1, (el) => el.child(String(list.length)));
}
const agentsAt = (v, repo, path, except, on) => agentsIn(v.places, v.trees?.[repo], path, except, on);

// A space whose own agent works in another checkout (the primary space's agent in a worktree):
// a pill with a bot and that worktree's folder, tinted by the agent's status. A click goes to it.
function awayPill(id, list, t) {
  if (!list?.length) return div();
  const a = list[0], color = t[AGENT_COLOR[a.status]] ?? t.dim;
  return h_flex().id(id).flex_shrink_1().min_w(0).max_w(110).h(PILL).px(5).gap(3).items_center().rounded(4)
    .border_1().border_color(color + "55").bg(color + "14").text_size(12).text_color(color).cursor_pointer().hover((x) => x.bg(color + "2a"))
    .tooltip(["This space's agent works in another checkout:", ...list.map((x) => `${x.name} · ${STATUS_WORD[x.status] ?? x.status} · ${x.checkout}`), "Click to go to it"].join("\n"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
    .child(svg(`${ICONS}/bot.svg`).size(12).flex_none())
    .child(div().min_w(0).truncate().child(`→ ${base(a.checkout)}`))
    .when(list.length > 1, (el) => el.child(div().flex_none().child(`+${list.length - 1}`)));
}
const awayOf = (v, w, g, at) => (g ? agentsAway(v.places, v.trees?.[g.repo], w.id, checkoutAt(v.trees[g.repo], at)?.path ?? g.top) : []);

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
// The chips are a fixed width, whatever they say: long words end in …, and rows never shift.
const CHIP = 78; // the git pill (and its no-git stand-in)
const PILL = 20; // the height of the git pill and of the account square beside it
// The git chip of a folder outside git (grey, "no repo"), or not read yet ("…").
function noGitChip(w, known, t) {
  return h_flex().id(`space-git-none-${w.id}`).flex_none().w(CHIP).h(PILL).gap(3).px(5).items_center().rounded(4)
    .border_1().border_color(t.dim + "55").bg(t.dim + "14").text_size(12).text_color(t.dim)
    .child(svg(CHROME("git-branch")).size(10).flex_none())
    .child(div().flex_1().min_w(0).truncate().child(known ? "no repo" : "…"));
}

const SHORT = { sync: () => "✓", dirty: (c) => String(c.changes), behind: (_c, g) => `↓${g.behind}`, diverged: () => "↕", ahead: (c, g) => `↑${Math.max(g.ahead ?? 0, c.unpushed ?? 0)}`, unknown: () => "…" };
function gitChip(v, w, g, at, t) {
  return gitPill(`space-git-menu-${w.id}`, g.branch, checkoutAt(v.trees[g.repo], at), g, t, () => spaceMenu(v, w, g, at));
}

// The pill itself: branch and state in the state's color, fixed width. `onClick` null: not a button.
function gitPill(id, branch, c, g, t, onClick) {
  const s = gitState(c, g), color = (s.color && t[s.color]) || t.dim;
  return h_flex().id(id).flex_none().w(CHIP).h(PILL).gap(3).px(5).items_center().rounded(4)
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
  return h_flex().id(`space-${w.id}`).h(ROW).flex_none().px(8).pl(CHEVRON1).gap(7).items_center().rounded(6).cursor_pointer().text_size(TEXT)
    .text_color(t.foreground).when(w.active, (el) => el.bg(t.selected)).when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click(() => run("space.select", { id: w.id }))
    .on_mouse_down("right", () => spaceMenu(v, w, g, at))
    // The caret and folder fold together; the name sits close to its folder.
    .child(foldChevron(v, w, 0, t, svg(CHROME("folder")).size(13).flex_none().text_color(t.muted)))
    .child(div().flex_1().min_w(0).truncate().child(folder || w.name))
    .child(awayPill(`wt-away-${w.id}`, awayOf(v, w, g, at), t))
    .child(agentBadge(`wt-agents-${w.id}`, g ? agentsAt(v, g.repo, checkoutAt(v.trees[g.repo], at)?.path, w.id, w.machine) : [], t))
    .child(laneBadge(v, `wt-lane-${w.id}`, w.machine, g?.top, t))
    .child(g ? gitPill(`wt-git-${w.id}`, branch, c, g, t, () => spaceMenu(v, w, g, at)) : div());
}

// A space's one menu, from a right-click on it or a click on its git pill: its git state at the top,
// then git, worktrees, Link space and account, new tabs, Rename, Close (menu.js).
export function spaceMenu(v, w, g, at) {
  const account = accountOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  const c = g ? checkoutAt(v.trees[g.repo], at) : null;
  const info = g ? { name: g.name, branch: g.branch, ahead: g.ahead, behind: g.behind, changes: c?.changes ?? null, unpushed: c?.unpushed ?? null, top: g.top, linked: g.linked, worktrees: (v.trees[g.repo] ?? []).length } : null;
  // As high as its rows, with room for three agents under New terminal.
  const rows = 3 + 4 + (g ? 2 + 4 + (g.linked ? 1 : 0) : 0) + (g?.linked ? 0 : 1);
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 300, height: Math.min(700, 10 + (info ? 56 : 32) + rows * 28 + (g ? 3 : 1) * 9), props: { menu: w.id, git: g ? (g.linked ? "linked" : "main") : null, account: account?.id ?? null, info, machine: w.machine ?? null } });
}

function button(id, path, tip, t, onClick, color = null) {
  return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(color ?? t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(svg(path).size(13));
}

// A space's account as a colored letter before its git chip; on the default account its letter on
// a neutral square once you've named it, else a faint outlined link square. Each click opens Link space.
function accountBadge(w, a, t) {
  const d = a ? null : defaultBadge();
  if (d) return div().id(`space-account-${w.id}`).size(PILL).flex_none().flex().items_center().justify_center().rounded(4)
    .border_1().border_color(accountColor(d, t)).bg(accountColor(d, t)).text_color(t.background).text_size(12).font_semibold().cursor_pointer().hover((s) => s.opacity(0.85))
    .tooltip(`${d.label} (no account)\nClick to link the space or pick an account`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
    .child(accountLetter(d));
  if (!a) return div().id(`space-account-${w.id}`).size(PILL).flex_none().flex().items_center().justify_center().rounded(4)
    .border_1().border_color(t.dim + "55").text_color(t.dim).cursor_pointer().hover((s) => s.border_color(t.muted).text_color(t.muted))
    .tooltip(`${defaultLabel()} (no account)\nClick to link the space or pick an account`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
    .child(svg(`${ICONS}/link.svg`).size(12));
  const color = accountColor(a, t);
  return div().id(`space-account-${w.id}`).size(PILL).flex_none().flex().items_center().justify_center().rounded(4)
    .border_1().border_color(color).bg(color).text_color(t.background).text_size(12).font_semibold().cursor_pointer().hover((s) => s.opacity(0.85))
    .tooltip(`Account: ${a.label}${a.claudeDir ? `\nClaude Code: ${a.claudeDir}` : ""}${a.ghUser ? `\nGitHub: ${a.ghUser}` : ""}\nClick to change`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
    .child(accountLetter(a));
}

// What follows a space's name, in place of Herdr's gitTail: the repository and branch (a click
// opens Git), its account's letter (a click opens Link space), and its git chip.
export function spaceTail(v, { w, g, tree, at, known }, t, again) {
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
    .child(awayPill(`space-away-${w.id}`, awayOf(v, w, g, at), t))
    .child(agentBadge(`space-agents-${w.id}`, g ? agentsAt(v, g.repo, checkoutAt(v.trees[g.repo], at)?.path, w.id, w.machine) : [], t))
    .child(laneBadge(v, `space-lane-${w.id}`, w.machine, g?.top, t))
    .child(accountBadge(w, account, t))
    .child(g ? gitChip(v, w, g, at, t) : noGitChip(w, known, t));
}

// "n worktrees without a space": folds a repository's checkouts that no space shows.
export function moreRow(v, r, t) {
  return h_flex().id(`more-${r.repo}`).h(ROW).flex_none().px(8).pl(CHEVRON1).gap(7).items_center().rounded(6).cursor_pointer()
    .text_size(TEXT).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
    .on_click((_e, cx) => {
      r.open ? v.unfolded.delete(r.repo) : v.unfolded.add(r.repo);
      save("spaces.unfolded", [...v.unfolded]);
      cx.notify();
    })
    .child(h_flex().gap(CARET_GAP).flex_none().items_center()
      .child(div().w(12).flex_none().flex().justify_center().child(svg(CHROME(r.open ? "chevron-down" : "chevron-right")).size(13)))
      .child(svg(`${ICONS}/unplug.svg`).size(13).flex_none()))
    .child(div().truncate().child(`${r.count} worktree${r.count === 1 ? "" : "s"} without a space`))
    // Which work: uncommitted files (amber), commits on no remote (blue, like the pill's ↑).
    .when(r.dirty > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(`· ${r.dirty} uncommitted`)))
    .when(r.unpushed > 0, (el) => el.child(div().flex_none().text_color(t.accent).child(`· ${r.unpushed} unpushed`)))
    // Agents working in them now: shown folded too, so a worktree in use isn't hidden.
    .child(div().flex_1())
    .child(agentBadge(`more-agents-${r.repo}`, (r.paths ?? []).flatMap((p) => agentsAt(v, r.repo, p, null, r.on)), t));
}

// A worktree without a space's menu (click or right-click), with the git popup's header.
function checkoutMenu(r) {
  const c = r.c;
  const info = { name: base(c.path), branch: c.branch, ahead: 0, behind: 0, changes: c.changes ?? null, unpushed: c.unpushed ?? null, linked: true };
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 300, height: 260, props: { menu: "checkout", path: c.path, main: r.main, on: r.on ?? null, branch: c.branch, account: accountOf(null, { main: r.main, on: r.on ?? null })?.id ?? null, info } });
}

// Levels step in by INDENT (see LEVEL1, LEVEL2): a worktree row's caret lines up with its
// siblings' icons, and the rows under it start one INDENT in from its own icon.
// A worktree no space shows: a click opens its Git dialog (with its menu's actions), right-click
// its menu (no space is made either way).
export function looseRow(v, r, t) {
  return h_flex().id(`loose-${r.c.path}`).h(ROW).flex_none().px(8).pl(LEVEL2).gap(7).items_center().rounded(6).cursor_pointer().text_size(TEXT)
    .text_color(hasWork(r.c) ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => openGit(null, "status", { folder: r.c.path, on: r.on }))
    .on_mouse_down("right", () => checkoutMenu(r))
    .child(wide(svg(CHROME("folder")).size(ICON - 2).flex_none().text_color(t.dim))) // like the agent rows beside it
    .child(div().flex_1().min_w(0).truncate().child(base(r.c.path)))
    .when(r.c.locked, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child("locked")))
    .child(agentBadge(`loose-agents-${r.c.path}`, agentsAt(v, r.repo, r.c.path, null, r.on), t))
    .child(laneBadge(v, `loose-lane-${r.c.path}`, r.on, r.c.path, t))
    .child(gitPill(`loose-git-${r.c.path}`, r.c.branch, r.c, { ahead: 0, behind: 0 }, t, null));
}

// A space's terminals (every tab's terminal panes): { pane, terminal, title, program, cwd, branch, status }.
function terminalsOf(w) {
  const tabs = new Map((w.tabs ?? []).map((t) => [t.id, t]));
  return panes().filter((p) => p.terminal && tabs.has(p.tab));
}
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

// A small label over a group under an unfolded space ("Terminals", "Worktrees").

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

// The account filter: v.accountFilter is null (every space), "none" (spaces on the default
// account) or an account's id. A filter on an account since removed shows every space.
export function accountFilterOf(v) {
  const f = v.accountFilter;
  return f === "none" || (f && accounts().some((a) => a.id === f)) ? f : null;
}

// Keeps the rows on the filtered account: a space by its own account (a worktree space by its
// repository's, unless it has its own), the worktrees without a space by the space they fold under.
export function byAccount(v, rows) {
  const f = accountFilterOf(v);
  if (!f) return rows;
  const of = {};
  return rows.filter((r) => {
    if (r.kind !== "space") return of[r.parent] === f;
    of[r.w.id] = accountOf(r.w, r.g ? { main: r.g.main, on: r.w.machine ?? null } : null)?.id ?? "none";
    return of[r.w.id] === f;
  });
}

// Under the header, once there is an account: All, each account, then no account (Default, or its name).
export function accountFilterRow(v, t) {
  const list = accounts();
  if (!list.length) return div();
  const cur = accountFilterOf(v);
  const opts = [[null, "All"], ...list.map((a) => [a.id, a.label]), ["none", defaultLabel()]];
  return h_flex().id("spaces-account-filter").flex_none().flex_wrap().gap(4).px(16).pb(6).text_size(12)
    .children(opts.map(([id, label]) => div().id(`spaces-account-${id ?? "all"}`).px(7).py(1).rounded_full().cursor_pointer()
      .border_1().border_color(cur === id ? t.accent : t.border).text_color(cur === id ? t.accent : t.muted)
      .when(cur === id, (e) => e.bg(t.accent + "14")).when(cur !== id, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { v.accountFilter = id; save("spaces.account", id); cx.notify(); })
      .child(label)));
}

export const isOpen = (v, id) => v.openSpaces?.has(id) ?? false;

// The ▸/▾ at a space's start: folds its terminals and agents, its worktree spaces and its
// worktrees without a space (remembered). A space with none gets the same width, empty.
// `icon`: an icon after the chevron, CARET_GAP from it, that folds with it (a worktree row's folder).
export function foldChevron(v, w, children, t, icon = null) {
  const n = children + terminalsOf(w).length;
  const open = isOpen(v, w.id);
  const caret = (on) => div().w(12).flex_none().flex().items_center().justify_center().rounded(3)
    .when(on, (el) => el.child(svg(CHROME(open ? "chevron-down" : "chevron-right")).size(11)));
  const box = icon ? h_flex().gap(CARET_GAP).flex_none().items_center().child(caret(n > 0)).child(icon) : caret(n > 0).w(22).h(28).ml(-5).mr(-7); // a space's own: a bigger target, the glyph where it was
  if (!n) return box;
  return box.id(`space-fold-${w.id}`).rounded(3).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(open ? "Fold" : "Show its terminals and worktrees")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      open ? v.openSpaces.delete(w.id) : v.openSpaces.add(w.id);
      save("spaces.terminals", [...v.openSpaces]);
      cx.notify();
    });
}

// A program's icon from Herdr's program table (Claude Code, Codex…): a one-color glyph (in the
// text color) or a picture. None for a shell: it shows the terminal icon. (Herdr reports
// `agent: false` for an idle agent, so the shell flag decides.)
export function programIcon(program, t, size = 14) {
  if (!program?.icon || program.shell) return null;
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(t.muted) : image(program.icon).w(size).h(size).flex_none();
}

// The + for a new space: the New space dialog (folder, name, Terminal or an agent), new-space.js.
export function newSpaceMenu(machine) {
  openOverlay({ mod: MOD, kind: "dialog", width: 560, height: 560, props: { dialog: "new-space", machine: machine ?? "" } });
}

const STATUS = { blocked: "blocked", done: "done", working: "working", idle: "idle" };
// Under an unfolded space (deeper under a worktree space): each terminal with its program, title, folder and branch, and its
// agent's status. A click goes to it; the eye peeks at it without leaving the shown space.
export function terminalRows(v, w, t, depth = 1) {
  if (!isOpen(v, w.id)) return [];
  // The space's own folder and branch (its first terminal's): a row repeats them only when its own differ.
  // An agent's folder is where it works now (agents-at.js), not where its shell last said.
  const live = shared(PLACES) ?? {};
  const own = terminalsOf(w), home = (live[own.find((p) => p.cwd)?.terminal]?.home || own.find((p) => p.cwd)?.cwd) ?? null;
  const list = own.map((p) => (live[p.terminal]?.cwd ? { ...p, cwd: live[p.terminal].cwd } : p)), first = list.find((p) => p.cwd) ?? null;
  // An agent in another checkout than the space's (the primary space's agent in a worktree) says which.
  const checkouts = Object.values(v.trees ?? {}).flat(), homeAt = checkoutAt(checkouts, home)?.path ?? null;
  const away = (p) => { const c = checkoutAt(checkouts, p.cwd)?.path ?? null; return c && homeAt && c !== homeAt ? base(c) : null; };
  return [...list.map((p) => terminalRow(p, t, depth, first, away(p))), newTabRow(w, t, depth)];
}

// "+ New terminal or agent…" at the end of a space's terminals: a menu of both, as its account.
function newTabRow(w, t, depth) {
  return h_flex().id(`term-new-${w.id}`).h(ROW - 2).flex_none().pl(depth > 1 ? LEVEL2 : LEVEL1).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
    .text_size(TEXT - 0.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => {
      const a = accountOf(w, null);
      openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 240, height: 260, props: { menu: "new-tab", space: w.id, account: a?.id ?? null } });
    })
    .child(wide(svg(CHROME("plus")).size(ICON).flex_none()))
    .child(div().flex_1().min_w(0).truncate().child("New agent or terminal…"));
}

function terminalRow(p, t, depth, first = null, away = null) {
    // A title that only says user@host or a path (a shell's default) says nothing: the program's name instead.
    const title = clean(p.title), telling = title && title !== p.program?.name && !title.includes("@") && !/^[~/]/.test(title);
    const name = telling ? title : p.program?.name || "terminal";
    // Only what differs from the space: another folder, another branch.
    const where = [p.cwd && p.cwd !== first?.cwd ? base(p.cwd) : "", p.branch && p.branch !== first?.branch ? p.branch : ""].filter(Boolean).join(" · ");
    const color = t[STATUS[p.status]] ?? t.dim;
    return h_flex().id(`term-${p.pane}`).h(ROW).flex_none().pl(depth > 1 ? LEVEL2 : LEVEL1).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
      .text_size(TEXT).text_color(p.focused ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("pane.focus", { pane: p.pane }))
      // An agent shows its own icon (Herdr's program table), a plain terminal the terminal icon.
      .child(wide(programIcon(p.program, t, ICON + 1) ?? svg(`${ICONS}/square-terminal.svg`).size(ICON).flex_none().text_color(t.dim)))
      .child(div().flex_shrink(0).max_w(140).truncate().child(name))
      .child(away
        ? div().flex_1().min_w(0).truncate().text_size(TEXT - 1).text_color(t.accent).child(`→ ${away}`)
        : div().flex_1().min_w(0).truncate().text_size(TEXT - 1).text_color(t.dim).child(where))
      .when(Boolean(p.status), (el) => el.child(div().size(6).flex_none().rounded(3).bg(color)))
      .child(div().id(`peek-${p.pane}`).flex_none().size(18).flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.raised ?? t.hover).text_color(t.foreground)).tooltip("Peek: see it here, without switching spaces")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: p.terminal }); })
        .child(svg(`${ICONS}/eye.svg`).size(14)));
}
