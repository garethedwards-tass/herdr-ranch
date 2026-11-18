// Which agents work in a linked git worktree, for the worktree marker on their rows.
// The folder is where the agent works now: a Claude Code agent's latest session record (st.cwd,
// see places.js), else the terminal's folder. One `git rev-parse` per folder, kept a minute.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, terminals } from "herdr";

const EVERY = 60000;
const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();

// git's answer: top-level folder and common dir (one per line). A linked worktree's common dir
// isn't its own <top>/.git. Outside git: null.
export function parseRevParse(out) {
  const [top, common] = String(out ?? "").trim().split("\n").map((s) => s.trim().replace(/\/+$/, ""));
  if (!top || !common) return null;
  return { top, linked: common !== `${top}/.git`, main: common.replace(/\/\.git$/, "") };
}

// Where each agent works now: { address: cwd }.
export function agentFolders(list, claude, all) {
  const cwd = new Map((all ?? []).map((t) => [t.address, t.cwd]));
  return Object.fromEntries((list ?? []).map((a) => [a.address, claude?.get(a.address)?.st?.cwd || claude?.get(a.address)?.cwd || cwd.get(a.address) || null]).filter(([, c]) => c));
}

// Reads the folders not known or older than a minute; true when anything changed.
export async function refreshWorktrees(v, list) {
  v.wt ??= new Map(); // cwd -> { info, at }
  v.folders = agentFolders(list, v.claude, terminals());
  const now = Date.now();
  const due = [...new Set(Object.values(v.folders))].filter((c) => now - (v.wt.get(c)?.at ?? 0) > EVERY);
  let changed = false;
  await Promise.all(due.map(async (c) => {
    const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: c }).catch(() => null);
    const info = r?.code === 0 ? parseRevParse(r.stdout) : null;
    if (JSON.stringify(info) !== JSON.stringify(v.wt.get(c)?.info)) changed = true;
    v.wt.set(c, { info, at: now });
  }));
  return changed;
}

// For the agent's menu: { repo, top } of its worktree, or null.
export const worktreeProps = (v, a) => { const w = worktreeOf(v, a); return w ? { repo: base(w.main), top: w.top } : null; };
export const WORKTREE_H = 38; // the menu's two worktree lines
// The menu's worktree lines: which repository's worktree, and its full path.
export function worktreeLines(w, t) {
  return v_flex().px(8).pb(6).gap(2)
    .child(h_flex().gap(4).items_center().text_size(12).text_color(t.accent)
      .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
      .child(div().min_w(0).truncate().child(`In a worktree of ${w.repo}`)))
    .child(div().truncate().text_size(11.5).text_color(t.dim).child(w.top));
}

// The agent's worktree, or null in a main checkout or outside git.
export const worktreeOf = (v, a) => { const i = v.wt?.get(v.folders?.[a.address])?.info; return i?.linked ? i : null; };

// A branch icon and the worktree's folder name (the menu says which repository's: worktreeLines).
export function worktreeMark(v, a, t) {
  const w = worktreeOf(v, a);
  if (!w) return null;
  return h_flex().id(`ag-wt-${a.address}`).flex_shrink_1().min_w(0).max_w(96).gap(3).items_center().text_size(11).text_color(t.accent)
    .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
    .child(div().min_w(0).truncate().child(base(w.top)));
}
