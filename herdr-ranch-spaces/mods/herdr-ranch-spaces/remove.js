// Delete a worktree that no space shows: the list opens itself as a dialog with
// props { dialog: "remove", path, main, on, branch }. It reads the checkout's work first and
// says what would go: uncommitted files are lost, commits stay on the branch (which is kept).
// Enter deletes, Esc cancels. A worktree a space shows goes through Herdr's own dialog instead,
// which closes the space too.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, exec, run, spaces, panes } from "herdr";
import { workIn, place } from "./git.js";

const MOD = "herdr-ranch-spaces";
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

export class RemoveDialog extends View {
  init(_props, cx) {
    this.work = undefined; // undefined: looking
    this.busy = false; this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    cx.spawn(async (cx) => {
      try {
        const remote = await exec("git", ["remote"], { cwd: p.main, on: p.on });
        this.work = await workIn(p.path, p.on, remote.code === 0 && remote.stdout.trim() !== "");
      } catch (e) { this.work = null; this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  go(cx) {
    const p = props();
    if (this.busy || this.work === undefined) return;
    // A space opened there since: Herdr's own Remove worktree closes it with the checkout.
    const ps = panes();
    if (spaces().some((s) => (s.machine ?? null) === (p.on ?? null) && inside(place(s, ps) ?? "", p.path))) {
      this.error = "A space is open in it now: use Remove worktree on that space."; cx.notify(); return;
    }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      // Uncommitted files need --force; the dialog said they'd be lost.
      const force = this.work?.changes > 0 ? ["--force"] : [];
      const r = await exec("git", ["worktree", "remove", ...force, p.path], { cwd: p.main, on: p.on, timeout: 600_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.busy = false;
      if (r.code === 0) return this.close();
      this.error = (r.stderr || r.stdout || "git worktree remove failed.").trim();
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props(), w = this.work;
    const line = (text, color) => div().text_color(color ?? t.muted).child(text);
    return v_flex().id("spaces-remove").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter") this.go(cx);
        else return;
        cx.stop_propagation();
      })
      .child(div().font_semibold().text_color(t.foreground).child(`Delete worktree ${p.branch ?? p.path.split("/").pop()}?`))
      .child(line(`Deletes ${p.path}. The branch${p.branch ? ` ${p.branch}` : ""} stays.`))
      .when(w === undefined, (el) => el.child(line("Looking for work in it…", t.dim)))
      .when(w?.changes > 0, (el) => el.child(line(`${w.changes} uncommitted file${w.changes === 1 ? "" : "s"}: they will be lost.`, t.blocked)))
      .when(w?.unpushed > 0, (el) => el.child(line(`${w.unpushed} commit${w.unpushed === 1 ? " is" : "s are"} not pushed anywhere: ${p.branch ? `they stay on ${p.branch}` : "the checkout is detached, so nothing will point at them"}.`, p.branch ? t.ansi3 : t.blocked)))
      .when(Boolean(w) && !(w.changes > 0) && !(w.unpushed > 0), (el) => el.child(line("No uncommitted files, nothing unpushed.", t.ansi2)))
      .when(Boolean(this.error), (el) => el.child(line(this.error, t.blocked)))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
        .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(this.busy ? "deleting…" : "↵ delete · esc cancel"));
  }
}
