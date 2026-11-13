// Which GitHub repository and Jira project a space works on.
// The source is shared/links.js; herdr-ranch-prs and herdr-ranch-issues keep identical copies (a mod
// cannot import outside its folder). install.sh checks they match.
//
// Stored in shared("space-links") by space id:
//   { main, on, github?: "owner/repo", jira?: { site, key, filter? },
//     issues?: "github" (herdr-ranch-issues reads GitHub instead of Jira), issuesFilter?: GitHub search }
// A space without its own link uses the link of another space on the same repository,
// so worktree spaces follow the repository's space.

import { exec, shared, setShared, spaces, openOverlay, closeOverlay, props, theme, appHome, readTextFile, writeTextFile, settings, window as appWindow, run, notify } from "herdr";
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_resizable, resizable_panel, Avatar, AvatarImage, AvatarFallback } from "gpui-base";

const KEY = "space-links";

export const activeSpace = () => spaces().find((s) => s.active) ?? null;

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return r.code === 0 ? r.stdout.trim() : null;
}

// The repository a space's folder is in: its main checkout (worktrees share it) and machine.
export async function spaceRepo(space) {
  if (!space?.folder) return null;
  const common = await git(space.folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], space.machine);
  return common ? { main: common.replace(/\/\.git\/?$/, ""), on: space.machine ?? null } : null;
}

export function linkOf(space, repo) {
  const all = shared(KEY) ?? {};
  if (all[space.id]) return all[space.id];
  if (!repo) return null;
  return Object.values(all).find((l) => l.main === repo.main && (l.on ?? null) === repo.on) ?? null;
}

export function saveLink(space, repo, link) {
  const all = { ...(shared(KEY) ?? {}) };
  all[space.id] = { main: repo?.main ?? null, on: repo?.on ?? null, ...link };
  setShared(KEY, all);
}

// Every Jira site any space links to, most used first: a guess for unlinked spaces.
export function knownSites() {
  const counts = new Map();
  for (const l of Object.values(shared(KEY) ?? {})) if (l.jira?.site) counts.set(l.jira.site, (counts.get(l.jira.site) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([site]) => site);
}

// The repository's GitHub name from its remote, read once per checkout. Only a found name is
// kept: a miss (gh signed out, offline, no remote yet) is asked again next time.
const detected = new Map();
export async function detectGithub(repo) {
  const k = `${repo.on ?? ""}:${repo.main}`;
  if (!detected.has(k)) {
    const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: repo.main, on: repo.on }).catch(() => null);
    const name = r?.code === 0 ? r.stdout.trim() : "";
    if (!name) return null;
    detected.set(k, name);
  }
  return detected.get(k);
}

// Everything a mod needs for the shown space, or { error }.
export async function context(space = activeSpace()) {
  if (!space) return { error: "No space is shown." };
  const repo = await spaceRepo(space);
  const link = linkOf(space, repo) ?? {};
  return { space, repo, link, github: link.github || (repo ? await detectGithub(repo) : null) };
}

// Images in descriptions often need a sign-in (GitHub's user-attachments) and leave an empty
// gap where they don't load: each becomes a link instead ("Image: alt"), Markdown and <img> alike.
export function imagesAsLinks(md) {
  const link = (url, alt) => { const a = (alt ?? "").replace(/[[\]]/g, "").trim(); return `[Image${a && !/^image$/i.test(a) ? `: ${a}` : ""}](${url})`; };
  return (md ?? "")
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, url) => link(url, alt))
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const url = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      return url ? link(url, alt) : "";
    });
}

// Opens a web page in the person's browser, on macOS, Linux and Windows. Untrusted Markdown
// (descriptions, comments) is drawn with TextView.markdown(...).on_link_click((url) => openUrl(url)),
// so its links (the image links above too) go through this check, not TextView's own opener.
export function openUrl(url) {
  // Only web pages: a file path or an option-like string never reaches the system opener.
  if (!/^https?:\/\/[^\s]+$/i.test(url ?? "")) return;
  const os = (() => { try { return appWindow().platform; } catch { return "macos"; } })();
  const [cmd, args] = os === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : os === "linux" ? ["xdg-open", [url]] : ["open", [url]];
  exec(cmd, args).catch(() => null);
}

// Spaces Start agent made, found by their branch (or worktree folder): agent/<KEY>-…,
// agent/issue-<n>-… for issues, agent/review-<n>-…, agent/fix-<n>-…, agent/checks-<n>-… for
// pull requests. Read on each render: spaces() is a plain list and cheap.
// Only spaces in this repository's worktree folder count (`~/.herdr/worktrees/<repo>/…`, where
// Start agent puts them), so #12 of another repository isn't shown here.
// Returns { issues: Map(key → [agent]), prs: Map(number → [agent]) }, agent = { id, status, mode, name }.
// agent/<KEY>-…, agent/plan-<KEY>-…, agent/investigate-issue-12-…, agent/review-531-… (a "-2" suffix
// for a second start on the same item keeps matching).
const AGENT_BRANCH = /^agent[/-](?:(review|fix|checks)-(\d+)|(?:(plan|investigate)-)?(?:issue-(\d+)|([A-Z][A-Z0-9_]+-\d+)))-/;
export function agentSpaces(repoMain) {
  const issues = new Map(), prs = new Map();
  const name = (repoMain ?? "").split(/[/\\]/).filter(Boolean).pop();
  if (!name) return { issues, prs };
  for (const sp of spaces()) {
    const parts = (sp.folder ?? "").split(/[/\\]/).filter(Boolean);
    const at = parts.lastIndexOf("worktrees");
    if (at < 1 || parts[at - 1] !== ".herdr" || parts[at + 1] !== name) continue;
    const m = AGENT_BRANCH.exec(sp.branch ?? "") ?? AGENT_BRANCH.exec(parts[at + 2] ?? "");
    if (!m) continue;
    // `live`: an agent runs in it now (Herdr reports a status); a space left open after it stopped isn't.
    const a = { id: sp.id, status: sp.status ?? "stopped", live: sp.status != null, mode: m[1] ?? m[3] ?? "work", name: sp.name, folder: sp.folder };
    if (m[2]) { const n = Number(m[2]); prs.set(n, [...(prs.get(n) ?? []), a]); }
    else { const k = m[4] ? `#${m[4]}` : m[5]; issues.set(k, [...(issues.get(k) ?? []), a]); }
  }
  return { issues, prs };
}
// The most urgent of several agents on one item (Herdr's order: needs you, done, working, idle).
const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3, stopped: 4 };
export const mostUrgent = (list) => [...(list ?? [])].sort((a, b) => (URGENCY[a.status] ?? 5) - (URGENCY[b.status] ?? 5))[0] ?? null;
// The agent ⌘↵ and the primary button go to: only one that is running.
export const liveAgent = (list) => mostUrgent((list ?? []).filter((a) => a.live));
export const AGENT_STATUS = { blocked: ["needs you", "ansi3"], done: ["done", "ansi2"], working: ["working", "accent"], idle: ["idle", "dim"], stopped: ["no agent running", "dim"] };
export const goToSpace = (id) => run("space.select", { id });
// A small pill for a row: the agent icon with its status color; a click goes to its space.
export function agentChip(id, list, t) {
  const a = mostUrgent(list);
  if (!a) return null;
  const [label, c] = AGENT_STATUS[a.status] ?? AGENT_STATUS.idle;
  return h_flex().id(id).flex_none().gap(3).items_center().px(5).py(1).rounded(4).border_1().border_color(t[c] + "66").bg(t[c] + "14")
    .text_size(fs.tiny).text_color(t[c]).cursor_pointer().hover((x) => x.bg(t[c] + "2a"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); goToSpace(a.id); })
    .child(icon("bot", t[c], 11)).child(list.length > 1 ? `${label} · ${list.length}` : label);
}

// The dialogs are part of each list: `mod` opens itself as one, with props.dialog.
export function openLinkDialog(mod, space = activeSpace()) {
  if (space) openOverlay({ mod, kind: "dialog", width: 560, height: 640, props: { dialog: "link", space: space.id, mod } });
}

// Start agent: `p` is { repo, on, branch, tab, title, prompt } (see agent-dialog.js).
export function openAgentDialog(mod, p) {
  openOverlay({ mod, kind: "dialog", width: 660, height: 640, props: { dialog: "agent", mod, ...p } });
}
// Cog → Prompts…: the person's Start agent templates for this list.
export function openPromptsDialog(mod) {
  const space = activeSpace();
  openOverlay({ mod, kind: "dialog", width: 680, height: 620, props: { dialog: "prompts", mod, kind: mod === "herdr-ranch-prs" ? "pr" : "issue", space: space?.id ?? null } });
}

// A list's own choices, set with the cog in its header and kept in shared("mod-settings")
// by mod: { opens?: "panel" | "tab", order? }. mod-buttons reads `opens` to show the mod's
// button in the side panel or a tab.
const PREFS = "mod-settings";
export const pref = (mod, key, fallback) => shared(PREFS)?.[mod]?.[key] ?? fallback;
import { VERSION, updateState, checkForUpdate, installKind, updateNow, AGENT_LINE } from "./update.js";

// The lists were called space-issues and space-prs before: their settings move over once.
const OLD_NAMES = { "herdr-ranch-issues": "space-issues", "herdr-ranch-prs": "space-prs" };
export function migrateSettings(mod) {
  const all = shared(PREFS) ?? {}, old = OLD_NAMES[mod];
  if (old && all[old] && !all[mod]) setShared(PREFS, { ...all, [mod]: all[old] });
  const badges = shared("mod-badges");
  if (old && badges?.[old]) { const { [old]: _gone, ...rest } = badges; setShared("mod-badges", rest); }
}
export const setPref = (mod, key, value) => {
  const all = shared(PREFS) ?? {};
  setShared(PREFS, { ...all, [mod]: { ...all[mod], [key]: value } });
};

// The cog opens the mod itself as a popup with props.settings; its render returns settingsMenu.
export const openSettings = (mod) => openOverlay({ mod, kind: "popup", width: 280, props: { settings: true } });
export const OPENS = { key: "opens", label: "Opens in", choices: [["panel", "Panel"], ["tab", "Tab"]], fallback: "panel" };
// "overlay" (the default): a page opens in a dialog over the window; "split": under the list,
// in the same panel; "full": in the list's place. An unknown stored value counts as the default.
export const PAGE = { key: "page", label: "Page", choices: [["overlay", "Overlay"], ["split", "Split"], ["full", "Full"]], fallback: "overlay" };
export const pageMode = (mod) => { const v = pref(mod, "page", PAGE.fallback); return PAGE.choices.some(([c]) => c === v) ? v : PAGE.fallback; };
export const asSplit = (mod) => pageMode(mod) === "split";

// The page as a dialog: `mod` opens itself with props.dialog "page" and `p` (what the page needs,
// with the page itself when the list has it, so it shows at once). A copy of its own, so the
// list's cache can't be read from there: the list hands over what it has.
export function openPageDialog(mod, p) {
  openOverlay({ mod, kind: "dialog", width: 0.62, height: 0.85, props: { dialog: "page", ...p } });
}
// A page in its dialog. `on`: { step(+1 | -1, cx) for Up/Down, key(event, cx) for the page's
// own keys (true when it took one), width(px, cx) }. × and Esc close it.
export function pageDialog(id, handle, page, on) {
  const t = theme(), overlay = props()?.overlay;
  // Closing gives the keyboard back to the list that opened the page (its "<mod>.focus" command).
  const close = () => { closeOverlay(overlay); if (on.mod) run(`${on.mod}.focus`); };
  return div().id(id).relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fs.body)
    .track_focus(handle)
    .on_size_change((size, cx) => on.width?.(Math.round(size.width), cx))
    .on_key_down((e, cx) => {
      const plain = !e.modifiers?.platform && !e.modifiers?.control && !e.modifiers?.alt;
      if (plain && (e.key === "down" || e.key === "up")) on.step(e.key === "down" ? 1 : -1, cx);
      else if (e.key === "escape") close();
      else if (!on.key?.(e, cx)) return;
      cx.stop_propagation();
    })
    .child(page)
    .child(div().id(`${id}-close`).absolute().top(11).right(10).size(22).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => close()).child("×"));
}

// The list with the page under it, in Herdr's own split: Herdr draws and drags the divider
// and keeps where it was left under the group's id, so no script runs while it moves.
// The page starts 560px high, then at the height it was last dragged to. Closed, the page's pane is hidden.
// Workaround: a group whose panel was hidden reopens it shrunk (about 370px, not its size), so every open
// gets a fresh group id and the page height is remembered from on_resize.
const splits = {};
const pageHeight = (id) => { try { return Number(localStorage.getItem(`split:${id}`)) || 560; } catch { return 560; } };
export function splitView(id, list, page, open, close) {
  const t = theme();
  const s = (splits[id] ??= { open: false, gen: 0, size: pageHeight(id) });
  if (open && !s.open) s.gen++;
  s.open = open;
  return v_resizable(`${id}-${s.gen}`).size_full()
    .on_resize((sizes) => {
      const h = Math.round(sizes[1] ?? 0);
      if (!s.open || h < 160) return;
      s.size = h;
      try { localStorage.setItem(`split:${id}`, String(h)); } catch { /* best effort */ }
    })
    .child(resizable_panel().size_range(80).child(list))
    // × sits in the page's top-right corner, level with its title (the page has 14px padding).
    .child(resizable_panel().visible(open).size(s.size).size_range(160).child(div().relative().size_full().min_h(0).border_t_1().border_color(t.border)
      .child(page ?? div())
      .child(div().id(`${id}-close`).absolute().top(11).right(10).size(22).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => close(cx)).child("×"))));
}

// One row per setting ({ key, label, choices: [[value, text]], fallback }), then Link space.
// `settings`: { key, label, choices, fallback } kept per mod, or with get() and set(value) of its
// own. `space`: false leaves out Link space and Prompts (a mod without a space link).
export function settingsMenu(mod, settings, space = true) {
  const t = theme();
  const choice = (id, text, on, click) => div().id(id).px(8).py(3).rounded(5).text_size(12).cursor_pointer()
    .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected))
    .hover((s) => s.bg(t.hover)).on_click(click).child(text);
  const row = (d) => h_flex().min_h(28).gap(4).items_center().flex_wrap()
    .child(div().w(70).flex_none().text_size(11.5).text_color(t.muted).child(d.label))
    .children(d.choices.map(([value, text]) => choice(`${d.key}-${value}`, text, (d.get ? d.get() : d.key === "page" ? pageMode(mod) : pref(mod, d.key, d.fallback)) === value, () => (d.set ? d.set(value) : setPref(mod, d.key, value)))));
  // The suite's version, and Update when a newer release exists (see update.js).
  const u = updateState();
  const update = (cx) => cx.spawn(async (cx) => {
    if ((await installKind()).kind !== "git") { cx.write_to_clipboard(AGENT_LINE); notify({ title: "Copied the update line for your agent", body: "Paste it to your agent in Herdr.", level: "info", timeout: 5000 }); return; }
    notify({ title: "Updating Herdr Ranch…", level: "info", timeout: 3000 });
    const failed = await updateNow();
    notify(failed ? { title: "Update failed", body: failed, level: "error", timeout: 8000 } : { title: `Herdr Ranch is updated to ${u.latest}`, level: "success", timeout: 5000 });
  });
  const version = h_flex().mt(6).pt(8).gap(6).items_center().border_t_1().border_color(t.border).text_size(11.5).text_color(t.dim)
    .child(div().flex_1().child(`Herdr Ranch v${VERSION}${u.available ? ` · ${u.latest} is out` : u.latest ? " · up to date" : ""}`))
    .child(u.available
      ? div().id("update").px(8).py(2).rounded(5).bg(t.ansi2).text_color(t.background).font_semibold().cursor_pointer().on_click((_e, cx) => update(cx)).child("Update")
      : div().id("check-update").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).on_click(() => { checkForUpdate(true); }).child("Check"));
  return v_flex().size_full().p(10).gap(4).text_color(t.foreground)
    .children(settings.map(row))
    .when(space, (e) => e.child(div().id("link-space").mt(6).pt(8).border_t_1().border_color(t.border).text_size(12).cursor_pointer()
      .text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(() => { closeOverlay(props().overlay); openLinkDialog(mod); }).child("Link space…"))
    .child(div().id("prompts").text_size(12).cursor_pointer()
      .text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(() => { closeOverlay(props().overlay); openPromptsDialog(mod); }).child("Prompts…")))
    .child(version);
}

// A retained child view drawn by `draw()`. Herdr re-renders a mod's root on every live
// change (agents, focus) and gives a render a time budget; this view renders only on its own
// `cx.notify(view)` (or a theme change), so a long page isn't rebuilt with the list around it.
class Drawn extends View {
  init(p) { this.draw = p.draw; }
  update(p) { this.draw = p.draw; }
  render() { return this.draw() ?? div(); }
}
export const drawn = (cx, draw) => cx.new(Drawn, { draw });

// The lists' icons: Lucide's (ISC license; Herdr ships Lucide too). svg() reads only real
// files under the app's home, not a linked mod folder, so they are written to
// data/herdr-ranch/icons once (again only when one differs). An icon takes the text color.
const LUCIDE = {
  bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  task: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  subtask: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  story: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  epic: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  feature: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  issue: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  draft: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><line x1="6" x2="6" y1="9" y2="21"/>',
  merged: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  closed: '<circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pending: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  stack: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
};
const ICONS = "data/herdr-ranch/icons";
// The refresh button's icon (written with the others by writeIcons).
export const REFRESH_ICON = `${ICONS}/refresh.svg`;
let iconsWritten = null;
export function writeIcons() {
  iconsWritten ??= (async () => {
    const dir = `${appHome()}/${ICONS}`;
    const win = (() => { try { return appWindow().platform === "windows"; } catch { return false; } })();
    await (win ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`]) : exec("mkdir", ["-p", dir])).catch(() => null);
    for (const [name, body] of Object.entries(LUCIDE)) {
      const path = `${dir}/${name}.svg`;
      const text = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
      const now = await readTextFile(path).catch(() => null);
      if (now !== text) await writeTextFile(path, text, now).catch(() => null);
    }
  })();
  return iconsWritten;
}
export const icon = (name, color, size = 14) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);

// An issue's kind from its type name (Jira's, in any of its usual spellings, or GitHub's
// issue type), else from its labels: what its icon and color show.
export function issueKind(type = "", labels = []) {
  const n = type.toLowerCase(), l = labels.map((x) => x.toLowerCase());
  if (/sub-?task|subtaak|sous-t/.test(n)) return "subtask";
  if (/bug|defect|incident|fout/.test(n) || l.includes("bug")) return "bug";
  if (/epic/.test(n)) return "epic";
  if (/story|verhaal/.test(n)) return "story";
  if (/feature|enhancement|improvement|verbetering/.test(n) || l.includes("enhancement") || l.includes("feature")) return "feature";
  if (/task|taak|chore/.test(n)) return "task";
  return "issue";
}
// Theme colors, so icons follow light and dark themes.
export const kindColor = (kind, t) => ({ bug: t.ansi1, subtask: t.ansi4, task: t.ansi4, story: t.ansi2, epic: t.ansi5, feature: t.ansi3, issue: t.ansi2,
  pr: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1, check: t.ansi2, x: t.ansi1, pending: t.ansi3 })[kind] ?? t.muted;

// A person as initials in a tinted circle, colored by name; nobody: an empty circle.
const TINTS = ["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"];
export function initials(name) {
  const words = (name ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").split(/[ ._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2)).toUpperCase();
}
export function avatar(name, t, size = 18) {
  const base = div().size(size).flex_none().rounded_full().flex().items_center().justify_center().text_size(Math.round(size / 2)).font_semibold();
  if (!name) return base.border_1().border_color(t.border);
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const c = t[TINTS[h % TINTS.length]] ?? t.accent;
  const tinted = base.bg(c + "2e").text_color(c).child(initials(name));
  if (!pics.has(name)) return tinted;
  return Avatar.new().size(size).flex_none().rounded_full().overflow_hidden()
    .image(AvatarImage.new(`${AVATARS}/${name}.png`).size_full().rounded_full())
    .fallback(AvatarFallback.new().size_full().rounded_full().child(tinted));
}

// GitHub avatars: Herdr shows images only from the app's folder, so each login's picture
// is downloaded there once per session. Until then, and when it fails, the initials show.
// `avatarPics`: the logins downloaded so far; the list hands them to its page dialog.
const AVATARS = "data/herdr-ranch/avatars", AT_ONCE = 4;
export const avatarPics = new Set();
const pics = avatarPics, asked = new Set();
// True when a picture arrived: redraw then. Only plain logins, so not bots ("app/dependabot"),
// and only for a pull request on github.com (`url`): an Enterprise login can name someone
// else on github.com. Each login is asked once per session; a failure keeps its initials.
// At most AT_ONCE downloads run at a time.
export async function loadAvatars(logins, url) {
  if (!/^https:\/\/github\.com\//.test(url ?? "")) return false;
  const todo = [...new Set(logins)].filter((l) => /^[A-Za-z0-9-]+$/.test(l ?? "") && !asked.has(l) && !pics.has(l));
  for (const l of todo) asked.add(l);
  let got = false;
  const next = async () => {
    for (let l; (l = todo.shift()) !== undefined;) {
      const r = await exec("curl", ["-fsSL", "--create-dirs", "-o", `${appHome()}/${AVATARS}/${l}.png`, `https://github.com/${l}.png?size=64`]).catch(() => null);
      if (r?.code === 0) { pics.add(l); got = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, next));
  return got;
}

// One segmented control: "All" and the filters, one picked at a time.
// `withAll`: an "All" choice (value null) comes first.
export function segmented(id, options, current, pick, t, withAll = true) {
  const all = withAll ? [[null, "All"], ...options] : options;
  return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(fs.meta)
    .children(all.map(([value, label], n) => div().id(`${id}-${value ?? "all"}`).px(9).py(2).cursor_pointer()
      .when(n < all.length - 1, (e) => e.border_r_1().border_color(t.border))
      .when(current === value, (e) => e.bg(t.selected).font_semibold())
      .when(current !== value, (e) => e.text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { pick(value, cx); cx.notify(); }).child(label)));
}

// Text sizes from Herdr's UI font size setting (13 by default): `body` for titles, `meta`
// one smaller for keys, statuses and ages, `tiny` for pills, `title` for a page's title;
// row heights follow. readSizes() runs at the start of each list render.
export const fs = { body: 13, meta: 12, tiny: 11, title: 15, row: 30, row2: 50, head: 26 };
export function readSizes() {
  let b = 13;
  try { b = Math.round(Number(settings()?.ui_font_size)) || 13; } catch { /* the default */ }
  return Object.assign(fs, { body: b, meta: b - 1, tiny: b - 2, title: b + 2, row: b + 17, row2: 2 * b + 24, head: b + 13 });
}
