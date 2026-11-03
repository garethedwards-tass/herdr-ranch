import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, exec, nextCommand, appHome } from "herdr";

// Buttons that mods declare in their own mod.json, next to Files and Changes:
//   "button": { "label": "PRs", "icon": "pr.svg", "opens": "panel" | "tab", "order": 10 }
// "panel" shows the mod in the side panel (a child of the panel-body stack, added to this
// layout when missing); "tab" opens it as a tab of its own, or selects that tab.
// Only installed mods that declare a button get one, or that KNOWN lists: mods by others that
// Herdr Ranch recommends, whose mod.json we don't change. A mod's own `button` wins.
// Read at start and on `mod-buttons-bar.rescan`.
// A mod can override "opens" with its own settings, in shared state `mod-settings`
// ({ <mod>: { opens? } }; space-prs and space-issues set it with the cog in their header).
const PREFS = "mod-settings";
// The mods folder (appHome()/mods) goes to sh as $1, never into the script text.
const modsDir = () => `${appHome()}/mods`;
const ICONS = "mods/mod-buttons-bar/icons";
// Every mod folder's name and mod.json, one per line ("name<TAB>json"). The last folder
// may have no mod.json, so the script ends with exit 0 rather than that test's status.
const LIST = `for d in "$1"/*/; do n=$(basename "$d"); [ -f "$d/mod.json" ] && printf '%s\t%s\n' "$n" "$(tr -d '\n' < "$d/mod.json")"; done; exit 0`;
// svg() reads paths under the app folder and doesn't follow a symlinked mod folder,
// so each icon is copied here (only when it changed: a write here reloads this mod).
// $1 is the mods folder, the rest are "mod:icon.svg".
const COPY = `m=$1; shift; mkdir -p "$m/mod-buttons-bar/icons" && for a; do src="$m/\${a%%:*}/\${a#*:}"; dst="$m/mod-buttons-bar/icons/\${a%%:*}.svg"; [ -f "$src" ] && { cmp -s "$src" "$dst" || cp -L "$src" "$dst"; }; done; exit 0`;
const BUILT_IN = new Set(["files", "changes"]);
const KNOWN = {
  automations: { label: "Automations", icon: "automations.svg", opens: "panel", order: 40 }, // DnzzL/herdr-automations
};

async function scan() {
  const mods = modsDir();
  const r = await exec("sh", ["-c", LIST, "list", mods]);
  if (r.code !== 0) return { buttons: [], installed: null };
  const installed = new Set(), buttons = [], background = [];
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [mod, json] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    installed.add(mod);
    let b, j; try { j = JSON.parse(json); b = j.button ?? KNOWN[mod]; } catch { continue; }
    if (j.background === true && mod !== "mod-buttons-bar") background.push(mod);
    if (!b?.label || mod === "mod-buttons-bar") continue;
    buttons.push({ mod, label: String(b.label), icon: b.icon ?? null, opens: b.opens === "tab" ? "tab" : "panel", order: Number(b.order ?? 100) });
  }
  const icons = buttons.filter((b) => b.icon && /^[\w.-]+\.svg$/.test(b.icon));
  if (icons.length) await exec("sh", ["-c", COPY, "copy", mods, ...icons.map((b) => `${b.mod}:${b.icon}`)]);
  for (const b of buttons) b.svg = icons.includes(b) ? `${ICONS}/${b.mod}.svg` : null;
  return { buttons: buttons.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)), installed, background: background.sort() };
}

// `opens` as the mod's settings choose it, else as its mod.json declares it.
const withPrefs = (buttons) => {
  const prefs = shared(PREFS) ?? {};
  return buttons.map((b) => ({ ...b, opens: ["tab", "panel"].includes(prefs[b.mod]?.opens) ? prefs[b.mod].opens : b.opens }));
};

// The panel-body stack gets a block for each "panel" button that has none, and loses
// blocks of mods that are no longer installed. Only this (personal) layout is changed.
// False when the layout has no panel-body yet, so the caller tries again later.
// A mod with `"background": true` in its mod.json gets an invisible block (0 px, at the end of
// the `work` column) with props { background: true }: a copy that runs as long as the layout
// shows, to watch for things and post toasts or counts. Its block goes when the mod does.
function syncLayout(buttons, installed, background = []) {
  const root = JSON.parse(JSON.stringify(layout() ?? null)), body = find(root, "panel-body"), work = find(root, "work");
  if (!body || !installed) return false;
  let changed = false;
  const kept = (body.children ?? []).filter((c) => !c.content?.mod || BUILT_IN.has(c.content.mod) || installed.has(c.content.mod));
  const missing = buttons.filter((b) => b.opens === "panel" && !kept.some((c) => c.content?.mod === b.mod));
  if (missing.length || kept.length !== (body.children ?? []).length) {
    body.children = [...kept, ...missing.map((b) => ({ id: b.mod, type: "block", content: { mod: b.mod, props: { slot: "panel" } } }))];
    if (!body.children.some((c) => c.id === body.active)) body.active = body.children[0]?.id;
    changed = true;
  }
  if (work) {
    const isBg = (c) => String(c.id ?? "").startsWith("background-");
    const others = (work.children ?? []).filter((c) => !isBg(c));
    const want = background.filter((mod) => installed.has(mod)).map((mod) => ({ id: `background-${mod}`, type: "block", content: { mod, props: { background: true } }, size: { px: 0 } }));
    const have = (work.children ?? []).filter(isBg).map((c) => c.id).join(",");
    if (have !== want.map((c) => c.id).join(",")) { work.children = [...others, ...want]; changed = true; }
  }
  if (changed) run("layout.set", { layout: root });
  return true;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // Storage can be missing or hold something unreadable: start with no choices then.
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}") ?? {}; } catch { this.panels = {}; }
    if (typeof this.panels !== "object") this.panels = {};
    this.buttons = [];
    const rescan = (cx) => cx.spawn(async (cx) => {
      const { buttons, installed, background } = await scan().catch(() => ({ buttons: [], installed: null, background: [] }));
      this.buttons = buttons; this.installed = installed; this.background = background ?? []; this.synced = null; cx.notify();
    });
    rescan(cx);
    // `herdr-app do mod-buttons-bar.rescan` after installing or removing a mod.
    cx.spawn(async (cx) => { try { for (;;) if (await nextCommand() === "rescan") rescan(cx); } catch { /* reloading */ } });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    try { localStorage.setItem("panels", JSON.stringify(this.panels)); } catch { /* kept in memory only */ }
  }

  // A changed choice adds the panel block it needs, and hides the panel when it shows a
  // mod that now opens as a tab.
  syncChoices(buttons, panel, body) {
    const key = buttons.map((b) => `${b.mod}:${b.opens}`).join(",");
    if (!this.installed || key === this.synced || !syncLayout(buttons, this.installed, this.background)) return;
    this.synced = key;
    if (panel && !panel.hidden && buttons.some((b) => b.opens === "tab" && body?.children?.find((c) => c.id === body.active)?.content?.mod === b.mod)) run("layout.hide", { id: "panel" });
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    // Read once: every tab and button looks up its panes, and this renders on any live change.
    const allPanes = panes(), programs = new Map();
    for (const p of allPanes) if (p.program && (!programs.has(p.tab) || (p.program.agent && !programs.get(p.tab).agent))) programs.set(p.tab, p.program);
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = programs.get(c.id);
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          // The tabs can change between mouse-down and up, so the pressed one may be gone.
          if (from !== null && from !== i && shown[from]?.id) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // A mod's panel is the panel-body child that shows it.
    const slot = (mod) => (body?.children ?? []).find((c) => c.content?.mod === mod)?.id ?? null;
    const buttons = withPrefs(this.buttons);
    this.syncChoices(buttons, panel, body);
    const declared = buttons.map((b) => ({ ...b, id: b.opens === "panel" ? slot(b.mod) : null })).filter((b) => b.opens === "tab" || b.id);
    this.syncPanel(space, panel, body, [...enabled, ...declared.filter((b) => b.id).map((b) => b.id)]);
    // A count a mod asks for on its button: shared("mod-badges") = { <mod>: n } for every space,
    // or { <mod>: { <space id>: n } } per space (the shown space's count is drawn).
    const badges = shared("mod-badges") ?? {};
    const badgeOf = (mod) => { const x = badges[mod]; const n = typeof x === "number" ? x : x && typeof x === "object" ? x[space?.id] : 0; return Number.isFinite(n) && n > 0 ? n : 0; };
    const chip = (id, label, icon, on, click, badge = 0) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(click)
      .when(Boolean(icon), el => el.child(svg(icon).size(14))).child(label)
      .when(badge > 0, el => el.child(div().px(5).h(16).flex().items_center().rounded(8).bg(t.accent).text_color(t.background).text_size(10).font_semibold().child(badge > 99 ? "99+" : String(badge))));
    const panelButton = (id, label, icon, badge = 0) => {
      const on = panel && !panel.hidden && body?.active === id;
      return chip(`panel-${id}`, label, icon, on, () => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
      }, badge);
    };
    // "tab": the tab with this mod and the button's name, in the shown space. It gets
    // props.space, so the mod can tell which space it belongs to (a mod tab isn't told).
    const tabButton = (b) => {
      const tab = shown.find(c => c.name === b.label && allPanes.some(p => p.tab === c.id && p.mod === b.mod));
      return chip(`tab-mod-${b.mod}`, b.label, b.svg, Boolean(tab?.active), () => {
        if (tab) run("tab.select", { id: tab.id });
        else run("tab.new", { name: b.label, mod: b.mod, props: { space: space?.id } });
      }, badgeOf(b.mod));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .children(declared.map(b => (b.opens === "tab" ? tabButton(b) : panelButton(b.id, b.label, b.svg, badgeOf(b.mod)))))
      .when(window()?.buttons, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
