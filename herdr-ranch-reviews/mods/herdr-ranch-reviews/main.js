// Reviews: the Markdown files and last messages your agents asked you to review (with
// `ranch-review`, or the /herdr-ranch-review and /herdr-ranch-review-last skills), reviewed natively in Herdr.
// Two faces of one mod:
//   - with `props.review` (a pane beside the agent, opened by the CLI): the document rendered
//     block by block, a comment per block or for the whole document, Send, Approve as is, Discard;
//   - without it (the Reviews button): the list of reviews, waiting ones first.
// A review is one file, ~/.config/herdr-app/data/herdr-ranch-reviews/<id>.json. Sending writes
// the result there: a waiting `ranch-review` prints it to the agent; when nothing waits any
// more, the feedback is pasted into the agent's terminal once it is idle (`hc send --if idle`).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, InputState, Input } from "gpui-base";
import { theme, props, exec, hc, appHome, readTextFile, writeTextFile, watchFolder, panes, agents, run, notify, shared, setShared, openOverlay, closeOverlay, spaces } from "herdr";
import { VERSION, updateState, checkForUpdate, installKind, updateNow, AGENT_LINE } from "./update.js";
import { MOD, splitBlocks, formatFeedback, quoteOf, lineLabel, pastePrompt, stateOf, ago, imageOnly, matchBlocks, countMatches, hitsIn, docKey, newestPerDoc, carryDraft, markHits } from "./reviews.js";

const DIR = () => `${appHome()}/data/${MOD}`;
const fileOf = (id) => `${DIR()}/${id}.json`;
const MAX_BLOCKS = 400; // a render runs past Herdr's budget beyond this
const PASTE_FOR = 120000, PASTE_EVERY = 4000; // a busy agent is retried this long

// Reads a review and the exact text it was read from (writes are compare-and-swap).
async function load(id) {
  const raw = await readTextFile(fileOf(id)).catch(() => null);
  if (!raw) return null;
  try { return { review: JSON.parse(raw), raw }; } catch { return null; }
}

// Changes a review with `change(review)`, retrying when the CLI wrote in between.
async function update(id, change) {
  for (let i = 0; i < 5; i++) {
    const got = await load(id);
    if (!got) return null;
    const next = change(got.review) ?? got.review;
    try { await writeTextFile(fileOf(id), JSON.stringify(next, null, 2), got.raw); return next; } catch { /* written meanwhile: read again */ }
  }
  return null;
}

// Settings, in shared "mod-settings" like the other Herdr Ranch lists (the CLI reads them too):
//   open: "agent" (the default): the waiting agent shows under Needs you (the CLI reports it), the
//         Reviews button counts it, and going to that agent opens the review; "open" opens the
//         review right away. (Older values, "notify", "list" and "auto", count as these.)
//   view: "tab" (the default): a review opens as a tab of its own in the shown space; "dialog"
//         opens it as a modal dialog over the window.
//   sent: how many sent reviews the list shows ("0" hides them).
//   scope: "space" (the shown space's reviews) or "all".
const PREFS = "mod-settings";
const pref = (key, fallback) => shared(PREFS)?.[MOD]?.[key] ?? fallback;
const setPref = (key, value) => { const all = shared(PREFS) ?? {}; setShared(PREFS, { ...all, [MOD]: { ...all[MOD], [key]: value } }); };
const SETTINGS = [
  { key: "open", label: "Opens", choices: [["agent", "On agent focus"], ["open", "Immediately"]], fallback: "agent" },
  { key: "view", label: "Shows in", choices: [["tab", "Tab"], ["dialog", "Modal"]], fallback: "tab" },
  { key: "sent", label: "Sent shown", choices: [["0", "None"], ["10", "10"], ["25", "25"], ["50", "50"]], fallback: "10" },
];
const openSettings = () => openOverlay({ mod: MOD, kind: "popup", width: 300, props: { settings: true } });
function settingsMenu(t) {
  const choice = (id, text, on, click) => div().id(id).px(8).py(3).rounded(5).text_size(12).cursor_pointer()
    .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected))
    .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { click(); cx.notify(); }).child(text);
  // The suite's version, and Update when a newer release exists: the same footer as the cog in
  // Issues and Pull requests (update.js is a copy of shared/update.js).
  const u = updateState();
  const update = (cx) => cx.spawn(async () => {
    if ((await installKind(MOD)).kind !== "git") { cx.write_to_clipboard(AGENT_LINE); notify({ title: "Copied the update line for your agent", body: "Paste it to your agent in Herdr.", level: "info", timeout: 5000 }); return; }
    notify({ title: "Updating Herdr Ranch…", level: "info", timeout: 3000 });
    const failed = await updateNow();
    notify(failed ? { title: "Update failed", body: failed, level: "error", timeout: 8000 } : { title: `Herdr Ranch is updated to ${u.latest}`, level: "success", timeout: 5000 });
  });
  const version = h_flex().mt(6).pt(8).gap(6).items_center().border_t_1().border_color(t.border).text_size(11.5).text_color(t.dim)
    .child(div().flex_1().child(`Herdr Ranch v${VERSION}${u.available ? ` · ${u.latest} is out` : u.latest ? " · up to date" : ""}`))
    .child(u.available
      ? div().id("update").px(8).py(2).rounded(5).bg(t.ansi2).text_color(t.background).font_semibold().cursor_pointer().on_click((_e, cx) => update(cx)).child("Update")
      : div().id("check-update").cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground)).on_click(() => { checkForUpdate(true); }).child("Check"));
  return v_flex().size_full().p(10).gap(4).bg(t.background).text_color(t.foreground)
    .children(SETTINGS.map((d) => h_flex().min_h(28).gap(4).items_center().flex_wrap()
      .child(div().w(80).flex_none().text_size(11.5).text_color(t.muted).child(d.label))
      .children(d.choices.map(([v, text]) => choice(`${d.key}-${v}`, text, pref(d.key, d.fallback) === v, () => setPref(d.key, v))))))
    .child(version);
}

// Whether a review belongs to a space: its agent ran there, or its folder is the space's.
// Whether a review belongs to the shown space: its agent ran in it, it ran in the space's folder,
// or in another checkout of the same repository (a worktree: the sidebar lists those under it).
// `repos` maps a folder to its repository (git's common dir), filled by ReviewList.repoOf.
const under = (p, folder) => Boolean(p && folder) && (p === folder || p.startsWith(`${folder}/`));
const worktreeRepo = (p) => String(p ?? "").match(/\/\.herdr\/worktrees\/([^/]+)\//)?.[1] ?? null; // Herdr's own worktrees
function inSpace(r, space, repos) {
  if (!space) return true;
  if (r.agent?.space === space.id || under(r.cwd, space.folder)) return true;
  const mine = repos.get(space.folder);
  if (mine && r.repo && r.repo === mine) return true;
  // Older reviews have no `repo`: a Herdr worktree matches a space that is a worktree of the
  // same repository (the folder name alone could be another repository's).
  const name = worktreeRepo(r.cwd);
  return Boolean(name && space.folder && worktreeRepo(`${space.folder}/`) === name);
}

const opensAtOnce = () => ["open", "auto"].includes(pref("open", "agent"));

// The count on the Reviews button (mod-buttons): open reviews.
async function publishBadge(reviews = null) {
  const count = (reviews ?? (await listReviews())).filter((r) => r.status === "open").length;
  const all = shared("mod-badges") ?? {};
  if ((all[MOD] ?? 0) !== count) setShared("mod-badges", { ...all, [MOD]: count });
}

const alive = async (pid) => Number.isInteger(pid) && (await exec("kill", ["-0", String(pid)]).then((r) => r.code === 0, () => false));

// --- The list --------------------------------------------------------------------------------

async function listReviews() {
  const r = await exec("ls", ["-1", DIR()]).catch(() => null);
  if (!r || r.code !== 0) return [];
  const ids = r.stdout.split("\n").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort().reverse().slice(0, 100);
  return (await Promise.all(ids.map((id) => load(id)))).filter(Boolean).map((got) => got.review);
}

// One tab (or dialog) per document (docKey: a file's path, an agent's last message), shared by
// this mod's copies: { [doc key]: tab id } and { [doc key]: overlay id }. The page records its own
// tab when it opens (run("tab.new") returns nothing to tell it by), and follows a newer review
// of its document (see ReviewPage.follow).
const TABS = `${MOD}-tabs`, DIALOGS = `${MOD}-dialogs`;
const dialogOf = (key) => shared(DIALOGS)?.[key] ?? null;
const rememberDialog = (key, overlay) => { const all = { ...(shared(DIALOGS) ?? {}) }; if (overlay) all[key] = overlay; else delete all[key]; setShared(DIALOGS, all); };
const allTabs = () => spaces().flatMap((s) => (s.tabs ?? []).map((tab) => ({ ...tab, space: s.id })));
const tabOf = (id) => { const tab = shared(TABS)?.[id]; return tab ? allTabs().find((x) => x.id === tab) ?? null : null; };
function rememberTab(id, tab) {
  const live = new Set(allTabs().map((x) => x.id));
  const next = Object.fromEntries(Object.entries(shared(TABS) ?? {}).filter(([k, v]) => k !== id && live.has(v)));
  if (tab) next[id] = tab;
  setShared(TABS, next);
}
const tabName = (r) => { const s = r?.kind === "last" ? "Review: last message" : `Review: ${r?.title ?? "document"}`; return s.length > 40 ? `${s.slice(0, 39)}…` : s; };

// Opens a review as a tab of its own in the shown space (the default), or, with Shows in: Modal,
// as a dialog over the window, like the page of a pull request or an issue. When its document
// already has a tab, that tab is selected (its page shows the newest review); an open dialog of
// it stays the only one.
function openReview(review) {
  const go = (r) => {
    const key = docKey(r);
    if (pref("view", "tab") === "dialog") {
      if (!dialogOf(key)) openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 1240, height: 0.9, props: { review: r.id } });
      return;
    }
    const open = tabOf(key);
    if (open) {
      if (!spaces().find((s) => s.id === open.space)?.active) run("space.select", { id: open.space });
      run("tab.select", { id: open.id });
      return;
    }
    run("tab.new", { name: tabName(r), mod: MOD, props: { review: r.id, tabbed: true } });
  };
  if (review.kind) go(review);
  else load(review.id).then((got) => go(got?.review ?? review), () => go(review));
}

class ReviewList {
  constructor(owner) { this.owner = owner; this.reviews = []; this.loading = false; this.confirming = null; this.repos = new Map(); }

  // The repository of a space's folder (git's common dir), once per folder.
  repoOf(folder, cx) {
    if (!folder || this.repos.has(folder)) return;
    this.repos.set(folder, null);
    cx.spawn(async (cx) => {
      const r = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { this.repos.set(folder, r.stdout.trim()); cx.notify(); }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try { this.reviews = await listReviews(); } finally {
        this.loading = false; publishBadge(this.reviews); cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  remove(review, cx) {
    if (this.confirming !== review.id) { this.confirming = review.id; cx.notify(); return; }
    this.confirming = null;
    cx.spawn(async (cx) => {
      if (review.status === "open") await update(review.id, (r) => ({ ...r, status: "dismissed", result: { decision: "dismissed", comments: [] }, finishedAt: new Date().toISOString() }));
      else await exec("rm", ["-f", fileOf(review.id)]).catch(() => null);
      this.refresh(cx);
    });
  }

  render(t, cx) {
    const scope = pref("scope", "space"), space = scope === "space" ? spaces().find((x) => x.active) ?? null : null;
    if (space) this.repoOf(space.folder, cx);
    // One row per document: its newest review.
    const shown = newestPerDoc(this.reviews.filter((r) => inSpace(r, space, this.repos))).sort((a, b) => (a.id < b.id ? 1 : -1));
    const waiting = shown.filter((r) => r.status === "open");
    // Approved and dismissed reviews leave the list: only feedback you sent stays, for a week,
    // the newest `sent` of them.
    const limit = Number(pref("sent", "10")) || 0;
    const done = shown.filter((r) => r.status === "sent" || stateOf(r) === "undelivered");
    const pill = (text, c) => div().flex_none().px(6).py(1).rounded(4).border_1().border_color(c + "66").bg(c + "12").text_size(11).text_color(c).child(text);
    const heading = (label, n) => h_flex().flex_none().px(10).pt(10).pb(2).gap(6).text_size(12).text_color(t.dim)
      .child(div().font_semibold().child(label)).child(div().child(String(n)));
    const row = (r) => {
      const state = stateOf(r), last = r.kind === "last", asking = this.confirming === r.id;
      const color = last ? t.ansi4 : t.ansi5;
      const badge = state === "waiting" ? pill(r.waiting ? "agent waiting" : "waiting", t.ansi3)
        : state === "undelivered" ? pill("not delivered", t.ansi1)
        : state === "approved" ? pill("approved", t.ansi2) : state === "sent" ? pill("feedback sent", t.ansi2) : pill("discarded", t.dim);
      const comments = (r.result?.comments ?? []).length;
      const meta = [r.agent?.app ?? "agent", `${state === "waiting" ? "asked" : "done"} ${ago(r.finishedAt ?? r.createdAt)} ago`, comments ? `${comments} comment${comments === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
      const x = asking
        ? h_flex().flex_none().gap(4)
          .child(div().id(`yes-${r.id}`).px(8).py(2).rounded(5).bg(t.ansi1).text_color(t.background).text_size(11).font_semibold().cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.remove(r, cx); }).child(r.status === "open" ? "Discard" : "Remove"))
          .child(div().id(`no-${r.id}`).px(6).py(2).rounded(5).text_size(11).text_color(t.muted).cursor_pointer().hover((e) => e.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.confirming = null; cx.notify(); }).child("Cancel"))
        : div().id(`x-${r.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
          .hover((e) => e.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.remove(r, cx); }).child("×");
      return h_flex().id(`r-${r.id}`).flex_none().gap(8).items_start().px(10).py(7).rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          if (await load(r.id)) openReview(r);
          else { notify({ title: "That review is gone", level: "info", timeout: 3000 }); this.refresh(cx); }
        }))
        .child(div().size(20).flex_none().rounded_full().bg(color + "2e").flex().items_center().justify_center().text_size(11).text_color(color).child(last ? "✦" : "¶"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().child(last ? `Last message: ${quoteOf(r.text, 70).replace(/\s+/g, " ")}` : r.title))
          .child(h_flex().gap(6).items_center().child(pill(last ? "last message" : "document", color)).child(badge)
            .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(meta))))
        .child(x);
    };
    const overlay = props()?.overlay;
    return v_flex().id(MOD).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Reviews"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(space ? space.name : "every space"))
        .child(h_flex().flex_none().rounded(6).border_1().border_color(t.border).text_size(12)
          .children([["space", "This space"], ["all", "All"]].map(([v, label], k) => div().id(`scope-${v}`).px(8).py(2).cursor_pointer()
            .when(k === 0, (e) => e.border_r_1().border_color(t.border))
            .when(scope === v, (e) => e.bg(t.selected).font_semibold()).when(scope !== v, (e) => e.text_color(t.muted))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { setPref("scope", v); cx.notify(); }).child(label))))
        .child(div().id("settings").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((x) => x.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openSettings()).child(svg("mods/workspace-chrome/settings.svg").size(14)))
        .child(div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child(this.loading ? "…" : "↻"))
        .when(Boolean(overlay), (e) => e.child(div().id("close").px(6).cursor_pointer().text_color(t.dim).on_click(() => closeOverlay(overlay)).child("×"))))
      .child(v_flex().id("reviews-list").flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .when(waiting.length > 0, (e) => e.child(heading("Waiting on you", waiting.length)).children(waiting.map(row)))
        .when(limit > 0 && done.length > 0, (e) => e.child(heading("Sent", Math.min(done.length, limit))).children(done.slice(0, limit).map(row)))
        .when(!waiting.length && (!limit || !done.length) && this.reviews.length > 0 && !this.loading, (e) => e.child(div().p(12).text_color(t.dim)
          .child(space ? "Nothing waiting on you in this space." : "Nothing waiting on you.")))
        .when(!this.reviews.length, (e) => e.child(div().p(12).text_color(t.dim)
          .child(this.loading ? "Loading…" : "No reviews yet. Ask an agent for one with /herdr-ranch-review <file.md> or /herdr-ranch-review-last."))));
  }
}

// Closes this copy's dialog, or its tab (a review shown elsewhere stays).
const tabbed = () => Boolean(props()?.tabbed);
function closeSelf(key) {
  const o = props()?.overlay;
  if (o) { if (key && dialogOf(key) === o) rememberDialog(key, null); closeOverlay(o); return; }
  if (!tabbed() || !key) return;
  const tab = tabOf(key);
  if (tab) { rememberTab(key, null); run("tab.close", { id: tab.id, confirmed: true }); }
}

// A review's tab records itself: the shown tab holding a Reviews pane that no other review owns
// (tab.new selects the tab it makes). Tried for a second, while the tab settles.
function claimTab(id, cx) {
  cx.spawn(async (cx) => {
    for (let i = 0; i < 20; i++) {
      const owned = new Set(Object.entries(shared(TABS) ?? {}).filter(([k]) => k !== id).map(([, v]) => v));
      const tab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active);
      if (tab && !owned.has(tab.id) && panes().some((p) => p.tab === tab.id && p.mod === MOD)) { rememberTab(id, tab.id); return; }
      await new Promise((resolve) => cx.timer.after(50, () => resolve()));
    }
  });
}

// --- One review ------------------------------------------------------------------------------

// The Rendered | Source icons (Lucide's eye and code, ISC license). svg() reads only real
// files under the app's home, not a linked mod folder, so they are written to
// data/herdr-ranch/icons once (again only when one differs). An icon takes the text color.
const ICONS = "data/herdr-ranch/icons";
const ICON_BODIES = {
  "review-rendered": '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  "review-source": '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
};
let iconsWritten = null;
const writeIcons = () => iconsWritten ??= (async () => {
  const dir = `${appHome()}/${ICONS}`;
  await exec("mkdir", ["-p", dir]).catch(() => null);
  for (const [name, body] of Object.entries(ICON_BODIES)) {
    const path = `${dir}/${name}.svg`;
    const text = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
    const now = await readTextFile(path).catch(() => null);
    if (now !== text) await writeTextFile(path, text, now).catch(() => null);
  }
})();

class ReviewPage {
  constructor(id) {
    this.id = id; this.review = null; this.blocks = []; this.missing = false;
    this.comments = []; // { key, start?, end?, quote?, text, block? }
    this.editing = null; // { key, block (index or null), state }
    this.source = false; this.busy = false; this.note = null;
    this.focus = null; // the block a clicked comment points at, highlighted
    // Search: every block stays and the matching words are highlighted. No jump to a match:
    // a mod can't scroll the document from code (see RECIPE, Watch out).
    this.search = InputState.new({ placeholder: "Search  ⌘F" });
    this.search.on("change", (_e, cx) => cx.notify());
  }

  load(cx) {
    cx.spawn(async (cx) => { await writeIcons(); cx.notify(); });
    cx.spawn(async (cx) => {
      const got = await load(this.id);
      if (!got) {
        // Gone before it showed: its tab still needs × to close it.
        this.missing = true; this.key = `id:${this.id}`;
        if (tabbed() && !tabOf(this.key)) claimTab(this.key, cx);
        cx.notify(); return;
      }
      // Opened on a review that a newer one of its document replaced: show that one.
      if (got.review.status !== "open" && (await this.follow(cx, got.review))) return;
      this.review = got.review; this.key = docKey(got.review);
      this.blocks = splitBlocks(got.review.text);
      if (got.review.draft && !this.comments.length) this.comments = got.review.draft;
      const o = props()?.overlay;
      if (o) rememberDialog(this.key, o);
      else if (tabbed() && !tabOf(this.key)) claimTab(this.key, cx);
      cx.notify();
    });
  }

  // Keeps unsent comments in the review file, so closing the pane doesn't lose them.
  saveDraft(cx) {
    const draft = this.comments.map(({ key, block, start, end, quote, text, images, thumbs }) => ({ key, block, start, end, quote, text, images, thumbs }));
    cx.spawn(async () => { await update(this.id, (r) => (r.status === "open" ? { ...r, draft } : r)); });
  }

  edit(block, cx, existing = null) {
    if (this.review?.status !== "open") return;
    // Clicking a block that has a comment opens that comment (with its screenshots), not a new one.
    if (!existing && block !== null) existing = this.comments.find((c) => c.block === block && !c.thumbs) ?? null;
    if (this.editing && this.editing.key === existing?.key) return;
    if (this.editing) this.saveEdit(cx);
    const state = TextareaState.new({ placeholder: block === null ? "General feedback about the whole document…" : "Comment on this block…", value: existing?.text ?? "" });
    state.set_auto_grow(3, 12);
    // ⌘↵ saves the comment; ⌘⇧↵ saves it and sends the review.
    state.on("submit", (e, cx) => { if (e?.secondary && e?.shift) this.send(cx); else if (e?.secondary) this.saveEdit(cx); });
    // A paste that holds no text (a screenshot): saved as a PNG next to the review.
    state.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.editing = { key: existing?.key ?? `c${Date.now().toString(36)}`, block, state, images: [...(existing?.images ?? [])] };
    cx.notify();
    try { cx.timer.after(0, () => state.focus()); } catch { state.focus(); }
  }

  // macOS: the clipboard's image, written with AppleScript (no other way for a mod to read it).
  pasteImage(cx) {
    const e = this.editing;
    if (!e) return;
    const rel = `data/${MOD}/img/${this.id}-${Date.now().toString(36)}.png`, abs = `${appHome()}/${rel}`;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${DIR()}/img`]).catch(() => null);
      const script = [`set f to open for access POSIX file "${abs}" with write permission`, "try", "write (the clipboard as «class PNGf») to f", "end try", "close access f"];
      await exec("osascript", script.flatMap((l) => ["-e", l])).catch(() => null);
      const ok = await exec("test", ["-s", abs]).then((r) => r.code === 0, () => false);
      if (!ok) { await exec("rm", ["-f", abs]).catch(() => null); notify({ title: "No image on the clipboard", level: "warning", timeout: 3000 }); return; }
      if (this.editing === e) { e.images.push(abs); cx.notify(); }
    });
  }

  saveEdit(cx) {
    const e = this.editing;
    if (!e) return;
    const text = e.state.value().trim();
    this.comments = this.comments.filter((c) => c.key !== e.key);
    if (text || e.images.length) {
      const b = e.block === null ? null : this.blocks[e.block];
      this.comments.push(b ? { key: e.key, block: e.block, start: b.start, end: b.end, quote: quoteOf(b.text, 120), text, images: e.images } : { key: e.key, text, images: e.images });
    }
    e.state.release?.(); this.editing = null; this.refocus();
    this.saveDraft(cx); cx.notify();
  }

  // 👍 on a block, from its comment box: an "Ok" note on it (Plannotator's quick label).
  thumbs(i, cx) {
    if (this.review?.status !== "open") return;
    if (this.comments.some((c) => c.block === i && c.thumbs)) return;
    { const b = this.blocks[i]; this.comments.push({ key: `t${Date.now().toString(36)}`, block: i, start: b.start, end: b.end, quote: quoteOf(b.text, 120), text: "👍 Ok", thumbs: true }); }
    this.saveDraft(cx); cx.notify();
  }

  // An image a block shows: copied next to the reviews (a mod shows images from Herdr's folder
  // only), with its size for a width of at most 640 px. null while loading, or for a web image or a
  // missing file (the block then shows its description).
  picture(src, cx) {
    this.pictures ??= new Map();
    if (this.pictures.has(src)) return this.pictures.get(src);
    this.pictures.set(src, null);
    const r = this.review;
    if (!r || /^[a-z]+:/i.test(src) || !/\.(png|jpe?g|gif|webp|svg)$/i.test(src)) return null;
    const file = r.kind === "file" && r.path ? (r.path.startsWith("/") ? r.path : `${r.cwd}/${r.path}`) : `${r.cwd}/x`;
    const abs = src.startsWith("/") ? src : `${file.slice(0, file.lastIndexOf("/"))}/${src}`;
    let h = 0; for (const ch of abs) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rel = `data/${MOD}/img/view-${h.toString(36)}${abs.slice(abs.lastIndexOf("."))}`;
    cx.spawn(async (cx) => {
      const cp = await exec("cp", [abs, `${appHome()}/${rel}`]).catch(() => null);
      if (cp?.code !== 0) return;
      const size = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]).catch(() => null);
      const pw = Number(size?.stdout.match(/pixelWidth: (\d+)/)?.[1]) || 640, ph = Number(size?.stdout.match(/pixelHeight: (\d+)/)?.[1]) || 320;
      const w = Math.min(640, pw), hh = Math.round((ph * w) / pw);
      this.pictures.set(src, { rel, w, h: hh });
      cx.notify();
    });
    return null;
  }

  // Highlights the block a comment is on.
  reveal(block) {
    if (block == null) return;
    this.focus = block;
    // Not scrolled to: the only element a mod can scroll from code, Herdr's lazy `list`,
    // stayed empty with these rows (tested 2026-11-02), so the block is only highlighted.
  }

  // ⌘⇧↵: Send the comments, or Approve when there are none.
  send(cx) {
    if (this.review?.status !== "open") return;
    if (this.editing) this.saveEdit(cx);
    this.finish(this.comments.length ? "annotated" : "approved", cx);
  }

  // Block comments by line, then by when they were added; general ones last, by when they were added.
  ordered() {
    const at = (c) => c.at ?? (parseInt(String(c.key).slice(1), 36) || 0);
    return [...this.comments].sort((a, b) => (a.start == null) - (b.start == null) || (a.start ?? 0) - (b.start ?? 0) || at(a) - at(b));
  }

  cancelEdit(cx) { this.editing?.state.release?.(); this.editing = null; this.refocus(); cx.notify(); }
  clearSearch(cx) { this.search.set_value(""); this.refocus(); cx.notify(); }
  refocus() { try { this.handle?.focus(); } catch { /* not shown yet */ } }
  removeComment(key, cx) { this.comments = this.comments.filter((c) => c.key !== key); this.saveDraft(cx); cx.notify(); }

  // Send (decision "annotated"), Approve as is ("approved") or Discard ("dismissed").
  finish(decision, cx) {
    if (this.busy || !this.review) return;
    if (this.editing) this.saveEdit(cx);
    const subject = this.review.kind === "last" ? "message" : "file";
    const comments = this.ordered().map(({ start, end, quote, text, images }) => ({ start, end, quote, text, images }));
    const feedback = decision === "dismissed" ? "" : formatFeedback(subject, comments);
    if (decision === "annotated" && !feedback) { this.note = "Write a comment first."; cx.notify(); return; }
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const status = decision === "annotated" ? "sent" : decision;
      const done = await update(this.id, (r) => ({ ...r, status, draft: null, finishedAt: new Date().toISOString(), result: { decision, feedback, comments } }));
      if (!done) { this.busy = false; this.note = "Couldn't save the review."; cx.notify(); return; }
      this.review = done;
      publishBadge().catch(() => null);
      // A waiting `ranch-review` takes the answer; else the watcher pastes it into the agent
      // (deliver), so this dialog closes now. Without a watcher (another layout), it delivers.
      if (!(await watcherAlive())) await deliver(this.id, cx);
      this.busy = false; cx.notify();
      closeSelf(this.key);
    });
  }

  render(t, cx) {
    if (this.missing) return h_flex().size_full().items_start().bg(t.background).p(16).gap(8)
      .child(div().flex_1().text_color(t.dim).child("This review is gone (removed, or older than a week)."))
      .child(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_size(16).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeSelf(this.key)).child("×"));
    const r = this.review;
    if (!r) return v_flex().size_full().bg(t.background).p(16).text_color(t.dim).child("Loading…");
    const open = r.status === "open";
    const btn = (id, label, click, primary = false, enabled = true, tip = null) => div().id(id).flex_none().when(Boolean(tip), (e) => e.tooltip(tip)).px(10).py(3).rounded(6).text_size(12)
      .border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(enabled && !this.busy, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => click(cx)))
      .when(!enabled || this.busy, (e) => e.opacity(0.5))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(label);
    // Rendered | Source, as icons (an eye, </>), named on hover. See ICONS.
    const view = (id, tip, on, source) => div().id(id).tooltip(tip).h(24).w(28).flex().items_center().justify_center().cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.source = source; cx.notify(); }).child(svg(`${ICONS}/review-${id}.svg`).size(14).flex_none().text_color(on ? t.foreground : t.muted));
    const toggle = h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .child(view("rendered", "Rendered", !this.source, false))
      .child(view("source", "Source (Markdown)", this.source, true));
    const n = this.comments.length;
    const query = this.search.value().trim(), hits = matchBlocks(this.blocks, query, this.source) ?? [];
    const matches = countMatches(this.blocks, query, this.source);
    const status = open ? (r.waiting ? "agent waiting" : "waiting") : stateOf(r) === "undelivered" ? "not delivered" : stateOf(r);
    const header = h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_semibold().truncate().child(r.kind === "last" ? "Last message" : r.title))
        .child(div().text_size(11).text_color(t.dim).truncate().child([r.agent?.app ?? "agent", status, r.kind === "file" ? r.path : null].filter(Boolean).join(" · "))))
      .child(h_flex().id("search").flex_none().w(220).gap(6).items_center().px(8).py(3).rounded(6).border_1().border_color(query ? t.accent : t.border).text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().flex_1().min_w(0).child(Input.new(this.search)))
        .when(Boolean(query), (e) => e.child(div().flex_none().text_size(11).text_color(hits.length ? t.dim : t.ansi1).child(`${matches} match${matches === 1 ? "" : "es"}`))
          .child(div().id("search-clear").flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.clearSearch(cx)).child("×"))))
      .child(toggle)
      // No "approve with notes": a general comment plus Send covers it. ⌘⇧↵ sends, or approves with no comments.
      // What each button tells the agent, on hover too.
      .when(open, (e) => e.child(btn("dismiss", "Discard", (cx) => this.finish("dismissed", cx), false, true, "Close the review without an answer: the agent gets nothing back"))
        .when(!n, (e) => e.child(btn("approve", "Approve as is  ⌘⇧↵", (cx) => this.finish("approved", cx), true, true, "Tell the agent it's good as it is (no comments)")))
        .when(n > 0, (e) => e.child(btn("send", `Send ${n} comment${n === 1 ? "" : "s"}  ⌘⇧↵`, (cx) => this.finish("annotated", cx), true, true, "Send your comments to the agent"))))
      .when(!open && stateOf(r) === "undelivered", (e) => e.child(btn("copy", "Copy feedback", (cx) => { cx.write_to_clipboard(pastePrompt(r)); notify({ title: "Copied", level: "info", timeout: 2000 }); })))
      // × closes the dialog or tab only: the review keeps waiting, with its unsent comments, in Reviews.
      .when(Boolean(props()?.overlay) || tabbed(), (e) => e.child(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_size(16)
        .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { if (this.editing) this.saveEdit(cx); closeSelf(this.key); }).child("×")));

    // The document: one row per block, with its source lines (and comment numbers) on the right.
    // A click on a block comments on it.
    const counted = new Map();
    const ordered = this.ordered();
    ordered.forEach((c, i) => { if (c.block != null) counted.set(c.block, [...(counted.get(c.block) ?? []), c.thumbs ? "👍" : String(i + 1)]); });
    const row = (i) => {
      const b = this.blocks[i], marks = counted.get(i), item = b.kind === "item";
      const lit = this.editing?.block === i || this.focus === i;
      const pics = this.source ? null : imageOnly(b.text);
      const content = pics
        ? v_flex().flex_1().min_w(0).gap(6).children(pics.map((p, k) => {
          const got = this.picture(p.src, cx);
          return got ? image(got.rel).w(got.w).h(got.h).rounded(4)
            : div().id(`pic-${i}-${k}`).text_size(13).text_color(t.dim).child(`🖼 ${p.alt || p.src}`);
        }))
        : this.source || b.kind === "frontmatter"
        ? v_flex().flex_1().min_w(0).text_size(12).text_color(t.foreground).children(b.text.split("\n").map((l, k) => (query && l.toLowerCase().includes(query.toLowerCase())
          ? h_flex().id(`s-${i}-${k}`).min_h(16).children(hitsIn(l, query).map(([part, hit], m) => div().id(`s-${i}-${k}-${m}`).when(hit, (e) => e.bg(t.ansi3 + "55").rounded(2)).child(part)))
          : div().id(`s-${i}-${k}`).min_h(16).child(l || " "))))
        : div().flex_1().min_w(0).text_size("15px").line_height("24px").child(TextView.markdown(`b-${i}`, query && b.kind !== "code" ? markHits(b.text, query) : b.text).selectable(true));
      return h_flex().id(`blk-${i}`).w_full().gap(10).items_start().px(30).py(b.kind === "heading" ? 10 : item ? 1 : 6)
        .child(h_flex().flex_1().min_w(0).gap(10).items_start().px(10).py(2).rounded(6).border_1()
          .border_color(lit ? t.accent : "#00000000").when(Boolean(marks) || lit, (e) => e.bg(t.selected))
          // A click comments on the block; a drag (selecting text to copy with ⌘C) or a
          // double-click (selecting a word) doesn't. Decided on release, from where it was pressed.
          .when(open, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (ev) => { this.press = { i, x: ev.position.x, y: ev.position.y }; })
            .on_mouse_up("left", (ev, cx) => {
              const p = this.press; this.press = null;
              if (!p || p.i !== i || ev.click_count > 1 || Math.hypot(ev.position.x - p.x, ev.position.y - p.y) > 4) return;
              this.focus = null; this.edit(i, cx);
            }))
          .child(content)
          // The comment numbers (or 👍) and the source lines, on one line.
          .child(h_flex().flex_none().min_w(52).gap(5).items_center().justify_end()
            .when(Boolean(marks), (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.accent).text_size(10).text_color(t.accent_foreground).child(marks.join(","))))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(b.start === b.end ? String(b.start) : `${b.start}-${b.end}`))));
    };
    const doc = v_flex().id("doc").flex_1().min_w(0).min_h(0).py(12).overflow_y_scrollbar()
      .children(this.blocks.slice(0, MAX_BLOCKS).map((_b, i) => row(i)))
      .when(this.blocks.length > MAX_BLOCKS, (e) => e.child(div().p(10).text_color(t.dim).child(`${this.blocks.length - MAX_BLOCKS} more blocks are not shown.`)));

    // The comments column.
    const editor = (label) => v_flex().gap(6).p(8).rounded(6).border_1().border_color(t.accent).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(Textarea.new(this.editing.state).w_full().text_size(12))
      .when(this.editing.images.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(this.editing.images.map((p, k) =>
        div().id(`img-${k}`).relative().child(image(p.slice(appHome().length + 1)).w(72).h(48).rounded(4))
          .child(div().id(`img-x-${k}`).absolute().top(0).right(0).px(3).rounded(3).bg(t.background).text_size(10).cursor_pointer()
            .on_click((_e, cx) => { this.editing.images.splice(k, 1); cx.notify(); }).child("×"))))))
      .child(h_flex().gap(6).justify_end()
        .when(this.editing.block !== null, (e) => e.child(btn("thumbs", "👍", (cx) => { const i = this.editing.block; this.cancelEdit(cx); this.thumbs(i, cx); }, false, true, "Sends \"Ok\" on this block")))
        .child(div().flex_1())
        .child(btn("cancel-edit", "Cancel", (cx) => this.cancelEdit(cx)))
        .child(btn("save-edit", "Save (⌘↵)", (cx) => this.saveEdit(cx), true)));
    const card = (c, i) => {
      if (this.editing?.key === c.key) return editor(c.start ? `${i + 1} · ${lineLabel(c.start, c.end)}` : `${i + 1} · General`);
      return v_flex().id(`c-${c.key}`).gap(2).p(8).rounded(6).border_1().border_color(t.border).bg(t.background)
        .when(open, (e) => e.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click((_e, cx) => { this.reveal(c.block); this.edit(c.block ?? null, cx, c); }))
        .child(h_flex().gap(6).items_start()
          .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(c.start ? `${i + 1} · ${lineLabel(c.start, c.end)} · "${quoteOf(c.quote, 50).replace(/\s+/g, " ")}"` : `${i + 1} · General`))
          .when(open, (e) => e.child(div().id(`del-${c.key}`).px(4).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.removeComment(c.key, cx); }).child("×"))))
        .child(div().text_size(12).child(c.text))
        .when((c.images ?? []).length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(c.images.map((p) => image(p.slice(appHome().length + 1)).w(72).h(48).rounded(4)))));
    };
    const newEditor = this.editing && !this.comments.some((c) => c.key === this.editing.key);
    const newLabel = this.editing?.block == null ? "General" : (() => { const b = this.blocks[this.editing.block]; return `${lineLabel(b.start, b.end)} · "${quoteOf(b.text, 50).replace(/\s+/g, " ")}"`; })();
    const side = v_flex().id("comments").w(340).flex_none().min_h(0).p(8).gap(6).border_l(1).border_color(t.border).bg(t.surface ?? t.background).overflow_y_scrollbar()
      .children(ordered.map(card))
      .when(Boolean(newEditor), (e) => e.child(editor(newLabel)))
      .when(open && !this.editing, (e) => e.child(div().id("general").p(8).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.edit(null, cx)).child("+ General comment")))
      .when(!n && !this.editing && open, (e) => e.child(div().p(4).text_size(11).text_color(t.dim).child("Click a block to comment on it.")))
      .when(!open, (e) => e.child(div().p(4).text_size(12).text_color(t.dim).child(
        r.status === "dismissed" ? "Discarded." : stateOf(r) === "undelivered" ? "The agent didn't take this feedback: copy it above." : r.delivery === "pasted" ? "Sent: pasted into the agent." : "Sent to the agent.")))
      .when(Boolean(this.note), (e) => e.child(div().p(4).text_size(12).text_color(t.ansi1).child(this.note)));

    if (!this.focused && this.handle) { this.focused = true; this.refocus(); }
    return v_flex().id(`${MOD}-review`).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(this.handle), (e) => e.track_focus(this.handle))
      .key_context("RanchReview")
      .on_action("ranch_review_send", (_e, cx) => { if (open) this.send(cx); })
      .on_action("ranch_review_find", () => this.search.focus())
      .on_key_down((e, cx) => {
        if (e.key === "escape" && query && !this.editing) { this.clearSearch(cx); cx.stop_propagation(); return; }
        const chord = e.keystroke === "cmd-shift-enter" || (e.key === "enter" && e.modifiers?.platform && e.modifiers?.shift);
        if (!open || !chord) return;
        this.send(cx);
        cx.stop_propagation();
      })
      .child(header)
      .child(h_flex().flex_1().min_h(0).items_start().child(doc).child(side));
  }
}

// The watcher: an invisible copy in the layout (`"background": true` in mod.json: the mod-buttons
// layout gives it a 0 px block with props { background: true }), alive
// while Herdr runs. It sees a new review arrive in the folder, counts it on the Reviews button,
// and opens the review when you go to its agent (or right away, by setting), so the CLI needs no pane to wake the mod.
// `ranch-review` checks its heartbeat file and splits a launcher pane only when no watcher runs.
const HEARTBEAT = ".watcher";
// True for the one copy that marks a review first (compare-and-swap on its file): `key` set to
// now, unless set less than `ms` ago. Two watchers (an old copy during a reload, a second
// window) then don't both open a dialog.
async function claimOnce(id, key, ms = Infinity) {
  const got = await load(id);
  if (!got || got.review.status !== "open") return false;
  const at = got.review[key];
  if (at && (at === true || Date.now() - at < ms)) return false;
  try { await writeTextFile(fileOf(id), JSON.stringify({ ...got.review, [key]: Date.now() }, null, 2), got.raw); return true; } catch { return false; }
}
const claimAnnounce = (id) => claimOnce(id, "announced");

// Whether the watcher runs (its heartbeat changed in the last minute).
const watcherAlive = async () => (await exec("sh", ["-c", '[ -n "$(find "$1" -mmin -1 2>/dev/null)" ]', "sh", `${DIR()}/${HEARTBEAT}`]).catch(() => null))?.code === 0;
const sameTerminal = (address, terminal) => Boolean(address && terminal) && (address === terminal || address.endsWith(`/${terminal}`));

// Pastes a finished review into its agent once it is idle: "pasted", or "kept" when the agent is
// gone, asking something, or stays busy past PASTE_FOR.
async function pasteInto(review, cx) {
  const terminal = review.agent?.terminal, text = pastePrompt(review), until = Date.now() + PASTE_FOR;
  for (;;) {
    const agent = agents().find((a) => sameTerminal(a.address, terminal));
    if (!agent || agent.status === "blocked") return "kept";
    if (agent.status !== "working") {
      const r = await hc(["send", "--if", "idle", terminal, text]).catch(() => null);
      if (r?.code === 0) return "pasted";
    }
    if (Date.now() >= until) return "kept";
    await new Promise((resolve) => cx.timer.after(PASTE_EVERY, () => resolve()));
  }
}

// Delivers a finished review that no `ranch-review` took: a discard is removed; feedback or an
// approval is pasted into the agent. Claimed first (delivery "pasting", compare-and-swap) and only
// once the CLI is gone, so the agent never gets it twice. The CLI marks its own delivery "cli"
// (or removes the file) before it exits.
async function deliver(id, cx) {
  const got = await load(id), r = got?.review;
  if (!r || r.status === "open" || r.delivery) return;
  if (await alive(r.waiting?.pid)) return; // the CLI takes it
  if (r.status === "dismissed") { await exec("rm", ["-f", fileOf(id)]).catch(() => null); return; }
  try { await writeTextFile(fileOf(id), JSON.stringify({ ...r, delivery: "pasting" }, null, 2), got.raw); } catch { return; }
  const outcome = await pasteInto(r, cx);
  await update(id, (x) => ({ ...x, delivery: outcome, deliveredAt: new Date().toISOString() }));
  if (outcome === "pasted" && r.status === "approved") await exec("rm", ["-f", fileOf(id)]).catch(() => null);
  if (outcome === "pasted") notify({ title: "Feedback sent to the agent", body: r.title, level: "success", timeout: 3000 });
  else notify({ title: "Feedback not delivered", body: `The agent isn't there or is asking something. Copy it from Reviews: ${r.title}.`, level: "warning", timeout: 8000 });
}

function watcher(view, cx) {
  const seen = new Set();
  let waiting = []; // open reviews, from the last scan
  // `touch`: writeTextFile won't replace a file without its current text.
  const beat = () => exec("touch", [`${DIR()}/${HEARTBEAT}`]).catch(() => null);
  const scan = async (first) => {
    let all = await listReviews();
    // One open review per document: an older one is replaced by the newest (the CLI does this
    // when it asks; this catches reviews from before, or from an older CLI).
    const newest = new Map(newestPerDoc(all.filter((x) => x.status === "open")).map((x) => [docKey(x), x]));
    const replaced = all.filter((x) => x.status === "open" && newest.get(docKey(x)) !== x);
    for (const x of replaced) {
      const n = newest.get(docKey(x));
      if (x.draft?.length && !n.draft?.length) await update(n.id, (r) => (r.status === "open" && !r.draft?.length ? { ...r, draft: carryDraft(x.draft, splitBlocks(r.text)) } : r));
      await update(x.id, (r) => (r.status === "open" ? { ...r, status: "dismissed", supersededBy: { id: n.id, terminal: n.agent?.terminal ?? null }, draft: null, finishedAt: new Date().toISOString(), result: { decision: "dismissed", comments: [] } } : r));
    }
    if (replaced.length) all = await listReviews();
    waiting = all.filter((x) => x.status === "open");
    await publishBadge(all);
    for (const x of all) if (x.status !== "open" && !x.delivery) cx.spawn(async (cx) => { await deliver(x.id, cx); });
    for (const r of all.filter((x) => x.status === "open")) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      // The CLI may not have known the agent's space, tab or app: Herdr's agents() does.
      const a = r.agent?.terminal && !r.agent.space ? agents().find((x) => sameTerminal(x.address, r.agent.terminal)) : null;
      if (a) await update(r.id, (x) => ({ ...x, agent: { ...x.agent, pane: a.pane, space: a.space, tab: a.tab, app: x.agent?.app ?? a.app } }));
      if (first) continue; // already there when Herdr started: counted, not announced
      // Its agent is the one in front of you (you just typed the skill there), or Immediately:
      // open it now, once, whichever copy marks the file first (compare-and-swap), so two
      // watchers (an old copy during a reload, a second window) don't both open it.
      const here = agents().find((x) => x.focused)?.address;
      if ((opensAtOnce() || sameTerminal(here, r.agent?.terminal)) && (await claimAnnounce(r.id))) openReview(r);
    }
  };
  cx.spawn(async () => {
    await exec("mkdir", ["-p", DIR()]).catch(() => null);
    setShared(DIALOGS, {}); // dialogs don't outlive Herdr; the watcher starts with it
    await beat(); await scan(true);
    try { for (;;) { const changed = await watchFolder(DIR()); if (changed.some((f) => f.endsWith(".json"))) await scan(false); } } catch { /* reloading */ }
  });
  cx.timer.every(20000, () => { beat(); });
  // Going to an agent that waits for a review (a click on it under Needs you, or any other way
  // there) opens that review. Only on arrival: closing the review leaves you with the agent.
  // Moving into a dialog (no agent focused) isn't leaving: only another agent counts.
  let focused = agents().find((a) => a.focused)?.address ?? null;
  cx.timer.every(400, () => {
    const now = agents().find((a) => a.focused)?.address ?? null;
    if (!now || now === focused) return;
    focused = now;
    const r = waiting.find((x) => sameTerminal(now, x.agent?.terminal));
    if (r) cx.spawn(async () => { if (await claimOnce(r.id, "focusOpenedAt", 3000)) openReview(r); });
  });
}

export default class Reviews extends View {
  watch(cx) { this.watching = true; watcher(this, cx); }

  // A dialog closed any way (Esc, a click outside) is no longer its document's.
  async close() { const o = props()?.overlay, k = this.page?.key; if (o && k && dialogOf(k) === o) rememberDialog(k, null); }

  init(_props, cx) {
    // Opened by `ranch-review` as a pane beside the agent: open the review as a dialog, then
    // close that pane again (a mod can't open a dialog from outside).
    if (props()?.settings) { this.settings = true; checkForUpdate(); return; }
    if (props()?.background) { this.watch(cx); return; }
    const launch = props()?.launch;
    if (launch) {
      this.launched = true;
      // The CLI may not have known the agent's space, tab or app: Herdr's agents() does.
      cx.spawn(async () => {
        const got = await load(String(launch)), term = got?.review?.agent?.terminal;
        const a = term ? agents().find((x) => sameTerminal(x.address, term)) : null;
        if (a) await update(String(launch), (r) => ({ ...r, agent: { ...r.agent, pane: a.pane, space: a.space, tab: a.tab, app: r.agent?.app ?? a.app } }));
      });
      cx.spawn(async () => { await publishBadge(); });
      // No watcher runs (the CLI splits a launcher only then), so nothing could open it later:
      // open it now.
      const before = new Set(allTabs().map((x) => x.id)), reviewTabs = new Set(Object.values(shared(TABS) ?? {}));
      openReview({ id: String(launch) });
      // A Reviews pane split into a tab is a launcher (this one, or one left over): close the
      // ones in the agent's tab once the new pane exists. A review's own tab (Shows in: Tab) is
      // not one: it is new, or already a review's.
      cx.spawn(async (cx) => {
        const tab = (await load(String(launch)))?.review?.agent?.tab ?? null;
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => cx.timer.after(100, () => resolve()));
          const mine = panes().filter((p) => p.mod === MOD && before.has(p.tab) && !reviewTabs.has(p.tab) && (!tab || p.tab === tab));
          if (mine.length) { for (const p of mine) run("pane.close", { pane: p.pane }); return; }
        }
      });
      return;
    }
    const id = props()?.review;
    if (id) {
      this.page = new ReviewPage(String(id));
      this.page.handle = cx.focus_handle(); // so ⌘⇧↵ reaches the page when no editor has focus
      // ⌘⇧↵ as a key binding: it reaches the page through the comment box, which a key-down
      // handler on the page doesn't (the box takes Enter with any modifier).
      try { cx.bind_keys([{ keystroke: "cmd-shift-enter", action: "ranch_review_send", context: "RanchReview" }, { keystroke: "cmd-f", action: "ranch_review_find", context: "RanchReview" }]); } catch { /* the key-down fallback */ }
      this.page.load(cx);
      // The CLI or the list may change it (a dismiss from the list, the CLI marking delivery).
      cx.spawn(async (cx) => { try { for (;;) { const changed = await watchFolder(DIR()); if (changed.some((p) => p.endsWith(`/${this.page.id}.json`))) this.page.refresh(cx); } } catch { /* closing */ } });
      return;
    }
    this.list = new ReviewList(this);
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR()]).catch(() => null);
      try { for (;;) { await watchFolder(DIR()); this.list.refresh(cx); } } catch { /* closing */ }
    });
    this.list.refresh(cx);
    cx.timer.every(30000, (cx) => this.list.refresh(cx));
  }

  render(cx) {
    const t = theme();
    if (this.watching) return div().size_full();
    if (this.settings) return settingsMenu(t);
    if (this.launched) return div().size_full().bg(t.background);
    return this.page ? this.page.render(t, cx) : this.list.render(t, cx);
  }
}

// Picks up a status change made elsewhere (the list dismissed it, the CLI marked the delivery),
// keeping the comments being written here.
ReviewPage.prototype.refresh = function refresh(cx) {
  cx.spawn(async (cx) => {
    const got = await load(this.id);
    // Replaced by a newer review of the same document: show that one, in this tab or dialog.
    if (!this.busy && (!got || got.review.status === "dismissed") && (await this.follow(cx, got?.review))) return;
    // Gone while shown: finished elsewhere (the CLI removes approved and discarded reviews).
    if (!got) { if (this.review) { closeSelf(this.key); return; } this.missing = true; cx.notify(); return; }
    const before = this.review?.status;
    this.review = got.review;
    if (before === "open" && got.review.status === "dismissed" && !this.busy) closeSelf(this.key);
    cx.notify();
  });
};

// The newest open review of this page's document, newer than the one shown (its `supersededBy`,
// or found in the folder: the replaced file may be gone already). Switches the page to it, with
// the new review's comments (the CLI moved the unsent ones over). True when it switched.
ReviewPage.prototype.follow = async function follow(cx, old) {
  const key = this.key ?? (old ? docKey(old) : null);
  if (!key) return false;
  let next = old?.supersededBy?.id ? (await load(old.supersededBy.id))?.review : null;
  if (!next || next.status !== "open") next = (await listReviews()).filter((r) => r.status === "open" && docKey(r) === key && r.id > this.id).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (!next) return false;
  this.editing?.state.release?.(); this.editing = null; this.focus = null; this.note = null;
  this.id = next.id; this.review = next; this.key = key;
  this.blocks = splitBlocks(next.text);
  this.comments = next.draft ?? [];
  notify({ title: "Showing the newest version of this document", body: next.title, level: "info", timeout: 3000 });
  cx.notify();
  return true;
};
