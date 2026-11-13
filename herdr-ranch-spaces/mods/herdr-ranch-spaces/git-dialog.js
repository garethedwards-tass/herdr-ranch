// A checkout's git: the list opens itself as a dialog with props { dialog: "git", space, tab },
// or { dialog: "git", folder, on, tab } for a worktree no space shows.
// Header: the repository, the branch and its upstream, ↑ahead ↓behind, and Fetch and Pull.
// Status: the changed files, grouped (conflicts, staged, changes, untracked), each with git's
// letters. Branches: the repository's branches to switch the checkout to (or a new one); a branch
// checked out in another worktree goes to its space, or shows that worktree here when it has none.
// Switching with uncommitted changes asks first (with the files): stash them and switch (the
// stash is put back if the switch fails), bring them along (git refuses when they'd be
// overwritten), or cancel. Conflicts block a switch. The status is read again right before.
// Tab switches Status / Branches, ↑/↓ choose a branch, Enter switches, Esc closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, run, notify, knownAgents, settings } from "herdr";
import { place, probe, status, worktrees, branches, switchArgs, diverged, switchRisk, stashMessage, workIn, checkoutAt, base, notPushed } from "./git.js";
import { openRemove } from "./actions.js";
import { accountOf, argvAs, runAs } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const MAX_FILES = 300, MAX_BRANCHES = 100, DETAIL_LINES = 400;
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const GROUPS = [["conflict", "Conflicts", "blocked"], ["staged", "Staged", "ansi2"], ["both", "Staged and changed", "ansi3"], ["changed", "Changes", "ansi3"], ["untracked", "Untracked", "dim"]];

export class GitDialog extends View {
  init(_props, cx) {
    const p = props();
    this.tab = p.tab === "branches" ? "branches" : "status";
    this.folder = p.folder ?? null;
    this.space = this.folder ? null : spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
    this.on = this.folder ? p.on ?? null : this.space?.machine ?? null;
    this.g = undefined; this.st = null; this.list = []; this.checkouts = [];
    this.busy = ""; this.error = ""; this.canRebase = false;
    this.text = ""; this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Filter branches, or type a new branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at], cx));
    // A detached worktree's new branch name.
    this.nameInput = InputState.new({ placeholder: "new branch name, e.g. TASS-1234-graalvm" });
    this.nameInput.on("submit", (_e, cx) => this.makeBranch(cx));
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const folder = this.folder ?? (this.space ? place(this.space, panes()) : null);
        const g = folder ? await probe(folder, this.on) : null;
        if (g) {
          this.checkouts = await worktrees(g.main, this.on);
          [this.st, this.list, this.commits] = await Promise.all([status(g.top, this.on), branches(g.main, this.on, this.checkouts), notPushed(g.top, this.on).catch(() => [])]);
          // A worktree without a space: what it holds, and the agents a space can start with.
          if (this.folder) [this.info, this.agents] = await Promise.all([this.worktreeInfo(g), knownAgents({ on: this.on }).then((l) => l.filter((a) => a.installed && a.run?.length)).catch(() => [])]);
        }
        this.g = g;
      } catch (e) { this.g ??= null; this.error = String(e?.message ?? e); }
      cx.notify();
      // Opened to fetch or pull (the git button's popup): once, after the first read.
      const act = props()?.action;
      if (act && !this.acted && this.g) { this.acted = true; act === "pull" ? this.pull(cx) : this.fetch(cx); }
      if (this.tab === "branches") cx.timer.after(50, () => { try { this.input.focus(); } catch { /* closed */ } });
    });
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  // A space on this worktree with a terminal or an agent, as its repository's account if any.
  createSpace(agent = null) {
    const a = accountOf(null, { main: this.g.main, on: this.on });
    const argv = agent ? (a ? runAs(a, agent.run) : agent.run) : a ? argvAs(a) : null;
    this.close();
    run("space.new", { folder: this.g.top, machine: this.on ?? "", ...(argv ? { argv } : {}) });
  }

  // A detached worktree: a new branch at HEAD with the typed name.
  makeBranch(cx) {
    const name = this.nameInput.value().trim();
    if (!name) return;
    this.naming = false;
    this.git(`Made branch ${name}`, ["switch", "-c", name], cx, () => this.nameInput.set_value(""));
  }

  // Its last commit, what isn't pushed anywhere, and whether it's locked.
  async worktreeInfo(g) {
    const git = (args) => exec("git", args, { cwd: g.top, on: this.on }).catch(() => ({ code: 1, stdout: "" }));
    const [last, remote] = await Promise.all([git(["log", "-1", "--format=%h%x09%s%x09%an%x09%ct"]), git(["remote"])]);
    const [hash, subject, author, at] = last.code === 0 ? last.stdout.trim().split("\t") : [];
    const work = await workIn(g.top, this.on, remote.code === 0 && remote.stdout.trim() !== "").catch(() => null);
    const c = checkoutAt(this.checkouts, g.top);
    return { hash, subject, author, at: Number(at) || 0, unpushed: work?.unpushed ?? null, locked: Boolean(c?.locked) };
  }

  // One git command at a time; its output goes to a toast, its error into the dialog.
  git(label, args, cx, done) {
    if (this.busy || !this.g) return;
    this.busy = label; this.error = ""; this.canRebase = false; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("git", args, { cwd: this.g.top, on: this.on, timeout: 600_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.busy = "";
      if (r.code === 0) {
        const line = (r.stdout || r.stderr || "").trim().split("\n").filter(Boolean).pop() ?? "";
        notify({ title: `${label}: ${this.g.name}`, body: line.slice(0, 200), level: "success", timeout: 2500 });
        done?.();
      } else {
        this.error = (r.stderr || r.stdout || `git ${args[0]} failed.`).trim();
        this.canRebase = args[0] === "pull" && !args.includes("--rebase") && diverged(this.error);
      }
      this.load(cx);
    });
  }

  pull(cx, rebase = false) { this.git(rebase ? "Pulled (rebase)" : "Pulled", ["pull", rebase ? "--rebase" : "--ff-only"], cx); }
  fetch(cx) { this.git("Fetched", ["fetch", "--prune"], cx); }

  rows() {
    const f = this.text.trim(), lf = f.toLowerCase();
    const hits = this.list.filter((b) => !lf || b.name.toLowerCase().includes(lf));
    const exact = this.list.some((b) => b.name === f);
    return [...(f && !exact ? [{ name: f, fresh: true }] : []), ...hits].slice(0, MAX_BRANCHES);
  }

  // A branch: switch to it here, or go to the worktree that has it.
  pick(b, cx) {
    if (!b || this.busy || !this.g || b.name === this.st?.branch) return;
    if (b.path && b.path !== this.g.top) {
      const ps = panes(), s = spaces().find((x) => (x.machine ?? null) === this.on && inside(place(x, ps) ?? "", b.path));
      // Its space if it has one; else this dialog moves to that worktree (no space is made).
      if (s) { this.close(); run("space.select", { id: s.id }); return; }
      this.folder = b.path; this.space = null; this.g = undefined; this.st = null; this.error = "";
      this.input.set_value(""); this.text = ""; this.at = 0; this.tab = "status"; this.handle.focus();
      cx.notify(); this.load(cx);
      return;
    }
    if (this.busy) return;
    this.busy = "Checking"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      // Read now: the files may have changed since the dialog opened.
      try { this.st = await status(this.g.top, this.on); } catch (e) { this.busy = ""; this.error = String(e?.message ?? e); cx.notify(); return; }
      this.busy = "";
      const risk = switchRisk(this.st.files);
      if (risk.conflicts.length) { this.error = `Resolve the ${risk.conflicts.length} conflicted file${risk.conflicts.length === 1 ? "" : "s"} before switching branches.`; cx.notify(); return; }
      if (risk.tracked.length) { this.confirm = { b, ...risk }; this.handle.focus(); cx.notify(); return; }
      this.switchTo(b, null, cx);
    });
  }

  // `stash`: stash the tracked changes first and put them back if the switch fails.
  switchTo(b, stash, cx) {
    const from = this.st?.branch;
    this.confirm = null;
    this.busy = stash ? "Stashing" : "Switching"; this.error = ""; cx.notify();
    const git = (args) => exec("git", args, { cwd: this.g.top, on: this.on, timeout: 600_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    cx.spawn(async (cx) => {
      const msg = stashMessage(from, b.name);
      if (stash) {
        const r = await git(["stash", "push", "-m", msg]);
        if (r.code !== 0) { this.busy = ""; this.error = `Couldn't stash, nothing was switched: ${(r.stderr || r.stdout).trim()}`; return this.load(cx); }
      }
      const r = await git(switchArgs(b));
      if (r.code !== 0) {
        let back = "";
        if (stash) {
          const pop = await git(["stash", "pop", "--index"]);
          back = pop.code === 0 ? " Your changes are back as they were." : ` Your changes are still in the stash ("${msg}"): git stash pop brings them back.`;
        }
        this.busy = ""; this.error = `${(r.stderr || r.stdout || "git switch failed.").trim()}${back}`;
        return this.load(cx);
      }
      this.busy = "";
      this.input.set_value(""); this.text = "";
      notify({ title: `Switched to ${b.name}`, body: stash ? `Your changes on ${from ?? "the old HEAD"} are stashed as "${msg}". git stash pop brings them back.` : this.st?.files?.length ? "Your uncommitted changes came along." : "", level: "success", timeout: stash ? 10000 : 3000 });
      this.load(cx);
    });
  }

  confirmView(t) {
    const c = this.confirm, cur = this.st?.branch ?? "detached HEAD", n = c.tracked.length;
    // A new branch usually wants the changes; an existing one usually wants a clean start.
    const bringFirst = Boolean(c.b.fresh);
    const bring = this.button("git-bring", `Bring them to ${c.b.name}`, t, (cx) => this.switchTo(c.b, false, cx), { primary: bringFirst });
    const stash = this.button("git-stash", "Stash them, then switch", t, (cx) => this.switchTo(c.b, true, cx), { primary: !bringFirst });
    return v_flex().gap(8).flex_1().min_h(0).p(12).rounded(8).border_1().border_color(t.ansi3 + "88").bg(t.ansi3 + "12")
      .child(div().font_semibold().text_color(t.foreground).child(`${n} uncommitted change${n === 1 ? "" : "s"} on ${cur}`))
      .child(div().text_size(12).text_color(t.muted).child(`Switching to ${c.b.fresh ? "a new branch " : ""}${c.b.name} with them:`))
      .child(v_flex().id("git-confirm-files").max_h(150).overflow_y_scrollbar().children(c.tracked.slice(0, 50).map((f, i) =>
        h_flex().id(`cf-${i}`).gap(8).h(20).items_center().child(div().w(18).flex_none().text_size(11).text_color(t.ansi3).child(`${f.x}${f.y}`.replace(/ /g, "·"))).child(div().min_w(0).truncate().text_size(12).child(f.path))))
        .when(n > 50, (el) => el.child(div().text_size(11).text_color(t.dim).child(`and ${n - 50} more`))))
      .child(v_flex().gap(3).text_size(11.5).text_color(t.muted)
        .child(`Stash: they're put away in git stash ("${stashMessage(this.st?.branch, c.b.name)}") and ${c.b.name} starts clean; git stash pop brings them back. If the switch fails they're put back.`)
        .child(`Bring: they move to ${c.b.name} as they are. git refuses (and nothing changes) when ${c.b.name} has other versions of those files.`)
        .when(c.untracked > 0, (el) => el.child(`${c.untracked} untracked file${c.untracked === 1 ? "" : "s"} stay in the folder either way.`)))
      .child(h_flex().gap(8).pt(4)
        .child(bringFirst ? bring : stash).child(bringFirst ? stash : bring)
        .child(this.button("git-cancel", "Cancel", t, (cx) => { this.confirm = null; cx.notify(); })));
  }

  key(e, cx) {
    const n = this.rows().length;
    if (this.confirm) {
      // Only an explicit choice switches: S stash, B bring, Esc cancel.
      if (e.key === "escape") { this.confirm = null; cx.notify(); }
      else if (e.key === "s") this.switchTo(this.confirm.b, true, cx);
      else if (e.key === "b") this.switchTo(this.confirm.b, false, cx);
      else return;
      return cx.stop_propagation();
    }
    if (e.key === "escape") this.close();
    else if (this.tab === "branches" && (e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  button(id, label, t, onClick, { primary = false, disabled = false, icon = null, danger = false } = {}) {
    return h_flex().id(id).flex_none().gap(6).items_center().px(10).py(4).rounded(6).text_size(12).cursor_pointer()
      .when(primary && !disabled, (el) => el.bg(t.accent).text_color(t.background).font_semibold())
      .when(!primary || disabled, (el) => el.border_1().border_color(danger ? t.blocked + "66" : t.border).bg(t.background).text_color(disabled ? t.dim : danger ? t.blocked : t.foreground))
      .when(!disabled, (el) => el.hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(icon), (el) => el.child(icon))
      .child(label);
  }

  // A program's icon for a button (Herdr's program table): a glyph in the text color or a picture.
  icon(path, tint, t) {
    return tint === false ? image(path).w(14).h(14).flex_none() : svg(path).size(14).flex_none().text_color(t.muted);
  }

  // The worktree's details: path, branch and upstream, last commit, unpushed commits, locked.
  worktreeView(t, g, st) {
    const i = this.info, line = (label, value, color) => h_flex().gap(8).min_h(22).items_center()
      .child(div().w(84).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(typeof value === "string" ? div().flex_1().min_w(0).truncate().text_size(12.5).text_color(color ?? t.foreground).child(value) : value);
    const ago = (s) => { if (!s) return ""; const d = Date.now() / 1000 - s; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`; };
    const changed = st?.files?.length ?? 0;
    return v_flex().gap(2).px(12).py(10).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(line("Branch", h_flex().flex_1().min_w(0).gap(8).items_center().text_size(12.5)
        .child(div().min_w(0).truncate().text_color(st?.branch ? t.accent : t.ansi3).child(st?.branch ?? "detached"))
        .child(div().flex_none().text_color(t.dim).child(st?.upstream ? `→ ${st.upstream}` : "no upstream"))))
      .child(line("Uncommitted", changed ? `${changed} file${changed === 1 ? "" : "s"}` : "none", changed ? t.ansi3 : t.ansi2))
      .child(line("Not pushed", i ? (i.unpushed == null ? "?" : i.unpushed === 0 ? "nothing: every commit is on a remote" : `${i.unpushed} commit${i.unpushed === 1 ? "" : "s"} only in this worktree`) : "…", i?.unpushed > 0 ? t.accent : t.ansi2))
      // Detached with commits nowhere else: deleting the worktree leaves nothing pointing at them.
      .when(i?.unpushed > 0 && !st?.branch, (el) => el.child(line("", "detached: push them or make a branch before deleting it", t.ansi3)))
      // Detached: put HEAD on a new branch (`git switch -c`), so its commits have a name.
      .when(!st?.branch, (el) => el.child(line("", this.naming
        ? h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_1().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.popover).child(Input.new(this.nameInput)))
          .child(this.button("git-make-branch-go", "Make", t, (cx) => this.makeBranch(cx), { primary: true }))
        : h_flex().child(this.button("git-make-branch", "Make a branch…", t, (cx) => { this.naming = true; cx.notify(); cx.timer.after(30, () => { try { this.nameInput.focus(); } catch { /* closed */ } }); })))))
      .child(line("Last commit", i?.hash ? i.subject : i ? "none" : "…"))
      .when(Boolean(i?.hash), (el) => el.child(line("", `${i.hash} · ${i.author} · ${ago(i.at)}`, t.dim)))
      .when(Boolean(i?.locked), (el) => el.child(line("Locked", "git won't prune or remove it without --force", t.ansi3)))
      .child(line("Folder", h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(g.top))
        .child(div().id("git-copy-path").flex_none().px(6).rounded(4).text_size(11.5).text_color(this.copied ? t.ansi2 : t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.write_to_clipboard(g.top); this.copied = true; cx.notify(); })
          .child(this.copied ? "Copied" : "Copy"))));
  }

  // A file's diff or a commit, opened under its row (a click again closes it).
  toggle(key, args, cx) {
    if (this.open?.key === key) { this.open = null; cx.notify(); return; }
    this.open = { key, lines: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("git", args, { cwd: this.g.top, on: this.on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      if (this.open?.key !== key) return;
      // diff --no-index exits 1 when the files differ: its output is still the diff.
      const text = (r.stdout || r.stderr || "").replace(/\n$/, "");
      const lines = text ? text.split("\n") : ["(no differences)"];
      this.open = { key, lines: lines.slice(0, DETAIL_LINES), more: Math.max(0, lines.length - DETAIL_LINES) };
      cx.notify();
    });
  }

  detailView(key, t) {
    if (this.open?.key !== key) return [];
    const o = this.open, font = settings()?.font_family;
    const color = (l) => (l.startsWith("+++") || l.startsWith("---") ? t.muted : l.startsWith("+") ? t.ansi2 : l.startsWith("-") ? t.ansi1 : l.startsWith("@@") ? t.accent : /^(diff |index |commit |Author:|Date:)/.test(l) ? t.dim : t.foreground);
    return [v_flex().id(`detail-${key}`).ml(6).mr(2).my(2).px(10).py(6).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(11.5)
      .when(Boolean(font), (el) => el.font_family(font))
      .when(!o.lines, (el) => el.child(div().text_color(t.dim).child("…")))
      .children((o.lines ?? []).map((l, n) => div().id(`dl-${n}`).min_h(16).whitespace_nowrap().truncate().text_color(color(l)).child(l || " ")))
      .when(o.more > 0, (el) => el.child(div().pt(4).text_color(t.dim).child(`and ${o.more} more lines`)))];
  }

  statusView(t) {
    const st = this.st;
    const commits = this.commits ?? [];
    if (!st.files.length && !commits.length) return div().p(10).text_color(t.dim).child("Clean: nothing uncommitted, and every commit is on a remote.");
    let left = MAX_FILES;
    const groups = GROUPS.map(([kind, label, color]) => {
      const files = st.files.filter((f) => f.kind === kind);
      if (!files.length) return null;
      const shown = files.slice(0, Math.max(0, left));
      left -= shown.length;
      return v_flex().gap(1).flex_none()
        .child(h_flex().gap(6).py(4).text_size(11).text_color(t.muted).child(label).child(div().text_color(t[color] ?? t.dim).child(String(files.length))))
        .children(shown.flatMap((f, i) => [h_flex().id(`file-${kind}-${i}`).gap(8).h(22).px(6).rounded(4).items_center().cursor_pointer()
          .when(this.open?.key === `f:${f.path}`, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(`f:${f.path}`, f.kind === "untracked" ? ["--no-pager", "diff", "--no-color", "--no-index", "--", "/dev/null", f.path] : ["--no-pager", "diff", "--no-color", "HEAD", "--", f.path], cx))
          .child(div().w(18).flex_none().text_size(11).text_color(t[color] ?? t.dim).child(`${f.x}${f.y}`.replace(/ /g, "·")))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(f.path)),
          ...this.detailView(`f:${f.path}`, t)]));
    }).filter(Boolean);
    const ago = (x) => { if (!x) return ""; const d = Date.now() / 1000 - x; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`; };
    const head = (text, n, color) => h_flex().gap(6).py(4).text_size(11).text_color(t.muted).child(text).child(div().text_color(color).child(String(n)));
    const pushedNot = commits.length ? [v_flex().gap(1).flex_none()
      .child(head("Not pushed: only here", commits.length, t.accent))
      .children(commits.flatMap((c, n) => [h_flex().id(`np-${n}`).gap(8).h(22).px(6).rounded(4).items_center().cursor_pointer()
        .when(this.open?.key === `c:${c.hash}`, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(`c:${c.hash}`, ["--no-pager", "show", "--no-color", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", c.hash], cx))
        .child(div().w(64).flex_none().text_size(11.5).text_color(t.accent).child(c.hash))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.subject))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${c.author.split(" ")[0]} · ${ago(c.at)}`)),
        ...this.detailView(`c:${c.hash}`, t)]))] : [];
    return v_flex().gap(6).children(groups).when(!st.files.length, (el) => el.child(div().px(6).text_size(12).text_color(t.dim).child("No uncommitted files."))).children(pushedNot)
      .when(st.files.length > MAX_FILES, (el) => el.child(div().text_size(11).text_color(t.dim).child(`and ${st.files.length - MAX_FILES} more`)));
  }

  branchesView(t) {
    const rows = this.rows(), cur = this.st?.branch;
    const dirty = (this.st?.files ?? []).some((f) => f.kind !== "untracked");
    return v_flex().gap(6).flex_1().min_h(0)
      .child(div().h(32).px(10).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background).text_color(t.foreground).child(Input.new(this.input)))
      .when(dirty, (el) => el.child(div().text_size(11).text_color(t.ansi3).child("You have uncommitted changes: switching asks whether to stash them or bring them along.")))
      .child(v_flex().id("git-branches").flex_1().min_h(0).overflow_y_scrollbar()
        .children(rows.map((b, i) => {
          const here = b.name === cur, elsewhere = b.path && b.path !== this.g.top;
          return h_flex().id(`branch-${i}`).flex_none().h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.at, (el) => el.bg(t.selected)).when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => { this.at = i; this.pick(b, cx); })
            .child(div().flex_1().min_w(0).truncate().text_color(here ? t.accent : t.foreground).child(b.fresh ? `Create and switch to ${b.name}` : b.name))
            .when(Boolean(b.remote), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(b.remote)))
            .when(here, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("current")))
            .when(Boolean(elsewhere), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("in another worktree")));
        }))
        .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No branches."))));
  }

  render() {
    const t = theme(), g = this.g, st = this.st;
    const upstream = st ? (st.gone ? "upstream gone" : st.upstream ? `→ ${st.upstream}` : "no upstream") : "";
    return v_flex().id("spaces-git").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().gap(8).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().text_color(t.foreground).child(g ? (this.folder ? base(g.top) : this.tab === "branches" ? `Switch branch · ${g.name}` : g.name) : "Git"))
            .when(Boolean(st) && !this.folder, (el) => el.child(div().min_w(0).truncate().text_color(t.accent).child(st.branch ?? "detached"))))
          .when(Boolean(this.folder && g), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`Worktree of ${g.name} · no space`)))
          .when(Boolean(st) && !this.folder, (el) => el.child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
            .child(div().min_w(0).truncate().child(upstream))
            .when(st.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${st.ahead}`)))
            .when(st.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${st.behind}`)))
            .child(div().flex_none().child(`${st.files.length} changed`)))))
        .when(Boolean(st) && (this.tab === "status" || this.folder), (el) => el
          .child(this.button("git-fetch", "Fetch", t, (cx) => this.fetch(cx), { disabled: Boolean(this.busy) }))
          .child(this.button("git-pull", st.behind > 0 ? `Pull ↓${st.behind}` : "Pull", t, (cx) => this.pull(cx), { primary: st.behind > 0, disabled: Boolean(this.busy) || !st.upstream || st.gone }))))
      // A worktree without a space: what it holds, then its right-click menu's actions.
      .when(Boolean(this.folder && g), (el) => el.child(this.worktreeView(t, g, st)))
      .when(Boolean(this.folder && g), (el) => el.child(v_flex().gap(6)
        .child(div().text_size(11.5).text_color(t.muted).child("Open in a new space"))
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(this.button("git-space-terminal", "Terminal", t, () => this.createSpace(), { icon: svg("data/herdr-ranch-spaces/icons/square-terminal.svg").size(14).flex_none().text_color(t.muted) }))
          .children((this.agents ?? []).map((a, i) => this.button(`git-space-agent-${i}`, a.name, t, () => this.createSpace(a), { icon: a.icon ? this.icon(a.icon, a.tint, t) : null }))))))
      .when(g === undefined, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(g === null, (el) => el.child(div().text_color(t.muted).child(this.error || "This space isn't in a git repository.")))
      .when(Boolean(st), (el) => el
        // A worktree keeps its branch: no Branches tab there, its Status only.
        // One view per dialog (Git status, or Switch branch), no tabs.
        .when(this.tab === "status" || this.folder, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(this.commits?.length || st.files.length ? "Uncommitted and unpushed" : "Status")))
        .child(this.confirm ? this.confirmView(t) : this.tab === "status" || this.folder
          ? v_flex().id("git-status").flex_1().min_h(0).overflow_y_scrollbar().child(this.statusView(t))
          : this.branchesView(t)))
      .when(Boolean(this.error) && g !== null, (el) => el.child(v_flex().gap(6).max_h(120).id("git-error").overflow_y_scrollbar()
        .child(div().text_size(12).text_color(t.blocked).child(this.error))
        .when(this.canRebase, (el) => el.child(h_flex().child(this.button("git-rebase", "Pull with rebase", t, (cx) => this.pull(cx, true), { primary: true }))))))
      .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
        .when(Boolean(this.folder && g), (el) => el.child(this.button("git-delete-wt", "Delete worktree…", t, () => { this.close(); openRemove({ path: g.top, main: g.main, on: this.on, branch: st?.branch ?? null }); }, { disabled: !g.linked, danger: true })).child(div().flex_1()))
        .when(Boolean(this.busy), (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(this.busy ? "working…" : this.confirm ? "s stash · b bring · esc cancel" : this.folder ? (this.naming ? "↵ make the branch · esc close" : "esc close") : this.tab === "branches" ? "↑↓ choose · ↵ switch · esc close" : "esc close"));
  }
}
