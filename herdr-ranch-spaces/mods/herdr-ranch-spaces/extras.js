// What Herdr Ranch adds to Herdr's spaces list (main.js is a copy of Herdr's own `spaces` mod,
// changed only where it calls into this file; RECIPE.md lists those places). Each function takes
// the list's view (`v`) for its state: v.trees (repo -> worktrees with work), v.unfolded, v.pulling.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { openOverlay, exec, notify, spaces, nextCommand } from "herdr";
import { linkOf, openLinkDialog } from "./links.js";
import { LinkDialog } from "./link-dialog.js";
import { SpaceMenu } from "./menu.js";
import { NewDialog } from "./new.js";
import { RemoveDialog } from "./remove.js";
import { GitDialog } from "./git-dialog.js";
import { AccountDialog } from "./account-dialog.js";
import { accountOf } from "./accounts.js";
import { openNew, openGit, openAccount, ICONS } from "./actions.js";
import { tail, linkLabel, base, checkoutAt, hasWork, workText } from "./git.js";

export const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
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
export function spaceMenu(w, g) {
  const account = accountOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 260, height: 420, props: { menu: w.id, git: g ? (g.linked ? "linked" : "main") : null, account: account?.id ?? null } });
}

// ↓n on a row: `git pull --ff-only` in that checkout, a toast with how it went. `again(repo)`
// reads that repository's places again.
function pull(v, id, w, g, cx, again) {
  if (v.pulling.has(id)) return;
  v.pulling.add(id); cx.notify();
  cx.spawn(async (cx) => {
    const r = await exec("git", ["pull", "--ff-only"], { cwd: g.top, on: w.machine ?? null, timeout: 600_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    v.pulling.delete(id);
    if (r.code === 0) notify({ title: `Pulled ${g.name}`, body: (r.stdout || "").trim().split("\n").pop()?.slice(0, 200) ?? "", level: "success", timeout: 2500 });
    else notify({ title: `Couldn't pull ${g.name}`, body: `${(r.stderr || r.stdout || "").trim().slice(0, 300)}\nOpen Git on the space for Pull with rebase.`, level: "error", timeout: 8000 });
    again(g.repo, cx);
    cx.notify();
  });
}

// Outstanding work in a checkout: ● uncommitted files (ansi3), ↑ commits ahead of the upstream
// or on no remote (ansi2), ↓ behind (ansi1, a click pulls when `onPull`). Null when there's none.
function work(v, id, c, g, t, onPull) {
  const up = Math.max(g?.ahead ?? 0, c?.unpushed ?? 0), down = g?.behind ?? 0, changes = c?.changes ?? 0;
  if (!changes && !up && !down) return null;
  const words = [workText(c), g?.ahead > 0 && `${g.ahead} ahead of its upstream`, down > 0 && `${down} behind its upstream`].filter(Boolean).join("\n");
  return h_flex().id(id).flex_none().gap(4).items_center().text_size(11.5).tooltip(words || "Outstanding work")
    .when(changes > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(`●${changes}`)))
    .when(up > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${up}`)))
    .when(down > 0, (el) => el.child(div().id(`${id}-pull`).flex_none().px(2).rounded(3).text_color(t.ansi1)
      .when(Boolean(onPull), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(v.pulling.has(id) ? "Pulling…" : `${down} behind its upstream: click to pull (fast-forward only)`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onPull(cx); }))
      .child(v.pulling.has(id) ? "…" : `↓${down}`)));
}

function button(id, path, tip, t, onClick) {
  return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(svg(path).size(13));
}

// What follows a space's name, in place of Herdr's gitTail: the repository and branch (a click
// opens Git), its work, its link chip, and on the shown space Link space and New worktree.
export function spaceTail(v, { w, g, tree, at }, t, again) {
  const link = linkOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  const label = linkLabel(link);
  const account = accountOf(w, g ? { main: g.main, on: w.machine ?? null } : null);
  const where = tail(g, tree, w.name);
  const id = `space-work-${w.id}`;
  const busy = g ? work(v, id, checkoutAt(v.trees[g.repo], at), g, t, (cx) => pull(v, id, w, g, cx, again)) : null;
  return h_flex().flex_1().min_w(0).gap(5).items_center()
    .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11.5).text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().id(`space-git-${w.id}`).min_w(0).truncate().px(2).rounded(3)
        .when(Boolean(g), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Git: status, branches, pull")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); openGit(w.id); }))
        .child(where)))
      .when(Boolean(busy), (el) => el.child(busy)))
    .when(Boolean(account), (el) => el.child(div().id(`space-account-${w.id}`).flex_none().max_w(70).truncate().px(5).rounded(4).text_size(11).text_color(t.ansi5 ?? t.accent).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`Account: ${account.label}${account.claudeDir ? `\nClaude Code: ${account.claudeDir}` : ""}${account.ghUser ? `\nGitHub: ${account.ghUser}` : ""}\nClick to change`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openAccount(w.id); })
      .child(`@${account.label}`)))
    .when(Boolean(label), (el) => el.child(h_flex().id(`space-link-${w.id}`).flex_none().max_w(90).gap(3).items_center().px(5).rounded(4)
      .border_1().border_color(t.accent + "55").bg(t.accent + "14").text_size(11).text_color(t.accent).cursor_pointer()
      .hover((s) => s.bg(t.accent + "2a")).tooltip([link.github, link.jira?.key && `${link.jira.site} · ${link.jira.key}`, link.linear?.name].filter(Boolean).join("\n") + "\nClick to change the link")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openLinkDialog(MOD, w); })
      .child(svg(`${ICONS}/link.svg`).size(10).flex_none()).child(div().truncate().child(label))))
    .when(w.active && !label, (el) => el.child(button(`space-link-new-${w.id}`, `${ICONS}/link.svg`, "Link space: its GitHub repository and Jira or Linear project", t, () => openLinkDialog(MOD, w))))
    .when(w.active && Boolean(g), (el) => el.child(button(`space-worktree-${w.id}`, `${ICONS}/branch-plus.svg`, "New worktree from a branch or an issue", t, () => openNew(w.id, "branch"))));
}

// "n worktrees without a space": folds a repository's checkouts that no space shows.
export function moreRow(v, r, t) {
  return h_flex().id(`more-${r.repo}`).h(24).flex_none().px(8).pl(30).gap(6).items_center().rounded(6).cursor_pointer()
    .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
    .on_click((_e, cx) => {
      r.open ? v.unfolded.delete(r.repo) : v.unfolded.add(r.repo);
      save("spaces.unfolded", [...v.unfolded]);
      cx.notify();
    })
    .child(svg(CHROME(r.open ? "chevron-down" : "chevron-right")).size(11).flex_none())
    .child(div().truncate().child(`${r.count} worktree${r.count === 1 ? "" : "s"} without a space`))
    .when(r.busy > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(`· ${r.busy} with work`)));
}

// A worktree no space shows: a click opens its Git dialog (no space is made); right-click for more.
export function looseRow(v, r, t) {
  return h_flex().id(`loose-${r.c.path}`).h(26).flex_none().px(8).pl(30).gap(8).items_center().rounded(6).cursor_pointer()
    .text_color(hasWork(r.c) ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`${r.c.path}\nClick for its git status, right-click to create a space there or delete it`)
    .on_click(() => openGit(null, "status", { folder: r.c.path, on: r.on }))
    .on_mouse_down("right", () => openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 220, height: 180, props: { menu: "checkout", path: r.c.path, main: r.main, on: r.on ?? null, branch: r.c.branch, account: accountOf(null, { main: r.main, on: r.on ?? null })?.id ?? null } }))
    .child(svg(CHROME("git-branch")).size(13).flex_none().text_color(t.dim))
    .child(div().flex_shrink(0).max_w(150).truncate().child(r.c.branch ?? "detached"))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.c.branch && base(r.c.path) === r.c.branch.replace(/\//g, "-") ? "" : base(r.c.path)))
    .when(r.c.locked, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("locked")))
    .child(work(v, `loose-work-${r.c.path}`, r.c, null, t) ?? div());
}
