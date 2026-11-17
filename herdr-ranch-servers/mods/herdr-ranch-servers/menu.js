// herdr-ranch: the menus the panel opens as popups (props.menu), in the Spaces menu's style: a
// summary at the top, a divider, then the actions.
//   { menu: "container", machine, container }  Logs…, Restart (a second click confirms), Copy name, Copy ID
//   { menu: "machine", machine, state, stats }  Refresh, Hide / Show stopped containers
//   { menu: "lane", machine, dir, lane }        a lane: Open site, Copy URL, Go to space
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, closeOverlay, openOverlay, exec, notify, shared, setShared, spaces, run } from "herdr";
import { laneState, hostOf } from "./lanes.js";
import { FIND_DOCKER, upFor } from "./probe.js";
import { MOD, KEY_REFRESH, KEY_HIDE_STOPPED, label, healthColor, containerColor, toneColor, meterColor } from "./panel.js";

const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
const days = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 3600)}h`);

export class Menu {
  init(_p, cx) {
    this.confirming = false;
    this.busy = false;
  }

  close() { closeOverlay(props().overlay); }

  restart(cx) {
    const p = props(), c = p.container;
    if (!this.confirming) { this.confirming = true; cx.notify(); return; }
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", `${FIND_DOCKER}; [ -n "$D" ] || { echo "docker not found" >&2; exit 127; }; exec "$D" restart -- "$1"`, "sh", c.name], { on: p.machine }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) notify({ title: `Couldn't restart ${c.name}`, body: (r.stderr || r.stdout || "").trim().split("\n")[0], level: "error" });
      else notify({ title: `Restarted ${c.name}`, body: label(p.machine), level: "success", timeout: 3000 });
      setShared(KEY_REFRESH, Date.now());
      this.close();
    });
  }

  items(cx) {
    const p = props();
    if (p.menu === "container") {
      const c = p.container;
      return [
        { id: "logs", label: "Logs…", icon: "file-text", go: () => { this.close(); openOverlay({ mod: MOD, kind: "dialog", width: 760, height: 520, props: { view: "logs", machine: p.machine, container: c.name } }); } },
        { id: "restart", label: this.busy ? "Restarting…" : this.confirming ? `Restart ${c.name}? Click again` : "Restart", icon: "square-pen", danger: this.confirming, go: (cx) => !this.busy && this.restart(cx) },
        { id: "copy-name", label: "Copy name", icon: "files", go: (cx) => { cx.write_to_clipboard(c.name); this.close(); } },
        { id: "copy-id", label: "Copy ID", icon: "files", go: (cx) => { cx.write_to_clipboard(c.id); this.close(); } },
      ];
    }
    if (p.menu === "lane") {
      const l = p.lane;
      // The Herdr space whose folder is a worktree the lane serves (or its owner's path).
      const paths = [...l.served.map((w) => w.path), l.owner?.path].filter(Boolean);
      const space = spaces().find((s) => (s.machine ?? null) === (p.machine ?? null) && paths.includes(s.folder));
      return [
        ...(l.url ? [{ id: "open", label: "Open site", icon: "monitor", go: (cx) => { cx.open_url(l.url); this.close(); } },
          { id: "copy-url", label: "Copy URL", icon: "files", go: (cx) => { cx.write_to_clipboard(l.url); this.close(); } }] : []),
        ...(space ? [{ id: "space", label: `Go to space ${space.name}`, icon: "folder", go: () => { run("space.select", { id: space.id }); this.close(); } }] : []),
      ];
    }
    const hide = shared(KEY_HIDE_STOPPED) === true;
    return [
      { id: "refresh", label: "Refresh", icon: "clock", go: () => { setShared(KEY_REFRESH, Date.now()); this.close(); } },
      { id: "stopped", label: hide ? "Show stopped containers" : "Hide stopped containers", icon: "layers", go: () => { setShared(KEY_HIDE_STOPPED, !hide); this.close(); } },
    ];
  }

  header(t) {
    const p = props(), line = (text, color) => div().truncate().text_size(12).text_color(color ?? t.dim).child(text);
    if (p.menu === "container") {
      const c = p.container;
      return v_flex().gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().size(7).flex_none().rounded(4).bg(healthColor(c.health, t)))
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(c.name)))
        .child(line(c.status || upFor(c), healthColor(c.health, t)))
        .when(Boolean(c.usage), (e) => e.child(line(`Memory ${c.usage.mem} (${c.usage.memPct.toFixed(1)}%) · CPU ${c.usage.cpuPct.toFixed(1)}%`, containerColor(c, c.health, t))))
        .child(line(c.image))
        .child(line([c.project, label(p.machine)].filter(Boolean).join(" · ")));
    }
    if (p.menu === "lane") {
      const l = p.lane, st = laneState(l);
      const short = (path) => String(path ?? "").replace(/^\/Users\/[^/]+/, "~");
      return v_flex().gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().size(7).flex_none().rounded(4).bg(toneColor(st.tone, t)))
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(`Lane ${l.n}`))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(hostOf(l.url))))
        .child(line(`${l.state} · ${l.containers.length} containers`))
        .when(Boolean(l.database), (e) => e.child(line(`Database ${l.database}`)))
        .child(l.owner || l.branch ? line(`Held for ${l.owner || "-"}${l.branch && l.branch !== l.owner ? ` · ${l.branch}` : ""}`, t.accent) : line("Free: no one holds it", t.ansi2))
        .child(div().pt(2).text_size(12).text_color(t.muted).child("Serving"))
        .children(l.served.length ? l.served.map((w) => line(`${w.repo} → ${short(w.path)}`, t.foreground)) : [line("Every repo from its main checkout")]);
    }
    const s = p.stats, u = s?.usage;
    const meter = (name, pct) => div().text_color(pct == null ? t.dim : pct >= 75 ? meterColor(pct, t) : t.muted).child(`${name} ${pct == null ? "–" : `${pct}%`}`);
    return v_flex().gap(3)
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).flex_none().rounded(4).bg(toneColor(p.state?.tone, t)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(label(p.machine)))
        .when(Boolean(s?.uptime), (e) => e.child(div().flex_none().text_size(12).text_color(t.dim).child(`up ${days(s.uptime)}`))))
      .child(u ? h_flex().gap(10).text_size(12).child(meter("CPU", u.cpu)).child(meter("MEM", u.mem)).child(meter("DISK", u.disk)) : line(p.state?.text ?? "Not read yet"))
      .when(Boolean(s), (e) => e.child(line(s.dockerError ? `Docker: ${s.dockerError}` : `${s.total} containers · ${s.running} running${s.attention ? ` · ${s.attention} need you` : ""}`, s?.attention ? t.ansi1 : null)));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("servers-menu").w_full().p(5).bg(t.popover).text_size(12.8)
      .child(v_flex().px(8).pt(4).pb(8).mb(4).border_b_1().border_color(t.border).child(this.header(t)))
      .children(this.items(cx).map((m) => h_flex().id(`servers-menu-${m.id}`).flex_none().h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(m.danger ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => m.go(cx))
        .child(svg(CHROME(m.icon)).size(13).flex_none().text_color(m.danger ? t.ansi1 : t.muted))
        .child(div().flex_1().truncate().child(m.label))));
  }
}
