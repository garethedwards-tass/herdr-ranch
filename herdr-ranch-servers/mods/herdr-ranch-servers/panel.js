// herdr-ranch: the panel in the Spaces / Agents style. Each machine is a foldable row with a status
// pill; under it a line of meters and its containers, each with a health pill. A click on a pill (only
// there), or a right-click anywhere on a row, opens its menu (menu.js) with the details and the actions (Logs, Restart, …).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, exec, theme, notify, openOverlay, shared } from "herdr";
import { PROBE, parseProbe, containerHealth, needsAttention, usage, containerAlerts, shortStatus, machineState } from "./probe.js";
import { DEMO } from "./demo.js";
import { stacksOf, groupByLane, laneState, hostOf } from "./lanes.js";

export const MOD = "herdr-ranch-servers";
export const KEY_REFRESH = "ranch-servers.refresh"; // a menu's Restart asks the panel to look again
export const KEY_HIDE_STOPPED = "ranch-servers.hideStopped";
const REFRESH_MS = 30000;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
// The Spaces list's sizes: rows 31 high, 13px names, 20px pills of a fixed width.
const ROW = 31, TEXT = 13, PILL = 20, PILL_W = 104;
// As in Spaces: a machine row starts with its fold caret at the edge (a 22×28 target), then an 18px
// icon slot and the name 9px on; its children start at LEVEL1 with a 17px icon slot and a gap of 7.
const LEVEL1 = 27, ICON = 17, CHILD_TEXT = LEVEL1 + ICON + 7;
export const label = (machine) => machine ?? "This computer";

// Herdr's machines by name, then this computer.
export function machineList() {
  const list = machines();
  const offline = new Set(list.filter((m) => m.layout === "unavailable").map((m) => m.name));
  const names = [...new Set(list.map((m) => m.name).filter(Boolean))].sort();
  return [...names, null].map((name) => ({ name, offline: offline.has(name) }));
}

export function healthColor(health, t) {
  return { ok: t.ansi2, starting: t.ansi3, restarting: t.ansi3, unhealthy: t.ansi1, down: t.ansi1 }[health] ?? t.dim;
}
// A fine container's pill goes amber at 75% of its memory limit and red at 90%.
export function containerColor(c, health, t) {
  if (health === "ok" && c.usage) return c.usage.memPct >= 90 ? t.ansi1 : c.usage.memPct >= 75 ? t.ansi3 : t.ansi2;
  return healthColor(health, t);
}
export const toneColor = (tone, t) => ({ ok: t.ansi2, warn: t.ansi3, bad: t.ansi1, held: t.accent }[tone] ?? t.dim);
export const meterColor = (pct, t) => (pct >= 90 ? t.ansi1 : pct >= 75 ? t.ansi3 : t.accent);

function sortContainers(list) {
  return [...list].sort((a, b) => needsAttention(b) - needsAttention(a) || a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

// The git pill's look: fixed width, a tinted border and fill, a dot, then the text.
export function pill(id, color, text, onClick, t) {
  return h_flex().id(id).flex_none().w(PILL_W).h(PILL).gap(5).px(6).items_center().rounded(4)
    .border_1().border_color(color + "55").bg(color + "14").text_size(12).text_color(color).cursor_pointer()
    .hover((x) => x.bg(color + "2a"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(div().size(7).flex_none().rounded(4).bg(color))
    .child(div().flex_1().min_w(0).truncate().child(text));
}

export class Panel {
  init(p, cx) {
    this.demo = Boolean(p?.demo);
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.stats = this.demo ? Object.fromEntries(DEMO.map((m) => [m.name, { data: m.stats }])) : {};
    this.seenRefresh = shared(KEY_REFRESH) ?? 0;
    if (this.demo) return;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  machinesShown() {
    return this.demo ? DEMO.map((m) => ({ name: m.name, offline: false })) : machineList();
  }

  refresh(cx) {
    if (this.loading || this.demo) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try { await Promise.all(machineList().map((m) => this.probe(m))); }
      finally { this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  async probe(machine) {
    const key = label(machine.name);
    if (machine.offline) { this.stats[key] = { offline: true }; return; }
    try {
      const r = await exec("sh", ["-c", PROBE], { on: machine.name });
      const data = parseProbe(r.stdout);
      this.announce(key, this.stats[key]?.data, data);
      // Compose projects with lanes, from the containers' labels (lanes.js): their containers group by lane.
      this.stats[key] = { data, stacks: stacksOf(data.docker.containers) };
    } catch (e) { this.stats[key] = { error: String(e.message ?? e) }; }
  }

  announce(machine, before, after) {
    for (const alert of containerAlerts(before, after)) {
      if (alert.down) notify({ title: `${alert.name} is ${alert.health}`, body: machine, level: "error" });
      else notify({ title: `${alert.name} is back`, body: machine, level: "success", timeout: 6000 });
    }
  }

  fold(key, cx) {
    if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key);
    try { localStorage.setItem("folded", JSON.stringify([...this.folded])); } catch { /* best effort */ }
    cx.notify();
  }

  // ---------- menus ----------

  machineMenu(machine, entry) {
    const d = entry?.data, all = d?.docker.containers ?? [];
    openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 280, height: 12 + 3 * 22 + 9 + 2 * 28 + 10,
      props: { menu: "machine", machine: machine.name, state: machineState(entry), stats: d ? { uptime: d.uptime, usage: usage(d), total: all.length, running: all.filter((c) => c.state === "running").length, attention: all.filter(needsAttention).length, dockerError: d.docker.error ?? null } : null } });
  }

  containerMenu(machine, c) {
    openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 300, height: 12 + (c.usage ? 5 : 4) * 22 + 9 + 4 * 28 + 10,
      props: { menu: "container", machine, container: { ...c, health: containerHealth(c) } } });
  }

  laneMenu(machine, lane, dir) {
    const lines = 4 + (lane.database ? 1 : 0) + Math.max(1, lane.served.length);
    openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 320, height: Math.min(560, 12 + lines * 20 + 9 + 3 * 28 + 10),
      props: { menu: "lane", machine, dir, lane } });
  }

  // ---------- rows ----------

  // A lane (a compose project's, from its lane labels), or its shared services: a sub-row like a Spaces worktree row.
  laneRow(machine, g, t) {
    const key = `${label(machine)}/${g.dir}/${g.kind === "lane" ? g.lane.n : "shared"}`;
    const row = h_flex().id(`lane-${key}`).h(ROW).flex_none().pl(LEVEL1).pr(8).gap(7).items_center().rounded(6).text_size(TEXT)
      .hover((x) => x.bg(t.hover))
      .child(div().w(ICON).flex_none().flex().items_center().justify_center().child(svg(CHROME("layers")).size(13).text_color(t.muted)));
    if (g.kind === "shared") return row.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child("Shared"));
    const s = laneState(g.lane);
    return row.on_mouse_down("right", () => this.laneMenu(machine, g.lane, g.dir))
      .child(div().flex_none().text_color(t.foreground).child(`Lane ${g.lane.n}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(hostOf(g.lane.url)))
      .child(pill(`lane-pill-${key}`, toneColor(s.tone, t), s.text, () => this.laneMenu(machine, g.lane, g.dir), t));
  }

  machineRow(machine, entry, open, t) {
    const key = label(machine.name), s = machineState(entry);
    return h_flex().id(`machine-${key}`).h(ROW).flex_none().pl(0).pr(8).gap(9).items_center().rounded(8).cursor_pointer().text_size(TEXT)
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.fold(key, cx))
      .on_mouse_down("right", () => this.machineMenu(machine, entry))
      .child(div().id(`machine-fold-${key}`).w(22).h(28).ml(-5).mr(-7).flex_none().flex().items_center().justify_center().rounded(3)
        .text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.fold(key, cx); })
        .child(svg(CHROME(open ? "chevron-down" : "chevron-right")).size(11)))
      .child(div().size(18).flex_none().flex().items_center().justify_center()
        .child(svg(CHROME(machine.name ? "server" : "monitor")).size(15).text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(key))
      .child(pill(`machine-pill-${key}`, toneColor(s.tone, t), s.text, () => this.machineMenu(machine, entry), t));
  }

  containerRow(machine, c, t, depth = 0) {
    const key = `${label(machine)}/${c.name}`, health = containerHealth(c), stopped = health === "stopped";
    // A click opens the menu only on the pill; the row itself takes a right-click.
    return h_flex().id(`ct-${key}`).h(ROW).flex_none().pl(LEVEL1 + depth * (ICON + 7)).pr(8).gap(7).items_center().rounded(6).text_size(TEXT)
      .hover((x) => x.bg(t.hover))
      .on_mouse_down("right", () => this.containerMenu(machine, c))
      .child(div().w(ICON).flex_none().flex().items_center().justify_center().child(svg(CHROME("square")).size(13).text_color(stopped ? t.dim : t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_color(stopped ? t.muted : t.foreground).child(c.name))
      .child(pill(`ct-pill-${key}`, containerColor(c, health, t), shortStatus(c), () => this.containerMenu(machine, c), t));
  }

  note(text, color, t) {
    return div().h(24).flex_none().pl(CHILD_TEXT).flex().items_center().text_size(12).text_color(color ?? t.dim).child(text);
  }

  group(machine, t) {
    const key = label(machine.name), entry = this.stats[key], open = !this.folded.has(key);
    const rows = [this.machineRow(machine, entry, open, t)];
    if (open) {
      if (!entry) rows.push(this.note("Loading…", null, t));
      else if (entry.offline) rows.push(this.note("Offline", null, t));
      else if (entry.error) rows.push(this.note(entry.error, t.ansi1, t));
      else {
        const docker = entry.data.docker;
        if (docker.error) rows.push(this.note(`Docker: ${docker.error}`, null, t));
        else {
          const hide = shared(KEY_HIDE_STOPPED) === true;
          const list = sortContainers(docker.containers).filter((c) => !hide || containerHealth(c) !== "stopped");
          if (!list.length) rows.push(this.note(docker.containers.length ? "Only stopped containers (hidden)" : "No containers", null, t));
          // A compose project's containers under their lane (then its shared ones); the rest as they are.
          for (const g of groupByLane(list, entry.stacks)) {
            if (g.kind === "other") { rows.push(...g.containers.map((c) => this.containerRow(machine.name, c, t))); continue; }
            rows.push(this.laneRow(machine.name, g, t));
            rows.push(...g.containers.map((c) => this.containerRow(machine.name, c, t, 1)));
          }
        }
      }
    }
    return v_flex().flex_none().pb(6).children(rows);
  }

  render(cx) {
    const t = theme(), shown = this.machinesShown();
    const asked = shared(KEY_REFRESH) ?? 0;
    if (asked !== this.seenRefresh) { this.seenRefresh = asked; this.refresh(cx); }
    const attention = Object.values(this.stats).reduce((n, s) => n + (s.data?.docker.containers ?? []).filter(needsAttention).length, 0);
    return v_flex().id("servers").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TEXT)
      .child(h_flex().h(40).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_color(t.muted).child("Servers"))
        .when(attention > 0, (e) => e.child(div().px(6).h(18).flex().items_center().rounded(4).border_1().border_color(t.ansi1 + "55").bg(t.ansi1 + "14").text_size(12).text_color(t.ansi1).child(`${attention} need you`)))
        .child(div().flex_1())
        .child(div().id("servers-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .tooltip(this.loading ? "Looking…" : "Refresh").hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? svg(CHROME("spinner")).size(14).text_color(t.muted).spin(900) : svg(`mods/${MOD}/refresh.svg`).size(14).text_color(t.muted))))
      .child(v_flex().id("servers-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(shown.map((m) => this.group(m, t))));
  }
}
