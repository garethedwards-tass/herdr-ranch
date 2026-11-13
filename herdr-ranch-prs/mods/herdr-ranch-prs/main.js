// Pull requests of the shown space's GitHub repository (linked with Link space, else the
// space folder's remote), grouped by what each waits on, with a page per pull request
// and "Review with agent". A selected pull request's page takes the list's place (the
// list's row at once, the rest when it loads); Back (or Esc) shows the list again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, exec, nextCommand, shared, setShared, spaces, notify, run } from "herdr";
import { me, list, mentioned, hasGhStack, TRANSIENT, view, files, commits, commitFiles, haystack, words, matches, ago, hash, slug, GROUPS } from "./data.js";
import { fileKey, FIRST_LINES, MORE_LINES } from "./diff.js";
import { highlightFiles } from "./highlight.js";
import { stacks, stackOf, stackAgent, agentMode } from "./stacks.js";
import { detail, prepare } from "./detail.js";
import { call } from "./jira-client.js";
import { kit, PAGE_WIDE } from "./page-kit.js";
import { LinkDialog } from "./link-dialog.js";
import { AgentDialog, PromptsDialog } from "./agent-dialog.js";
import { REFRESH_ICON } from "./links.js";
import { context, activeSpace, openLinkDialog, openSettings, settingsMenu, OPENS, PAGE, asSplit, pageMode, openPageDialog, pageDialog, splitView, drawn, openAgentDialog, writeIcons, icon, issueKind as issueKindOf, kindColor, avatar, segmented, fs, readSizes, openUrl, agentSpaces, agentChip, mostUrgent, liveAgent, AGENT_STATUS, goToSpace, migrateSettings, loadAvatars, avatarPics } from "./links.js";

const SPINNER = "mods/workspace-chrome/spinner.svg", COG = "mods/workspace-chrome/settings.svg";
const WEEK = 7 * 24 * 3600 * 1000, WIDE = 720, ROOMY = 520, PAGES = 30;
// Lines of diff the Files tab opens by itself, and what Expand all opens at most.
const OPEN_LINES = 800, ALL_LINES = 2500;
const savedDiffMode = () => { try { return localStorage.getItem("diff-mode") === "split" ? "split" : "unified"; } catch { return "unified"; } };

// The last list per space, so switching back shows it at once while it refreshes.
const remembered = (space) => { try { return JSON.parse(localStorage.getItem(`space:${space}`) ?? "null"); } catch { return null; } };
const remember = (space, v) => { try { localStorage.setItem(`space:${space}`, JSON.stringify(v)); } catch { /* best effort */ } };
// The width this list had last time in the same place (panel, tab or window): the first
// render uses it, so the list doesn't draw narrow and then jump to wide once it's measured.
const place = () => (props()?.overlay ? "window" : props()?.space ? "tab" : "panel");
const lastWidth = () => { try { return Number(localStorage.getItem(`width:${place()}`)) || 0; } catch { return 0; } };
const keepWidth = (w) => { try { localStorage.setItem(`width:${place()}`, String(w)); } catch { /* best effort */ } };
// The list's space and every link: either changing means another repository.
const contextKey = (space) => `${space?.id}|${JSON.stringify(shared("space-links") ?? {})}`;
// What a space's list keeps in memory (the last SPACES spaces), so switching back shows it at once.
const SPACES = 20;
const KEPT = ["where", "login", "prs", "data", "hay", "stacks", "inStack", "saved", "meta", "version", "cache", "error", "unlinked", "cursor"];

// What a row draws, worked out once per load: the row renderer runs inside layout, twice
// for every frame Herdr draws (hover, scrolling, any spinner on screen), so it only reads.
// Pills are [text, theme color] pairs.
// Where an open pull request is in review, as one pill: a draft, waiting for a review, or the verdict.
// The same on every row, so a stack's layers say for themselves which one holds the stack up.
const REVIEW = { APPROVED: ["approved", "ansi2"], CHANGES_REQUESTED: ["changes", "ansi1"] };
function rowData(pr) {
  const c = pr.checks, pills = [];
  if (pr.state === "OPEN") pills.push(pr.isDraft ? ["draft", "muted"] : REVIEW[pr.reviewDecision] ?? ["needs review", "ansi3"]);
  // The checks as one icon and a count: failing first, then running, then passing.
  const checks = c.fail > 0 ? ["x", c.fail] : c.pending > 0 ? ["pending", c.pending] : c.pass > 0 ? ["check", c.pass] : null;
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "pr";
  return {
    number: pr.number, label: `#${pr.number}`, title: pr.title, draft: pr.isDraft, pills, checks, state, branch: pr.headRefName,
    author: pr.author?.login ?? "", adds: `+${pr.additions}`, dels: `−${pr.deletions}`, updated: pr.updatedAt, age: ago(pr.updatedAt),
  };
}

export default class PullRequests extends View {
  init(_props, cx) {
    migrateSettings("herdr-ranch-prs");
    if (props()?.settings) return; // the cog's popup: only settingsMenu
    // Opened as one of its dialogs (Link space, Start agent): only that dialog.
    const dialog = props()?.dialog;
    if (dialog === "page") return this.pageOnly(props(), cx);
    if (dialog) { this.dialog = cx.new(dialog === "link" ? LinkDialog : dialog === "prompts" ? PromptsDialog : AgentDialog, props()); return; }
    this.prs = []; this.login = null; this.error = null; this.loading = false;
    this.query = ""; this.filter = null; this.mentions = null; this.mentionsVersion = 0; this.open = null; this.page = null; this.pageError = null; this.width = lastWidth(); this.version = 0;
    this.gen = 0; this.data = new Map(); this.hay = new Map(); this.stacks = []; this.inStack = new Map(); this.collapsed = new Set(); this.saved = null; this.versions = 0; this.kept = new Map();
    this.diffMode = savedDiffMode();
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { await writeIcons(); cx.notify(); });
    // The open pull request's page is a view of its own: a live change redraws the list only,
    // and a page that loads redraws the page only (one long render was cut off).
    this.pageView = drawn(cx, () => (this.open != null ? this.safeDetail(theme()) : div()));
    // The highlight shows only while the keys move it: a clicked row isn't left marked.
    this.keys = false;
    // Loaded pages by repository and number (the last PAGES), so opening one again is instant.
    this.pages = new Map();
    this.watch(cx);

    // Key commands from keys.json ("herdr-ranch-prs.down"), also reachable with `herdr-app do`.
    cx.spawn(async (cx) => { try { for (;;) this.command(await nextCommand(), cx); } catch { /* the copy is closing */ } });
  }

  // Opened as a page dialog: one pull request of `p.prs` (the list's, in its order), stepped
  // with Up/Down. No list, timers or commands here: the list's copy keeps those.
  pageOnly(p, cx) {
    this.prs = p.prs ?? []; this.where = p.where ?? null; this.login = p.login ?? null; this.pages = new Map(); this.page = null; this.pageError = null; this.pageW = 900;
    for (const l of p.avatars ?? []) avatarPics.add(l);
    this.only = { at: Math.max(0, this.prs.findIndex((x) => x.number === p.number)) }; this.tab = p.tab ?? "conversation"; this.diffMode = savedDiffMode();
    this.handle = cx.focus_handle();
    // Focus can't move inside a render, so right after: Up/Down then reach the dialog.
    cx.timer.after(0, () => { try { this.handle.focus(); } catch { /* the pointer still works */ } });
    this.pageView = drawn(cx, () => (this.open != null ? this.safeDetail(theme()) : div()));
    if (!this.where || !this.prs.length) return;
    if (p.page) this.pages.set(`${this.where.github}#${p.number}`, p.page);
    this.show1(this.prs[this.only.at].number, cx);
  }

  show1(number, cx) {
    this.open = number; this.picked = this.prs.find((x) => x.number === number);
    this.load(number, cx); cx.notify(this.pageView);
  }

  step(by, cx) {
    const at = Math.max(0, Math.min(this.prs.length - 1, this.only.at + by));
    if (at === this.only.at) return;
    this.only.at = at; this.show1(this.prs[at].number, cx);
  }

  // The list: loaded now, every minute, and when the shown space or its link changes.
  watch(cx) {
    // A list in a tab (props.space, from mod-buttons) shows its own space and does nothing
    // while that space isn't shown; the side panel's list follows the shown space.
    this.home = props()?.space ?? null;
    this.search = InputState.new({ placeholder: "Search pull requests" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(60000, (cx) => { if (this.visible()) this.refresh(cx); });
    // Following the link (a space switch is caught in render): a cheap check.
    cx.timer.every(1500, (cx) => { if (this.visible() && (this.stale || contextKey(this.space()) !== this.context)) this.refresh(cx); });
  }

  space() { return this.home ? spaces().find((s) => s.id === this.home) ?? null : activeSpace(); }
  visible() { return !this.home || Boolean(this.space()?.active); }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "back") this.back(cx);
    else if (this.open != null) return; // the rest act on the list, which a page covers
    else if (name === "down") this.move(1, cx);
    else if (name === "up") this.move(-1, cx);
    else if (name === "open") this.enter(cx);
    else if (name === "browser") { const pr = this.prs.find((p) => p.number === this.cursor); if (pr) openUrl(pr.url); }
    else if (name === "link") openLinkDialog("herdr-ranch-prs");
    else if (name === "close" && props()?.overlay) closeOverlay(props().overlay);
    // A page dialog that closes hands the keyboard back to the list (else it goes to a terminal).
    else if (name === "focus") { try { this.handle.focus(); } catch { /* not shown */ } }
  }

  // Each call supersedes a load still running (`gen`), so Refresh and a space switch never
  // wait for an old one; only the latest load's answer is kept.
  // Shows the list of `space` (its link: `key`) at once: kept in memory, else stored, else
  // empty while it loads. Never the list of the space shown before.
  show(space, key) {
    if (this.context) { this.kept.delete(this.context); this.kept.set(this.context, Object.fromEntries(KEPT.map((k) => [k, this[k]]))); }
    if (this.kept.size > SPACES) this.kept.delete(this.kept.keys().next().value);
    // A load still running for the space shown before must not land here.
    this.gen++; this.loading = false;
    this.context = key; this.spaceId = space?.id ?? null; this.stale = true;
    this.keys = false; this.open = null; this.picked = null; this.page = null; this.pageError = null;
    this.mentions = null; this.mentionsLoading = false; this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    const kept = this.kept.get(key);
    if (kept) { Object.assign(this, kept); return; }
    this.restore(space);
  }

  // The stored list of `space` (none: empty).
  restore(space) {
    const last = space && remembered(space.id);
    this.where = last?.where ?? null; this.login = last?.login ?? null; this.saved = null; this.meta = null;
    this.error = null; this.unlinked = false; this.cursor = null;
    this.setPrs(last?.prs ?? []);
  }

  refresh(cx) {
    const space = this.space(), key = contextKey(space);
    if (key !== this.context) this.show(space, key);
    this.stale = false;
    const gen = ++this.gen;
    if (!space) { this.loading = false; cx.notify(); return; }
    this.loading = true; cx.notify();
    const current = () => gen === this.gen;
    cx.spawn(async (cx) => {
      try {
        const c = await context(space);
        if (!current()) return;
        this.unlinked = !c.github;
        if (!c.github) throw new Error("No GitHub repository for this space.");
        const at = { cwd: c.repo?.main ?? (space.folder || undefined), on: space.machine ?? null, github: c.github, repo: c.repo, jira: c.link?.jira?.site ?? null, jiraKey: c.link?.jira?.key ?? null };
        const login = await me(at), prs = await list(at, login);
        if (!current()) return;
        this.where = at; this.login = login; this.error = null;
        // Stored when the list or where it comes from changed.
        const meta = JSON.stringify({ at, login });
        if (this.setPrs(prs) || meta !== this.meta) { this.meta = meta; remember(space.id, { where: at, login, prs }); }
        cx.spawn(async (cx) => { if (await loadAvatars(prs.map((p) => p.author?.login), prs[0]?.url)) try { cx.notify(); } catch { /* shown on the next change */ } });
        // Fix stack to merge needs the gh stack extension on this machine (asked once per machine).
        if (this.stacks.length) cx.spawn(async (cx) => { const has = await hasGhStack(at); if (current() && has !== this.ghStack) { this.ghStack = has; try { cx.notify(); } catch { /* shown on the next change */ } } });
        this.publishBadge(space);
        if (this.filter === "mentioned") this.loadMentions(cx);
      } catch (e) { if (current()) { this.error = String(e?.message ?? e); this.publishBadge(space, 0); } }
      finally { if (current()) { this.loading = false; cx.notify(); } }
    });
  }

  // The count on the PRs button (mod-buttons): reviews asked of you, per space
  // (shared("mod-badges")["herdr-ranch-prs"] = { [space id]: count }). The panel's list and a tab's
  // list write their own space; a window doesn't. Only on change; 0 when it can't tell.
  publishBadge(space, count = this.prs.filter((p) => p.group === "review").length) {
    if (props()?.overlay || !space || (this.home && !this.visible())) return;
    const all = shared("mod-badges") ?? {};
    const mine = typeof all["herdr-ranch-prs"] === "object" && !("count" in (all["herdr-ranch-prs"] ?? {})) ? all["herdr-ranch-prs"] : {};
    if ((mine[space.id] ?? 0) === count) return;
    const next = { ...mine, [space.id]: count };
    if (!count) delete next[space.id];
    setShared("mod-badges", { ...all, "herdr-ranch-prs": next });
  }

  // The numbers for Mentioned (`mentions:@me`), fetched when that filter is picked and
  // again on each refresh while it stays picked.
  // Mentions have a sequence of their own (`mentionsSeq`): a refresh that bumps `gen` while one
  // loads must not leave mentionsLoading stuck on. The numbers land only on the space they were for.
  loadMentions(cx) {
    const context = this.context, where = this.where;
    if (!where) return;
    const seq = this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    this.mentionsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const numbers = await mentioned(where);
        if (seq === this.mentionsSeq && context === this.context) { this.mentions = new Set(numbers); this.mentionsVersion++; }
      } catch (e) { if (seq === this.mentionsSeq && context === this.context) this.error = String(e?.message ?? e); }
      finally { if (seq === this.mentionsSeq) { this.mentionsLoading = false; cx.notify(); } }
    });
  }

  // The filters, like GitHub's: Assigned to me, Created by me, Mentioned, Review requests
  // (asked of me directly), Recent activity (updated in the last 7 days) and Pushed (open, with a
  // commit in the last 7 days). None: all.
  keep(p) {
    const me = this.login;
    if (this.filter === "created") return p.author?.login === me;
    if (this.filter === "assigned") return (p.assignees ?? []).includes(me);
    if (this.filter === "mentioned") return Boolean(this.mentions?.has(p.number));
    if (this.filter === "review") return (p.reviewRequests ?? []).some((r) => r.login === me);
    if (this.filter === "recent") return Date.parse(p.updatedAt) > Date.now() - WEEK;
    if (this.filter === "pushed") return p.state === "OPEN" && Date.parse(p.pushedAt) > Date.now() - WEEK;
    return true;
  }

  // New pull requests replace the list only when they differ: an unchanged refresh just
  // updates the ages, so the list isn't regrouped, stored or redrawn for nothing.
  setPrs(prs) {
    const saved = JSON.stringify(prs);
    if (saved === this.saved) {
      for (const d of this.data.values()) d.age = ago(d.updated);
      return false;
    }
    this.saved = saved; this.prs = prs; this.version = ++this.versions;
    this.data = new Map(prs.map((p) => [p.number, rowData(p)]));
    this.hay = new Map(prs.map((p) => [p.number, haystack(p)]));
    this.stacks = stacks(prs); this.inStack = stackOf(this.stacks);
    return true;
  }

  // A page from the cache shows at once and is fetched again behind it.
  // The answer counts only while the same pull request of the same repository is open.
  load(number, cx) {
    const where = this.where, still = () => this.open === number && this.where?.github === where.github;
    this.page = this.pages.get(`${where.github}#${number}`) ?? null; this.pageError = null;
    if (this.page && this.tab !== "conversation" && this.tab !== "checks") this.pickTab(this.tab, cx);
    cx.spawn(async (cx) => {
      try {
        const page = await this.fetchPage(number, where);
        if (still()) { this.page = page; this.pageError = null; if (this.tab === "files" || this.tab === "commits") this.pickTab(this.tab, cx); }
        const people = [page.author?.login, ...page.conversation.map((c) => c.who), ...(page.reviewers ?? []).map((r) => r.login), ...(page.assignees ?? [])];
        cx.spawn(async (cx) => { if (await loadAvatars(people, page.url)) try { cx.notify(this.pageView); } catch { /* shown on the next change */ } });
      } catch (e) { if (still() && !this.page) this.pageError = String(e?.message ?? e); }
      cx.notify(this.pageView);
    });
  }

  async fetchPage(number, where = this.where) {
    const key = `${where.github}#${number}`, page = prepare(await view(number, where));
    // Jira keys the pull request names: their summary and type, when the space links a Jira site.
    const keys = where.jiraKey ? page.keys.filter((k) => k.startsWith(`${where.jiraKey}-`)) : [];
    if (where.jira && keys.length) {
      page.jiraIssues = {};
      await Promise.all(keys.map(async (k) => {
        const j = await call(where.jira, `/rest/api/3/issue/${encodeURIComponent(k)}?fields=summary,status,issuetype`).catch(() => null);
        if (j) page.jiraIssues[k] = { summary: j.fields?.summary ?? "", kind: issueKindOf(j.fields?.issuetype?.name), done: j.fields?.status?.statusCategory?.key === "done" };
      }));
    }
    this.pages.delete(key); this.pages.set(key, page);
    if (this.pages.size > PAGES) this.pages.delete(this.pages.keys().next().value);
    return page;
  }

  // The page of the pull request the highlight or the pointer rests on, fetched after 300 ms there.
  prefetch(number, cx) {
    if (!this.where || this.pages.has(`${this.where.github}#${number}`)) return;
    cx.spawn(async (cx) => {
      await cx.sleep(300);
      if ((this.cursor === number || this.hovered === number) && this.open == null && !this.pages.has(`${this.where.github}#${number}`)) await this.fetchPage(number).catch(() => null);
    });
  }

  // A pull request's page takes the list's place; the list keeps its search and highlight.
  pick(number, cx) {
    if (!this.where) return;
    this.cursor = number; this.keys = false;
    // Overlay: the page opens in a dialog of its own, with what the list already has.
    if (pageMode("herdr-ranch-prs") === "overlay") {
      const flat = this.items().flat;
      openPageDialog("herdr-ranch-prs", { number, prs: flat.length ? flat : this.prs, where: this.where, login: this.login, avatars: [...avatarPics], tab: this.tab, page: this.pages.get(`${this.where.github}#${number}`) ?? null });
      cx.notify(); return;
    }
    this.open = number;
    this.picked = this.prs.find((p) => p.number === number) ?? { number, title: "", state: "OPEN", url: `https://github.com/${this.where.github}/pull/${number}` };
    this.load(number, cx); cx.notify(this.pageView); cx.notify();
  }
  // The list shows where it was; fresh data loads behind it.
  back(cx) {
    this.open = null; this.page = null; this.pageError = null;
    this.handle.focus(); this.refresh(cx); cx.notify(this.pageView); cx.notify();
  }

  // The list as one run of items (group headings and rows), kept until the data, search or
  // Mine changes: Herdr re-renders every mod on any live
  // change (agents, focus), so a render must stay cheap.
  items() {
    const branch = this.space()?.branch ?? "";
    const k = `${this.version}|${this.query}|${this.filter}|${this.mentionsVersion}|${branch}|${[...this.collapsed].join(",")}`;
    if (this.cache?.k !== k) {
      const ws = words(this.query);
      const shown = this.prs.filter((p) => matches(this.hay.get(p.number), ws) && this.keep(p));
      const passing = new Set(shown.map((p) => p.number)), byNumber = new Map(this.prs.map((p) => [p.number, p]));
      // Pushed: one list, the latest push first, each row aged by its push; no groups or stacks.
      if (this.filter === "pushed") {
        const sorted = [...shown].sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
        const items = sorted.length ? [{ key: "group-pushed", group: { label: "Recently pushed", count: String(sorted.length) } },
          ...sorted.map((pr) => ({ key: `pr-${pr.number}`, data: { ...this.data.get(pr.number), age: ago(pr.pushedAt) } }))] : [];
        this.cache = { k, items, flat: sorted };
        return this.cache;
      }
      // A stack shows whole when any layer passes the search and filter (the others dimmed),
      // as one row in the group of its least ready layer; its layers aren't loose rows.
      const stacks = this.stacks.filter((s) => s.layers.some((l) => passing.has(l.number)));
      const loose = shown.filter((p) => !this.inStack.has(p.number));
      const groups = GROUPS.map(([id, label]) => ({ id, label, stacks: stacks.filter((s) => s.group === id), prs: loose.filter((p) => p.group === id) }))
        .filter((g) => g.stacks.length || g.prs.length);
      const layers = (s) => (this.folded(s) ? [] : s.layers.map((l, n) => ({ key: `pr-${l.number}`, data: this.data.get(l.number), level: n + 1, dim: !passing.has(l.number) })));
      // The pull request of the shown branch, pinned on top (it stays in its own group too).
      // Only a branch of this repository (a fork's "main" isn't yours), and only when it passes the search and filter.
      const mine = branch && shown.find((p) => p.headRefName === branch && p.state === "OPEN" && !p.fork);
      const items = [...(mine ? [{ key: "group-here", group: { label: "This branch", count: "1" } }, { key: `here-${mine.number}`, data: this.data.get(mine.number) }] : []), ...groups.flatMap((g) => [
        { key: `group-${g.id}`, group: { label: g.label, count: String(g.stacks.length + g.prs.length) } },
        ...g.stacks.flatMap((s) => [{ key: s.key, stack: s, open: !this.folded(s) }, ...layers(s)]),
        ...g.prs.map((pr) => ({ key: `pr-${pr.number}`, data: this.data.get(pr.number) })),
      ])];
      // Up and Down step through the rows in order: loose pull requests and the layers of open stacks.
      this.cache = { k, items, flat: items.filter((i) => i.data && i.key.startsWith("pr-")).map((i) => byNumber.get(i.data.number)) };
    }
    return this.cache;
  }

  move(step, cx) {
    const flat = this.items().flat;
    if (!flat.length) return;
    const i = flat.findIndex((p) => p.number === this.cursor);
    // The keys move the highlight and Enter opens the page.
    this.cursor = flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? 0 : i + step))].number; this.keys = true;
    this.prefetch(this.cursor, cx);
    cx.notify();
  }

  enter(cx) { if (this.cursor != null) { this.pick(this.cursor, cx); this.keys = true; } }

  review(pr) {
    // From a page dialog: the agent's dialog takes its place.
    if (this.only) closeOverlay(props().overlay);
    const tail = `${pr.number}-${slug(pr.title)}-${hash(`github-pr-${pr.url}`)}`;
    const failing = (pr.statusCheckRollup ?? []).filter((c) => c.state === "fail").map((c) => c.name);
    openAgentDialog("herdr-ranch-prs", {
      kind: "pr", mode: agentMode(pr, this.login), repo: this.where.repo.main, on: this.where.on, key: `#${pr.number}`, title: pr.title, fork: Boolean(pr.isCrossRepository),
      icon: pr.state === "MERGED" ? "merged" : pr.isDraft ? "draft" : "pr",
      vars: { number: pr.number, title: pr.title, url: pr.url, head: pr.headRefName ?? "", base: pr.baseRefName ?? "", body: pr.body ?? "", failing: failing.join(", ") || "none", repo: this.where.github },
      branches: { review: `agent/review-${tail}`, comments: `agent/fix-${tail}`, checks: `agent/checks-${tail}` },
      tabs: { review: `Review #${pr.number} ${pr.title}`.slice(0, 60), comments: `Fix #${pr.number} ${pr.title}`.slice(0, 60), checks: `Checks #${pr.number} ${pr.title}`.slice(0, 60) },
    });
  }

  // One agent on a whole stack: on fixing it when a layer is yours, else on reviewing it.
  // Fixing needs gh stack; without it the dialog has only the review, and a toast says how to get it.
  startStack(stack) {
    if (!this.where?.repo) return;
    const prs = new Map(this.prs.map((p) => [p.number, p])), mode = agentMode(stack, this.login, prs);
    if (mode === "stack-fix" && this.ghStack === false) notify({ title: "Fix stack to merge needs gh stack", body: "Install it with: gh extension install github/gh-stack", level: "info", timeout: 6000 });
    openAgentDialog("herdr-ranch-prs", {
      kind: "stack", mode, repo: this.where.repo.main, on: this.where.on, icon: "pr", fork: false, ghStack: this.ghStack !== false,
      ...stackAgent(stack, prs, this.where.github),
    });
  }

  // A new width counts once it has held for 200 ms: a panel that opens or a divider that
  // moves reports every width on the way, and each switch between the narrow and the wide
  // layout made the list jump.
  // While the keys move the highlight, the list shows the rows from just above it (a plain
  // list can't be scrolled from script, and a virtual list made hovering lag). With the mouse,
  // or when the highlight is near the top, the whole list shows and scrolls as usual.
  keyWindow(items, isCursor, rowH) {
    if (!this.keys) { this.winStart = 0; return [items, false]; }
    const at = items.findIndex(isCursor);
    if (at < 0) return [items, false];
    const visible = Math.max(4, Math.floor(((this.height ?? 600) - 150) / rowH));
    let start = this.winStart ?? 0;
    if (at < start + 1) start = Math.max(0, at - 1);
    if (at > start + visible - 2) start = at - visible + 2;
    this.winStart = start;
    return [start > 0 ? items.slice(start) : items, start > 0];
  }

  resized(w, cx) {
    this.nextWidth = w;
    if (this.settling) return;
    this.settling = true;
    const apply = (cx) => { this.settling = false; if (this.nextWidth !== this.width) { this.width = this.nextWidth; keepWidth(this.width); cx.notify(); if (this.open != null) cx.notify(this.pageView); } };
    try { cx.timer.after(200, apply); } catch { apply(cx); }
  }

  // Split: the list on top and the open pull request's page under it, in Herdr's own split.
  paged(inSplit, t, list) {
    return inSplit ? splitView("pr-page", list, this.pageView, this.open != null, (cx) => this.back(cx)) : list;
  }

  // The page's own keys (Up, Down and Esc are the dialog's or the list's): ⌘↵ Review with
  // agent, O open, B copy the branch, 1 2 3 the tabs.
  pageKey(e, cx) {
    const pr = this.page ?? this.picked, m = e.modifiers ?? {};
    if (this.open == null || !pr) return false;
    if (e.key === "enter" && m.platform) { const a = liveAgent(agentSpaces(this.where?.repo?.main).prs.get(pr.number)); if (a) this.go(a.id); else if (this.page && this.where?.repo && this.page.state === "OPEN") this.review(this.page); return true; }
    if (m.platform || m.control || m.alt) return false;
    if (e.key === "o") { openUrl(pr.url); return true; }
    if (e.key === "b") { this.copyBranch(cx); return true; }
    if (this.tab === "commits" && this.commitOpen()) {
      if (e.key === "[" || e.key === "]") { this.stepCommit(e.key === "[" ? -1 : 1, cx); return true; }
      if (e.key === "backspace") { this.pickCommit(null, cx); return true; }
    }
    if ((this.tab === "files" || (this.tab === "commits" && this.commitOpen())) && (e.key === "s" || e.key === "e")) {
      const d = this.diffProps();
      if (e.key === "s") d.setMode(d.mode === "split" ? "unified" : "split", cx);
      else if (d.files) d.all(!d.files.some((f) => d.isOpen(f.path)), cx);
      return true;
    }
    const tab = { 1: "conversation", 2: "checks", 3: "files", 4: "commits" }[e.key];
    if (tab) { this.pickTab(tab, cx); return true; }
    return false;
  }

  // Herdr calls this when the copy goes (only on this root view, never on the dialogs made with
  // cx.new). A page dialog or a Link space / Start agent / Prompts dialog (closed with Esc, × or a
  // click beside it) hands the keyboard back to the list, else keys would go to a terminal.
  async close() { if (this.only || this.dialog) run("herdr-ranch-prs.focus"); }

  // Goes to an agent's space; a page dialog closes first, so it doesn't cover that space.
  go(id) {
    if (this.only) closeOverlay(props().overlay);
    goToSpace(id);
  }

  pickTab(tab, cx) {
    this.tab = tab;
    if (tab === "files") this.loadDiffs(cx);
    if (tab === "commits") { this.loadCommits(cx); if (this.commitOpen()) this.loadDiffs(cx); }
    cx.notify(this.pageView);
  }

  // What the diff view shows now: the pull request's files (Files tab) or one commit's
  // (Commits tab, a commit open). `key` names its diffs, and with a path, a file's state.
  // Only once the page is in: its head commit keys what was marked viewed.
  diffScope() {
    const pr = this.page;
    if (!this.where || !pr || pr.number !== this.open) return null;
    this.diffs ??= new Map(); this.fileOpen ??= new Map(); this.fileLimit ??= new Map();
    const where = this.where, github = where.github, number = pr.number;
    if (this.tab === "commits") {
      const c = this.commitOpen();
      return c ? { key: `${github}@${c.sha}`, load: () => commitFiles(c.sha, where), url: `https://github.com/${github}/commit/${c.sha}`, viewed: false, git: this.localGit(`${c.sha}^`, c.sha) } : null;
    }
    return { key: fileKey(github, number, pr.headRefOid, ""), load: () => files(number, where), url: `${pr.url}/files`, viewed: true, git: this.localGit(pr.baseRefOid, pr.headRefOid) };
  }
  // Where the highlighter can read whole files: this computer's checkout of the repository (it
  // may lack the commits; the highlighter then works from the hunks).
  localGit(oldRev, newRev) {
    const repo = this.where?.repo;
    return repo?.main && !repo.on && oldRev && newRev ? { cwd: repo.main, oldRev, newRev } : null;
  }
  // Diffs load the first time they show (they can be large) and are kept, the last PAGES.
  loadDiffs(cx, again = false) {
    const s = this.diffScope();
    if (!s || (!again && this.diffs.has(s.key))) return;
    this.diffs.set(s.key, { files: null, error: null });
    cx.spawn(async (cx) => {
      let got;
      try { got = { files: await s.load(), error: null }; } catch (e) { got = { files: null, error: String(e?.message ?? e).split("\n")[0] }; }
      this.diffs.set(s.key, got);
      if (this.diffs.size > PAGES) this.diffs.delete(this.diffs.keys().next().value);
      // Open the first files, up to a budget of lines, and none marked viewed: the rest wait for a click.
      if (got.files) {
        let budget = OPEN_LINES;
        for (const f of got.files) {
          const k = `${s.key}${f.path}`;
          if (this.fileOpen.has(k)) continue;
          const open = !(s.viewed && this.isViewed(k)) && !f.why && Math.min(f.lines, FIRST_LINES) <= budget;
          if (open) budget -= Math.min(f.lines, FIRST_LINES);
          this.fileOpen.set(k, open);
        }
      }
      try { cx.notify(this.pageView); } catch { /* shown on the next change */ }
      // Then the colors, when the highlighter is installed: the diff shows plain until they come.
      if (got.files && await highlightFiles(got.files.filter((f) => !f.why), s.git).catch(() => false)) {
        try { cx.notify(this.pageView); } catch { /* shown on the next change */ }
      }
    });
  }
  isViewed(k) { try { return localStorage.getItem(`viewed:${k}`) === "1"; } catch { return false; } }
  diffProps() {
    const s = this.diffScope();
    const d = (s && this.diffs.get(s.key)) ?? { files: null, error: null };
    const loaded = d.files ?? [];
    const key = (p) => `${s?.key}${p}`;
    const redraw = (cx) => cx.notify(this.pageView);
    return {
      files: d.files, error: d.error, loading: !d.files && !d.error, mode: this.diffMode ?? "unified", viewed: Boolean(s?.viewed),
      github: s?.url ?? (this.page ?? this.picked)?.url ?? "", openUrl: (url) => openUrl(url),
      isOpen: (p) => Boolean(this.fileOpen?.get(key(p))),
      isViewed: (p) => Boolean(s?.viewed) && this.isViewed(key(p)),
      limit: (p) => this.fileLimit?.get(key(p)) ?? FIRST_LINES,
      toggle: (p, cx) => { const k = key(p); this.fileOpen.set(k, !this.fileOpen.get(k)); redraw(cx); },
      // Viewed folds the file away; unmarking it opens it again.
      view: (p, cx) => {
        const k = key(p), now = !this.isViewed(k);
        try { if (now) localStorage.setItem(`viewed:${k}`, "1"); else localStorage.removeItem(`viewed:${k}`); } catch { /* kept for this session only */ }
        this.fileOpen.set(k, !now); redraw(cx);
      },
      more: (p, cx) => { const k = key(p); this.fileLimit.set(k, (this.fileLimit.get(k) ?? FIRST_LINES) + MORE_LINES); redraw(cx); },
      setMode: (m, cx) => { this.diffMode = m; try { localStorage.setItem("diff-mode", m); } catch { /* this session only */ } redraw(cx); },
      // Expand all opens files with a diff up to a budget of lines, so one click can't draw thousands.
      all: (open, cx) => {
        let budget = ALL_LINES;
        for (const f of loaded) {
          const k = key(f.path), cost = Math.min(f.lines, this.fileLimit.get(k) ?? FIRST_LINES);
          const on = open && !f.why && cost <= budget;
          if (on) budget -= cost;
          this.fileOpen.set(k, on);
        }
        redraw(cx);
      },
      retry: (cx) => { this.loadDiffs(cx, true); redraw(cx); },
    };
  }

  // The Commits tab: the pull request's commits, loaded the first time the tab shows, kept per
  // head commit. `this.commit` is the open one's sha, for the pull request `this.commitFor`.
  commitsKey() { const pr = this.page; return pr && this.where && pr.number === this.open ? fileKey(this.where.github, pr.number, pr.headRefOid, "") : null; }
  loadCommits(cx, again = false) {
    const k = this.commitsKey();
    this.commitLists ??= new Map();
    if (!k || (!again && this.commitLists.has(k))) return;
    const where = this.where, number = this.page.number;
    this.commitLists.set(k, { list: null, total: 0, error: null });
    cx.spawn(async (cx) => {
      let got;
      try { got = { ...(await commits(number, where)), error: null }; } catch (e) { got = { list: null, total: 0, error: String(e?.message ?? e).split("\n")[0] }; }
      this.commitLists.set(k, got);
      if (this.commitLists.size > PAGES) this.commitLists.delete(this.commitLists.keys().next().value);
      try { cx.notify(this.pageView); } catch { /* shown on the next change */ }
    });
  }
  commitList() { const k = this.commitsKey(); return (k && this.commitLists?.get(k)) ?? { list: null, total: 0, error: null }; }
  commitOpen() {
    if (this.commitFor !== this.open || !this.commit) return null;
    return this.commitList().list?.find((c) => c.sha === this.commit) ?? null;
  }
  pickCommit(sha, cx) { this.commit = sha; this.commitFor = this.open; if (sha) this.loadDiffs(cx); cx.notify(this.pageView); }
  // [ and ]: the older or newer commit; at either end nothing moves.
  stepCommit(by, cx) {
    const list = this.commitList().list ?? [], at = list.findIndex((c) => c.sha === this.commitOpen()?.sha);
    const next = list[at + by];
    if (at >= 0 && next) this.pickCommit(next.sha, cx);
  }
  commitProps() {
    const c = this.commitList(), open = this.commitOpen(), list = c.list ?? [], at = open ? list.indexOf(open) : -1;
    const github = this.where?.github ?? "";
    return {
      list: c.list, total: c.total, error: c.error, open, at,
      pick: (sha, cx) => this.pickCommit(sha, cx), back: (cx) => this.pickCommit(null, cx), step: (by, cx) => this.stepCommit(by, cx),
      retry: (cx) => { this.loadCommits(cx, true); cx.notify(this.pageView); },
      copy: (sha, cx) => { cx.write_to_clipboard(sha); notify({ title: `Copied ${sha.slice(0, 7)}`, level: "success", timeout: 2000 }); },
      url: (sha) => `https://github.com/${github}/commit/${sha}`, openUrl: (url) => openUrl(url),
      diff: open ? this.diffProps() : null,
    };
  }

  copyBranch(cx) {
    const b = (this.page ?? this.picked)?.headRefName;
    if (!b) return;
    cx.write_to_clipboard(b); notify({ title: `Copied ${b}`, level: "success", timeout: 2000 });
  }

  safeDetail(t, page = this.page) {
    try {
      const k = kit(t), full = !this.only && pageMode("herdr-ranch-prs") === "full";
      const nav = this.only ? h_flex().gap(6).items_center().text_size(fs.meta).text_color(t.muted)
          .child(k.arrow("prev", "↑", (cx) => this.step(-1, cx), this.only.at > 0))
          .child(k.arrow("next", "↓", (cx) => this.step(1, cx), this.only.at < this.prs.length - 1))
          .child(`${this.only.at + 1} of ${this.prs.length}`)
        : full ? k.button("pr-back", "← Back", () => run("herdr-ranch-prs.back")) : null;
      const canReview = Boolean(page && this.where?.repo && page.state === "OPEN");
      const working = agentSpaces(this.where?.repo?.main).prs.get((page ?? this.picked)?.number) ?? [];
      return detail(page ?? { ...this.picked, loading: true }, t, {
        error: this.pageError, nav, login: this.login, agents: working, go: (id) => this.go(id), jiraKey: this.where?.jiraKey, github: this.where?.github, jira: this.where?.jira, jiraIssues: page?.jiraIssues,
        wide: (this.only ? this.pageW : this.width) >= PAGE_WIDE, tab: this.tab ?? "conversation", diff: this.diffProps(), commits: this.commitProps(),
        pickTab: (tab, cx) => this.pickTab(tab, cx), copyBranch: (cx) => this.copyBranch(cx), openUrl: (url) => openUrl(url),
        open: () => openUrl((this.page ?? this.picked).url),
        review: this.where?.repo ? () => this.review(this.page) : null,
        keys: [...(this.only || asSplit("herdr-ranch-prs") ? [[["↑", "↓"], "previous / next"]] : []), [["1", "2", "3", "4"], "tabs"], ...(this.tab === "files" || (this.tab === "commits" && this.commitOpen()) ? [[["S"], "unified / split"], [["E"], "expand / collapse all"]] : []),
          ...(this.tab === "commits" && this.commitOpen() ? [[["[", "]"], "older / newer"], [["⌫"], "all commits"]] : []),
          ...(liveAgent(working) ? [[["⌘", "↵"], "go to agent"]] : canReview ? [[["⌘", "↵"], "Agent review"]] : []), [["O"], "open on GitHub"], [["B"], "copy branch"], [["Esc"], this.only ? "close" : "back"]],
      });
    } catch (e) { return div().p(14).text_color(t.ansi1).child(`Cannot show this pull request: ${e?.stack ?? e}`); }
  }

  // One row from its row data and the styles `render` picked once (`s`). Built once per
  // render: hover is a style (no script runs on it), and only entering a row calls back,
  // to fetch its page ahead.
  // A stack's layer (`at`: { level, dim }) is indented once under its stack row, with its
  // place in the stack in front; a layer the search or filter doesn't match is dimmed.
  row(d, s, at = null) {
    const t = s.t, dim = Boolean(at?.dim);
    const status = (e) => e.children(d.pills.map(([text, color]) => div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(fs.tiny).text_color(t[color]).child(text)));
    const diff = h_flex().flex_none().gap(4).text_size(fs.meta).child(div().text_color(t.ansi2).child(d.adds)).child(div().text_color(t.ansi1).child(d.dels));
    const number = div().w(36).flex_none().text_color(dim ? t.muted : t.dim).text_size(fs.meta).child(d.label);
    const level = at?.level ? div().w(12).flex_none().text_size(fs.tiny).text_color(t.muted).child(String(at.level)) : null;
    const state = level ? h_flex().flex_none().gap(4).items_center().child(level).child(icon(d.state, kindColor(d.state, t))) : icon(d.state, kindColor(d.state, t));
    const checks = (e) => (d.checks ? e.child(h_flex().flex_none().gap(2).items_center().text_size(fs.meta).text_color(kindColor(d.checks[0], t))
      .child(icon(d.checks[0], kindColor(d.checks[0], t), 12)).child(String(d.checks[1]))) : e);
    const title = div().flex_1().min_w(0).truncate().text_color(d.draft || dim ? t.muted : t.foreground).child(d.title);
    const age = div().w(30).flex_none().text_right().text_size(fs.meta).text_color(t.dim).child(d.age);
    const agent = (e) => { const c = s.agents?.has(d.number) && agentChip(`agent-${d.number}`, s.agents.get(d.number), t); return c ? e.child(c) : e; };
    const base = (e) => e.flex_none().px(10).when(Boolean(at?.level), (e) => e.pl(24)).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .when(s.keys && s.cursor === d.number, (e) => e.bg(t.selected));
    // Narrow (the side panel): two lines, so the title keeps the whole width.
    if (s.two) return base(v_flex()).h(fs.row2).justify_center().gap(3)
      .child(h_flex().gap(8).items_center().child(state).child(number).child(title).child(age))
      .child(agent(status(checks(h_flex().pl(66).gap(6).items_center().text_size(fs.meta).child(avatar(d.author, t, 16))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(d.author)).child(diff)))));
    return base(h_flex()).h(fs.row).gap(8).items_center().child(state).child(number).child(title)
      .child(agent(status(h_flex().flex_none().gap(6).items_center())))
      .child(checks(h_flex().flex_none().w(34)))
      .child(div().w(70).flex_none().flex().justify_end().child(diff))
      .child(avatar(d.author, t))
      .child(age);
  }

  // A stack's own row: the chevron (collapses its layers), the stack icon, its name (the bottom
  // layer's title) and Agent review. The layers under it show their own status. The
  // actions always show: Herdr runs no script on hover, so they can't appear only then.
  stackRow(i, s) {
    // One button, as on a pull request's page; it needs this repository's main checkout.
    const t = s.t, st = i.stack, local = Boolean(this.where?.repo);
    const actions = div().id(`${st.key}-agent`).px(8).py(1).flex_none().rounded(6).text_size(fs.meta).border_1()
      .border_color(local ? t.ansi2 : t.border).text_color(local ? t.ansi2 : t.muted)
      .when(local, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => this.startStack(st)))
      .child("Agent review");
    const chevron = div().id(`${st.key}-toggle`).w(14).flex_none().cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.foreground))
      .on_click((_e, cx) => this.toggleStack(st, cx)).child(i.open ? "▾" : "▸");
    const pill = icon("stack", t.ansi4);
    const name = div().flex_1().min_w(0).truncate().font_semibold().child(st.name);
    const base = (e) => e.id(i.key).flex_none().px(10).rounded(6).bg(t.surface);
    return base(h_flex()).h(fs.row).gap(8).items_center().child(chevron).child(pill).child(name).child(actions);
  }

  // Collapsed stacks are kept per repository: stack numbers repeat across repositories.
  foldKey(stack) { return `${this.where?.github ?? ""}#${stack.key}`; }
  folded(stack) { return this.collapsed.has(this.foldKey(stack)); }
  toggleStack(stack, cx) {
    const key = this.foldKey(stack);
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    cx.notify();
  }

  // The open page shows its agents' status, but redraws only on its own: a status change
  // (seen here, on the live re-render) redraws it right after this render.
  watchAgents(cx, list) {
    const sig = JSON.stringify(list ?? []);
    if (sig === this.agentSig) return;
    this.agentSig = sig;
    try { cx.timer.after(0, (cx) => cx.notify(this.pageView)); } catch { /* shown on the next page change */ }
  }

  render(cx) {
    if (this.dialog) return this.dialog;
    readSizes();
    if (this.open != null) this.watchAgents(cx, agentSpaces(this.where?.repo?.main).prs.get(this.open));
    if (this.only) {
      // A page belongs to the space it was opened in: a space switch closes it.
      const now = activeSpace()?.id ?? null;
      if (this.onlySpace === undefined) this.onlySpace = now;
      else if (now !== this.onlySpace) { try { cx.timer.after(0, () => closeOverlay(props().overlay)); } catch { /* closes on the next change */ } }
      return pageDialog("pr-dialog", this.handle, this.pageView, { mod: "herdr-ranch-prs",
        step: (by, cx) => this.step(by, cx), key: (e, cx) => this.pageKey(e, cx),
        width: (w, cx) => { const was = this.pageW >= PAGE_WIDE; this.pageW = w; if (was !== (w >= PAGE_WIDE)) cx.notify(this.pageView); },
      });
    }
    if (props()?.settings) return settingsMenu("herdr-ranch-prs", [OPENS, PAGE]);
    // A space switch shows that space's list in this very render, and loads it right after.
    const space = this.space();
    if ((space?.id ?? null) !== this.spaceId) {
      this.show(space, contextKey(space));
      try { cx.timer.after(0, (cx) => { if (this.stale) this.refresh(cx); }); } catch { /* the 1.5 s check loads it */ }
    }
    // Split or Full changes the page's Back button.
    const asSplitNow = asSplit("herdr-ranch-prs");
    if (asSplitNow !== this.wasSplit) {
      this.wasSplit = asSplitNow;
      if (this.open != null) try { cx.timer.after(0, (cx) => cx.notify(this.pageView)); } catch { /* shown on the next page change */ }
    }
    const t = theme(), overlay = props()?.overlay;
    const { items } = this.items(), wide = this.width >= WIDE;
    const toggle = (id, label, on, flip) => div().id(id).px(8).py(2).flex_none().rounded(6).cursor_pointer().text_size(fs.meta)
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { flip(cx); cx.notify(); }).child(label);
    const empty = this.error || (this.loading ? "Loading pull requests…" : this.prs.length ? (this.filter === "mentioned" && this.mentionsLoading ? "Loading…" : "Nothing matches.") : "No open pull requests.");
    const filters = h_flex().child(segmented("filter", [["assigned", "Assigned"], ["created", "Created"], ["mentioned", "Mentioned"], ["review", "Review requests"], ["recent", "Recent"], ["pushed", "Pushed"]], this.filter, (id, cx) => {
      this.filter = id;
      if (this.filter === "mentioned" && !this.mentions && !this.mentionsLoading) this.loadMentions(cx);
    }, t));
    const heading = (g) => h_flex().h(fs.head).flex_none().px(10).gap(6).items_end().text_size(fs.meta).text_color(t.dim)
      .child(div().font_semibold().child(g.label)).child(div().child(g.count));
    const s = { t, two: this.width < ROOMY, keys: this.keys, cursor: this.cursor, agents: agentSpaces(this.where?.repo?.main).prs };
    // A plain list, built once per render. A virtual list calls its row builder for every
    // frame drawn (hovering included), which made hovering lag; this one runs no script
    // between renders.
    const [shownItems, windowed] = this.keyWindow(items, (i) => i.data?.number === this.cursor, s.two ? fs.row2 : fs.row);
    const list = v_flex().w_full().flex_1().min_h(0)
      .when(items.length > 0, (e) => e.child(v_flex().id(windowed ? "pr-list-keys" : "pr-list").w_full().flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .children(shownItems.map((i) => (i.group ? heading(i.group) : i.stack ? this.stackRow(i, s) : this.row(i.data, s, i.level ? i : null).id(i.key)
          .on_click((_e, cx) => { this.handle.focus(); this.pick(i.data.number, cx); })
          .on_hover((on, cx) => {
            const n = i.data.number;
            if (!on) { if (this.hovered === n) this.hovered = null; return; }
            this.hovered = n; this.prefetch(n, cx);
          }))))))
      .when(!items.length, (e) => e.child(v_flex().p(12).gap(8).items_start()
        .child(div().text_color(this.error ? t.ansi1 : t.dim).child(empty))
        .when(this.unlinked, (e) => e.child(toggle("link-empty", "Link this space", false, () => openLinkDialog("herdr-ranch-prs"))))));
    // Refresh (Herdr's spinner while loading) and the cog for the settings: Herdr's own icons,
    // since svg() can't read icons from a linked mod folder.
    const iconButton = (id, glyph, click) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(glyph);
    const search = div().min_w(0).px(8).py(3).rounded(6).border_1().border_color(t.input).text_size(fs.meta).child(Input.new(this.search));
    const close = div().id("close").px(6).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click(() => closeOverlay(overlay)).child("×");
    const inSplit = asSplit("herdr-ranch-prs"), full = pageMode("herdr-ranch-prs") === "full";
    return v_flex().id("herdr-ranch-prs").relative().overflow_hidden().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fs.body)
      .on_size_change((size, cx) => { this.height = size.height; this.resized(Math.round(size.width), cx); })
      .track_focus(this.handle)
      .on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* best effort */ } })
      .on_key_down((e, cx) => {
        // In a split Up and Down step through the pull requests, the page following along.
        if (this.open != null && inSplit && (e.key === "down" || e.key === "up")) { this.move(e.key === "down" ? 1 : -1, cx); this.pick(this.cursor, cx); this.keys = true; }
        else if (this.open) { if (e.key === "escape") this.back(cx); else if (!this.pageKey(e, cx)) return; }
        else if (e.key === "down") this.move(1, cx);
        else if (e.key === "up") this.move(-1, cx);
        else if (e.key === "enter") this.enter(cx);
        else if (e.key === "escape" && overlay) closeOverlay(overlay);
        else return;
        cx.stop_propagation();
      })
      .when(this.open != null && full, (e) => e.child(this.pageView))
      .when(this.open == null || !full, (e) => e.child(this.paged(inSplit, t, v_flex().flex_1().min_h(0).w_full()
      .child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_semibold().child("Pull requests"))
          .child(div().flex_1().min_w(0).text_size(fs.meta).text_color(t.dim).truncate().child(this.loading && this.prs.length ? `${this.where?.github ?? ""} · Refreshing…` : this.where?.github ?? ""))
          .when(wide, (e) => e.child(search.w(220)))
          .child(iconButton("refresh", this.loading ? svg(SPINNER).size(14).spin(900) : svg(REFRESH_ICON).size(13), (cx) => this.refresh(cx)))
          .child(iconButton("settings", svg(COG).size(14), () => openSettings("herdr-ranch-prs")))
          .when(Boolean(overlay), (e) => e.child(close)))
        .when(!wide, (e) => e.child(search.w_full()))
        .child(filters))
      // Over a list already shown, a GitHub hiccup (5xx) is a quiet note: the list stays and the next minute retries.
      .when(Boolean(this.error && this.prs.length), (e) => e.child(TRANSIENT.test(this.error)
        ? div().px(14).py(4).text_size(fs.meta).text_color(t.dim).child("GitHub didn't answer in time. Showing the last list; it tries again in a minute (↻ now).")
        : div().px(14).py(4).text_size(fs.meta).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_1().min_h(0).child(list))
      .child(kit(t).footer([[["↑", "↓"], "move"], [["↵"], "open"], ...(overlay ? [[["Esc"], "close"]] : [])])))));
  }
}
