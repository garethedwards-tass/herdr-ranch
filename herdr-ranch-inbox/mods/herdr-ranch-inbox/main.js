// The open Plannotator sessions (plan and code review pages agents opened for you), for the
// shown space or all, next to the Issues and Pull requests mods, from `plannotator sessions`.
// A click opens the page in the default browser. Read only: you review in Plannotator's page.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, nextCommand, shared, setShared, spaces, notify, watchFolder, home } from "herdr";
import { activeSpace, spaceRepo, openSettings, settingsMenu, OPENS, writeIcons, icon, avatar, segmented, fs, readSizes, migrateSettings } from "./links.js";
import { kit } from "./page-kit.js";
import { readSessions, sessionInSpace, openPage, which, closeSession } from "./inbox.js";

const MOD = "herdr-ranch-inbox";
const SPINNER = "mods/workspace-chrome/spinner.svg", COG = "mods/workspace-chrome/settings.svg";
const EVERY = 30000; // a fallback: the sessions folder and the window coming back to the front refresh sooner
const STUCK = 20000; // a refresh still running after this long (a hung command) no longer blocks a new one

// What a session reviews: its file or branch ("annotate-plan.md" shows as plan.md).
const title = (x) => (x.label && x.label !== "-" ? x.label.replace(/^(annotate|review)-/, "").split(/[/\\]/).pop() : x.mode === "review" ? "Code review" : "Plan")
  .replace(/^last$/, "Last answer");

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

export default class RanchInbox extends View {
  init(_props, cx) {
    migrateSettings(MOD);
    if (props()?.settings) return;
    this.sessions = []; this.missing = false; this.loading = false; this.error = null;
    this.scope = "space"; this.cursor = null; this.keys = false; this.seen = null; this.main = null; this.mainFor = null;
    this.gen = 0; this.loadingSince = 0; this.again = false; this.shownFor = this.space()?.id ?? null;
    this.handle = cx.focus_handle();
    this.home = props()?.space ?? null;
    cx.spawn(async (cx) => { await writeIcons(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(EVERY, (cx) => { if (this.visible()) this.refresh(cx); });
    // A session opening or closing writes or removes its record in ~/.plannotator/sessions.
    cx.spawn(async (cx) => { try { for (;;) { await watchFolder(`${home()}/.plannotator/sessions`); if (this.visible()) this.refresh(cx); } } catch { /* no folder yet, or the copy is closing */ } });
    // Back from the browser: Herdr's window gets the focus again.
    this.front = true;
    cx.timer.every(1000, (cx) => {
      let now = true; try { now = window.is_window_active(); } catch { /* unknown: treat as in front */ }
      if (now && !this.front && this.visible()) this.refresh(cx);
      this.front = now;
    });
    cx.spawn(async (cx) => { try { for (;;) this.command(await nextCommand(), cx); } catch { /* the copy is closing */ } });
  }

  space() { return this.home ? spaces().find((s) => s.id === this.home) ?? null : activeSpace(); }
  visible() { return !this.home || Boolean(this.space()?.active); }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "down") this.move(1, cx);
    else if (name === "up") this.move(-1, cx);
    else if (name === "open") { const r = this.rows().find((x) => x.key === this.cursor); if (r) this.open(r); }
    else if (name === "latest") { const r = this.rows()[0] ?? (this.sessions[0] && { session: this.sessions[0] }); if (r) this.open(r); }
    else if (name === "focus") { try { this.handle.focus(); } catch { /* not shown */ } }
    else if (name === "close" && props()?.overlay) closeOverlay(props().overlay);
  }

  // One refresh at a time (`gen`): one asked for while another runs follows it (`again`), and
  // one stuck past STUCK (a hung command) is superseded: its answer, if it ever comes, is dropped.
  refresh(cx) {
    if (this.loading && Date.now() - this.loadingSince < STUCK) { this.again = true; return; }
    const gen = ++this.gen, current = () => gen === this.gen;
    this.loading = true; this.loadingSince = Date.now(); this.again = false; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const space = this.space();
        if (space && this.mainFor !== space.id) {
          const main = (await spaceRepo(space).catch(() => null))?.main ?? null;
          if (!current()) return;
          this.main = main; this.mainFor = space.id;
        }
        const missing = !(await which("plannotator"));
        const sessions = (await readSessions()) ?? [];
        if (!current()) return;
        this.missing = missing; this.sessions = sessions; this.error = null;
        this.toastNew();
        this.publishBadge(space);
      } catch (e) { if (current()) this.error = String(e?.message ?? e); }
      finally {
        if (current()) {
          this.loading = false; cx.notify();
          if (this.again) this.refresh(cx);
        }
      }
    });
  }

  // A toast when a session opens after the list first loaded (an agent asks for a review).
  toastNew() {
    const key = (x) => x.url;
    if (this.seen && !this.home && !props()?.overlay) {
      const fresh = this.sessions.find((x) => !this.seen.has(key(x)));
      if (fresh) notify({ title: fresh.mode === "review" ? "A code review is ready" : "A plan is ready to review", body: `${title(fresh)} · ${fresh.project ?? ""}`,
        level: "info", timeout: 8000, action: { name: `${MOD}.latest` } });
    }
    this.seen = new Set(this.sessions.map(key));
  }

  // The count on the button (mod-buttons): open sessions in the shown space.
  publishBadge(space) {
    if (props()?.overlay || !space || (this.home && !this.visible())) return;
    const count = this.sessions.filter((x) => x.alive !== false && sessionInSpace(x, space, this.main)).length;
    const all = shared("mod-badges") ?? {}, mine = typeof all[MOD] === "object" && all[MOD] ? all[MOD] : {};
    if ((mine[space.id] ?? 0) === count) return;
    const next = { ...mine, [space.id]: count };
    if (!count) delete next[space.id];
    setShared("mod-badges", { ...all, [MOD]: next });
  }

  // The rows: the shown space's sessions (or all), newest first.
  rows() {
    // The main checkout read for another space doesn't count (a space switch, until the refresh it starts lands).
    const space = this.space(), main = space && this.mainFor === space.id ? this.main : null;
    return this.sessions.filter((x) => this.scope === "all" || sessionInSpace(x, space, main))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map((x) => ({ key: `s-${x.url}`, session: x }));
  }

  move(by, cx) {
    const rows = this.rows();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === this.cursor);
    this.cursor = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + by))].key; this.keys = true;
    cx.notify();
  }

  open(r) { if (r.session.alive !== false) openPage(r.session.url); }

  // × asks first (`confirming`), then stops a running session or removes a stopped one's record.
  closeRow(x, cx) {
    if (this.confirming !== x.url) { this.confirming = x.url; cx.notify(); return; }
    this.confirming = null;
    cx.spawn(async (cx) => {
      const failed = await closeSession(x);
      if (failed) notify({ title: x.alive ? "Not stopped" : "Not removed", body: failed, level: "warning", timeout: 4000 });
      this.refresh(cx);
    });
  }

  render(cx) {
    readSizes();
    if (props()?.settings) return settingsMenu(MOD, [OPENS], false);
    const t = theme(), k = kit(t), overlay = props()?.overlay, space = this.space();
    // A space switch: its main checkout is read right after this render (never cx.notify in a render).
    if ((space?.id ?? null) !== this.shownFor) {
      this.shownFor = space?.id ?? null;
      try { cx.timer.after(0, (cx) => this.refresh(cx)); } catch { /* the next session change or the 30 s timer refreshes */ }
    }
    const rows = this.rows();
    const plans = rows.filter((r) => r.session.mode !== "review"), reviews = rows.filter((r) => r.session.mode === "review");
    const spaceOf = (x) => (x.folder ? spaces().find((sp) => sessionInSpace(x, sp, null))?.name : null) ?? x.project;
    const heading = (label, n) => h_flex().h(fs.head).flex_none().px(10).gap(6).items_end().text_size(fs.meta).text_color(t.dim)
      .child(div().font_semibold().child(label)).child(div().child(String(n)));
    const pill = (text, c) => div().flex_none().px(6).py(1).rounded(4).border_1().border_color(c + "66").bg(c + "12").text_size(fs.tiny).text_color(c).child(text);
    const row = (r) => {
      const x = r.session, review = x.mode === "review", dead = x.alive === false, asking = this.confirming === x.url;
      const action = asking
        ? h_flex().flex_none().gap(4).items_center()
          .child(div().id(`stop-${r.key}`).px(8).py(2).rounded(5).bg(t.ansi1).text_color(t.background).text_size(fs.tiny).font_semibold().cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.closeRow(x, cx); }).child(dead ? "Remove" : "Stop session"))
          .child(div().id(`keep-${r.key}`).px(6).py(2).rounded(5).text_size(fs.tiny).text_color(t.muted).cursor_pointer().hover((e) => e.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.confirming = null; cx.notify(); }).child("Cancel"))
        : Number.isInteger(x.pid) || dead ? div().id(`x-${r.key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
          .hover((e) => e.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.closeRow(x, cx); }).child("×") : null;
      return h_flex().id(r.key).flex_none().gap(8).items_start().px(10).py(7).rounded(6)
        .when(dead, (e) => e.text_color(t.muted)).when(!dead, (e) => e.cursor_pointer().hover((e) => e.bg(t.hover)))
        .when(this.keys && this.cursor === r.key, (e) => e.bg(t.selected))
        .on_click((_e, cx) => { this.cursor = r.key; this.keys = false; this.open(r); cx.notify(); })
        .child(div().size(20).flex_none().rounded_full().bg((review ? t.ansi2 : t.ansi5) + "2e").flex().items_center().justify_center()
          .child(icon(review ? "pr" : "comment", review ? t.ansi2 : t.ansi5, 12)))
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().truncate().child(title(x)))
          .child(h_flex().gap(6).items_center()
            .child(pill(review ? "code review" : "annotate", review ? t.ansi2 : t.ansi5))
            .when(dead, (e) => e.child(pill("not running", t.dim)))
            .child(div().min_w(0).truncate().text_size(fs.meta).text_color(t.muted).child([this.scope === "all" ? spaceOf(x) : null, x.startedAt ? `opened ${ago(x.startedAt)} ago` : x.age ? `opened ${x.age}` : null].filter(Boolean).join(" · ")))))
        .when(Boolean(action), (e) => e.child(action));
    };

    const iconButton = (id, glyph, click) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(glyph);
    const empty = this.missing ? "Plannotator isn't installed: plannotator.ai" : this.error ? this.error
      : this.loading && !this.sessions.length ? "Loading…" : this.scope === "space" ? "No Plannotator session open for this space." : "No Plannotator session open.";
    return v_flex().id(MOD).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fs.body)
      .track_focus(this.handle)
      .on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* best effort */ } })
      .on_key_down((e, cx) => {
        if (e.key === "down") this.move(1, cx);
        else if (e.key === "up") this.move(-1, cx);
        else if (e.key === "enter") { const r = rows.find((x) => x.key === this.cursor); if (r) this.open(r); }
        else if (e.key === "escape" && overlay) closeOverlay(overlay);
        else return;
        cx.stop_propagation();
      })
      .child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_semibold().child("Inbox"))
          .child(div().flex_1().min_w(0).text_size(fs.meta).text_color(t.dim).truncate().child(this.scope === "space" ? space?.name ?? "" : "every project"))
          .child(iconButton("refresh", this.loading ? svg(SPINNER).size(14).spin(900) : "↻", (cx) => this.refresh(cx)))
          .child(iconButton("settings", svg(COG).size(14), () => openSettings(MOD)))
          .when(Boolean(overlay), (e) => e.child(iconButton("close", "×", () => closeOverlay(overlay)))))
        .child(h_flex().child(segmented("scope", [["space", "This space"], ["all", "All"]], this.scope, (id, cx) => { this.scope = id ?? "space"; cx.notify(); }, t, false))))
      .child(v_flex().id("inbox-list").flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .when(plans.length > 0, (e) => e.child(heading("Plans and documents", plans.length)).children(plans.map(row)))
        .when(reviews.length > 0, (e) => e.child(heading("Code reviews", reviews.length)).children(reviews.map(row)))
        .when(!rows.length, (e) => e.child(div().p(12).text_color(this.error ? t.ansi1 : t.dim).child(empty))))
      .child(k.footer([[["↑", "↓"], "move"], [["↵"], "open"], ...(overlay ? [[["Esc"], "close"]] : [])]));
  }
}
