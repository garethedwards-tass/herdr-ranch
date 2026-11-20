// New space: the list opens itself as a dialog with props { dialog: "new-space", machine }.
// Folder: typed (~ for home), with the folders under what's typed and the folders spaces already
// use as suggestions; ↑/↓ choose one, Tab puts it in the field, Browse… opens the system's folder
// picker (this computer only). Name: optional; empty, the space follows its folder's name.
// Start with: Terminal or an installed agent, the last choice kept; an agent can get a first message.
// Enter creates, Esc closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, run, home, knownAgents, pickFolder } from "herdr";
import { place, homeOn } from "./git.js";
import { ICONS } from "./actions.js";
import { launchAs, argvAs, runAs } from "./accounts.js";

const MOD = "herdr-ranch-spaces";
const MAX = 8; // suggestions shown
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this session only */ } };

// A typed folder as a full path: "~" and "~/x" from home; a relative one from home as well.
export function resolveFolder(text, homeDir) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (s === "~") return homeDir;
  if (s.startsWith("~/")) return `${homeDir}/${s.slice(2)}`;
  return s.startsWith("/") ? s : `${homeDir}/${s}`;
}

// A path as it reads to a person: home as ~, no trailing slash.
export function tilde(path, homeDir) {
  const p = String(path ?? "").replace(/(.)\/+$/, "$1");
  return homeDir && (p === homeDir || p.startsWith(homeDir + "/")) ? `~${p.slice(homeDir.length)}` : p;
}

// The folder to list for what's typed and the start of the name being typed in it:
// "~/dev/her" -> ["/h/dev", "her"], "~/dev/" -> ["/h/dev", ""].
export function splitTyped(text, homeDir) {
  const full = resolveFolder(text, homeDir);
  if (!full) return [homeDir, ""];
  if (String(text).trim() === "~") return [homeDir, ""];
  const i = full.lastIndexOf("/");
  return [i <= 0 ? "/" : full.slice(0, i), full.slice(i + 1)];
}

// Suggestions: the listed folder's children starting with the typed part (then containing it),
// hidden ones only when the typed part starts with a dot; then the folders spaces use that match.
export function suggestions(text, homeDir, children, used) {
  const [dir, part] = splitTyped(text, homeDir), lp = part.toLowerCase();
  const kids = (children ?? []).filter((n) => (lp.startsWith(".") || !n.startsWith(".")));
  const starts = kids.filter((n) => n.toLowerCase().startsWith(lp));
  const has = lp ? kids.filter((n) => !n.toLowerCase().startsWith(lp) && n.toLowerCase().includes(lp)) : [];
  const under = [...starts, ...has].map((n) => (dir === "/" ? `/${n}` : `${dir}/${n}`));
  const typed = String(text ?? "").trim().toLowerCase();
  const recent = (used ?? []).filter((p) => !typed || p.toLowerCase().includes(typed) || tilde(p, homeDir).toLowerCase().includes(typed));
  return [...new Set([...(typed ? under : []), ...recent, ...(typed ? [] : under)])];
}

export class NewSpaceDialog extends View {
  init(_props, cx) {
    const p = props();
    this.on = p.machine || null;
    this.home = this.on ? null : home();
    this.agents = [];
    this.with = load("spaces.newWith", "terminal"); // "terminal" or an agent's name
    this.kids = {}; // folder -> its children's names (undefined while reading)
    this.at = 0; this.error = ""; this.busy = false; this.focused = "folder";
    this.handle = cx.focus_handle();
    const input = (placeholder, name) => {
      const s = InputState.new({ placeholder });
      s.on("focus", (_e, cx) => { this.focused = name; cx.notify(); });
      s.on("submit", (_e, cx) => this.create(cx));
      return s;
    };
    this.folder = input("Folder, such as ~/development/project", "folder");
    this.folder.on("change", (_e, cx) => { this.at = 0; this.error = ""; this.list(cx); cx.notify(); });
    this.name = input("Name (optional: the folder's name)", "name");
    this.task = input("First message (optional)", "task");
    this.folder.focus();
    cx.spawn(async (cx) => {
      try { this.home ??= await homeOn(this.on, home()); } catch (e) { this.error = String(e?.message ?? e); }
      try { this.agents = (await knownAgents({ on: this.on })).filter((a) => a.installed && a.run?.length); } catch { /* Terminal only */ }
      if (this.with !== "terminal" && !this.agents.some((a) => a.name === this.with)) this.with = "terminal";
      this.list(cx);
      cx.notify();
      cx.timer.after(50, () => { try { this.folder.focus(); } catch { /* closed */ } });
    });
  }

  // The folders spaces on this machine use now, home first.
  used() {
    const ps = panes();
    const all = spaces().filter((s) => (s.machine ?? null) === this.on).map((s) => place(s, ps)).filter(Boolean);
    return [...new Set(all)];
  }

  // Reads the children of the folder being typed in, once per folder.
  list(cx) {
    if (!this.home) return;
    const [dir] = splitTyped(this.folder.value(), this.home);
    if (dir in this.kids) return;
    this.kids[dir] = undefined;
    cx.spawn(async (cx) => {
      const r = await exec("find", [dir, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], { on: this.on, timeout: 5000 }).catch(() => null);
      this.kids[dir] = r ? r.stdout.split("\n").map((l) => l.slice(l.lastIndexOf("/") + 1)).filter(Boolean).sort((a, b) => a.localeCompare(b)) : [];
      cx.notify();
    });
  }

  rows() {
    if (!this.home) return [];
    const [dir] = splitTyped(this.folder.value(), this.home);
    return suggestions(this.folder.value(), this.home, this.kids[dir], this.used()).slice(0, MAX);
  }

  // Puts a suggestion in the field, ending in / so its own folders show next.
  complete(path, cx) {
    const v = `${tilde(path, this.home)}/`;
    this.folder.set_value(v);
    this.folder.set_selected_range({ start: v.length, end: v.length });
    this.folder.focus();
    this.at = 0; this.list(cx); cx.notify();
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  browse(cx) {
    cx.spawn(async (cx) => {
      const f = await pickFolder({ prompt: "Use folder" }).catch(() => null);
      if (!f) return;
      const v = tilde(f, this.home);
      this.folder.set_value(v);
      this.folder.set_selected_range({ start: v.length, end: v.length });
      this.error = ""; this.list(cx); cx.notify();
    });
  }

  pick(w, cx) { this.with = w; save("spaces.newWith", w); cx.notify(); }

  // Creates the space when the folder is one; an empty field takes the highlighted suggestion.
  create(cx) {
    if (this.busy || !this.home) return;
    const typed = this.folder.value().trim();
    const path = typed ? resolveFolder(typed, this.home).replace(/(.)\/+$/, "$1") : this.rows()[this.at];
    if (!path) { this.error = "Type a folder, or pick one."; cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("test", ["-d", path], { on: this.on, timeout: 5000 }).catch(() => null);
      if (r?.code !== 0) { this.busy = false; this.error = `${tilde(path, this.home)} isn't a folder${this.on ? ` on ${this.on}` : ""}.`; cx.notify(); return; }
      const agent = this.with === "terminal" ? null : this.agents.find((a) => a.name === this.with);
      const name = this.name.value().trim(), task = this.task.value().trim();
      // As no account's GitHub login, when it has one (the Link space dialog sets an account later).
      const as = launchAs(null);
      this.close();
      run("space.new", {
        folder: path, machine: this.on ?? "",
        ...(name ? { name } : {}),
        ...(agent ? { argv: as ? runAs(as, agent.run) : agent.run, tab: agent.name, ...(task ? { task } : {}) } : as ? { argv: argvAs(as) } : {}),
      });
    });
  }

  key(e, cx) {
    const rows = this.rows(), n = rows.length;
    if (e.key === "escape") this.close();
    else if (this.focused === "folder" && (e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.notify(); }
    else if (this.focused === "folder" && e.key === "tab" && !e.modifiers?.shift && n) this.complete(rows[this.at], cx);
    else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme(), rows = this.rows();
    const [dir] = this.home ? splitTyped(this.folder.value(), this.home) : [null];
    const reading = dir != null && this.kids[dir] === undefined;
    const field = (state, focused) => div().h(32).px(10).flex().items_center().rounded(6).border_1()
      .border_color(focused ? t.accent : t.border).bg(t.background).text_color(t.foreground).child(Input.new(state));
    const label = (text) => div().text_size(11).font_medium().text_color(t.dim).child(text);
    const button = (id, text, primary, enabled, onClick) => h_flex().id(id).flex_none().items_center().px(12).py(5).rounded(6).text_size(12)
      .when(primary, (e) => e.bg(enabled ? t.accent : t.raised).text_color(enabled ? t.background : t.dim).font_semibold())
      .when(!primary, (e) => e.border_1().border_color(t.border).bg(t.background).text_color(t.foreground))
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(text);
    const choice = (id, text, icon) => {
      const on = this.with === id;
      return h_flex().id(`new-space-with-${id}`).flex_none().gap(6).items_center().px(10).py(4).rounded(6).cursor_pointer().text_size(12)
        .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted)
        .when(on, (e) => e.bg(t.accent + "14")).when(!on, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => this.pick(id, cx))
        .when(Boolean(icon), (e) => e.child(icon))
        .child(text);
    };
    const agentIcon = (a) => !a.icon ? null : a.tint ? svg(a.icon).size(14).flex_none().text_color(t.muted) : image(a.icon).w(14).h(14).flex_none();
    const suggestion = (p, i) => {
      const on = i === this.at;
      return h_flex().id(`new-space-dir-${i}`).flex_none().h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.complete(p, cx); })
        .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(tilde(p, this.home)));
    };
    const agent = this.with !== "terminal";
    return v_flex().id("spaces-new-space").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().p(16).gap(8).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`New space${this.on ? ` on ${this.on}` : ""}`))
      .child(label("Folder"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(field(this.folder, this.focused === "folder")))
        .when(!this.on, (e) => e.child(button("new-space-browse", "Browse…", false, true, (cx) => this.browse(cx)))))
      .child(v_flex().id("new-space-dirs").h(MAX * 28).flex_none().overflow_y_scrollbar()
        .children(rows.map(suggestion))
        .when(rows.length === 0, (e) => e.child(div().px(10).py(6).text_size(12).text_color(t.dim).child(!this.home || reading ? "…" : "No folders here."))))
      .child(label("Name"))
      .child(field(this.name, this.focused === "name"))
      .child(label("Start with"))
      .child(h_flex().flex_wrap().gap(6)
        .child(choice("terminal", "Terminal", svg(`${ICONS}/square-terminal.svg`).size(14).flex_none().text_color(t.muted)))
        .children(this.agents.map((a) => choice(a.name, a.name, agentIcon(a)))))
      .when(agent, (e) => e.child(field(this.task, this.focused === "task")))
      .child(div().flex_1())
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().items_center().gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.busy ? "creating…" : "↑↓ choose · tab fills in"))
        .child(button("new-space-cancel", "Cancel  esc", false, true, () => this.close()))
        .child(button("new-space-go", "Create  ↵", true, !this.busy && Boolean(this.home), (cx) => this.create(cx))));
  }
}
