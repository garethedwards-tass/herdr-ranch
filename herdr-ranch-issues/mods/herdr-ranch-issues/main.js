// The shown space's issues, from Jira Cloud or GitHub, grouped by priority or in backlog order
// (the `order` setting, chosen with the cog in its header), with a page per issue and "Start agent".
// Read only: nothing is written to Jira or GitHub.
// The source: the space's link (Link space; `issues: "github"` picks GitHub, else its Jira
// project), else `.herdr/jira.toml` in its repository, else a Jira guess (the key in the
// branch name or recent commits, on a site another space links to), else the space's
// GitHub repository.
// A selected issue's page takes the list's place; Back (or Esc) shows the list again.
// Linked (xref.js): History and Pull requests open an issue here by its key; its page lists the
// commits that name it (opening in History) and its pull requests open in Pull requests.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, exec, nextCommand, shared, spaces, notify, run } from "herdr";
import { fileLinks, suggestKey, search, issue, myself, watched } from "./jira.js";
import { TOKEN_PAGE, STORE, platform } from "./jira-client.js";
import * as github from "./github.js";
import * as linear from "./linear.js";
import { rows, haystack, words, matches, ago, hash, slug } from "./rows.js";
import { adfToMarkdown } from "./adf.js";
import { kit, pageLayout, PAGE_WIDE } from "./page-kit.js";
import { checkForUpdate } from "./update.js";
import { MODS, openIn, takeOpen, commitsMentioning, repoOfUrl, sameRepo } from "./xref.js";
import { LinkDialog } from "./link-dialog.js";
import { AgentDialog, PromptsDialog } from "./agent-dialog.js";
import { context, activeSpace, knownSites, openLinkDialog, pref, openSettings, settingsMenu, OPENS, PAGE, asSplit, pageMode, openPageDialog, pageDialog, splitView, drawn, openAgentDialog, writeIcons, icon, issueKind, kindColor, avatar, segmented, fs, readSizes, openUrl, agentSpaces, agentChip, mostUrgent, liveAgent, AGENT_STATUS, goToSpace, migrateSettings, imagesAsLinks } from "./links.js";

const SPINNER = "mods/workspace-chrome/spinner.svg", COG = "mods/workspace-chrome/settings.svg";
const WEEK = 7 * 24 * 3600 * 1000, WIDE = 720, ROOMY = 520, PAGES = 30, COMMENTS = 10, SHOWN = 300;
const browse = (i) => i.url ?? `https://${i.site}/browse/${i.key}`;
const isGithub = (x) => x?.provider === "github";
const isLinear = (x) => x?.provider === "linear";
const where = (repo, p) => ({ cwd: repo?.main, on: repo?.on, github: p.repo });
// Jira descriptions and comments are ADF, GitHub's are Markdown already.
const text = (body) => (typeof body === "string" ? body : adfToMarkdown(body));
const home = (i) => (isGithub(i) ? "GitHub" : isLinear(i) ? "Linear" : "Jira");
// The settings in the header's cog: where the button opens it, and the list's order.
const ORDER = { key: "order", label: "Order", choices: [["priority", "By priority"], ["backlog", "Backlog order"]], fallback: "priority" };
const split = () => asSplit("herdr-ranch-issues");
const order = () => (pref("herdr-ranch-issues", "order") === "backlog" ? "backlog" : "priority");
// The list's space and every link: either changing means another project.
const contextKey = (space) => `${space?.id}|${order()}|${JSON.stringify(shared("space-links") ?? {})}`;
// The last list per space and order, so a switch or a restart shows it at once while it refreshes.
const remembered = (key) => { try { return JSON.parse(localStorage.getItem(`issues:${key}`) ?? "null"); } catch { return null; } };
const remember = (key, v) => { try { localStorage.setItem(`issues:${key}`, JSON.stringify(v)); } catch { /* best effort */ } };
// The width this list had last time in the same place (panel, tab or window): the first
// render uses it, so the list doesn't draw narrow and then jump to wide once it's measured.
const place = () => (props()?.overlay ? "window" : props()?.space ? "tab" : "panel");
const lastWidth = () => { try { return Number(localStorage.getItem(`width:${place()}`)) || 0; } catch { return 0; } };
const keepWidth = (w) => { try { localStorage.setItem(`width:${place()}`, String(w)); } catch { /* best effort */ } };
// Pages are cached by site, repository and key: `#12` exists in every GitHub repository.
const pageKey = (i) => `${i.site}|${i.repo ?? ""}|${i.key}`;
// What a space's list keeps in memory (the last SPACES spaces), so switching back shows it at once.
const SPACES = 20;
const KEPT = ["repo", "github", "projects", "from", "capped", "issues", "data", "hay", "saved", "meta", "version", "cache", "error", "signIn", "cursor"];

// What a row draws, worked out once per load: the row renderer runs inside layout, twice
// for every frame Herdr draws (hover, scrolling, any spinner on screen), so it only reads.
const rowData = (i) => ({
  key: i.key, title: i.fields.summary, status: i.fields.status?.name ?? "", blocked: i.blocked,
  active: i.fields.status?.statusCategory?.key === "indeterminate", assignee: i.fields.assignee?.displayName ?? null,
  kind: issueKind(i.fields.issuetype?.name, i.fields.labels ?? []),
  updated: i.fields.updated, age: ago(i.fields.updated),
});

// Markdown is laid out again on every render, and a long text takes the render past the
// app's time limit ("interrupted"), so pages show the start and link to the rest.
const MAX = 2000;
const short = (text) => {
  const t = imagesAsLinks(text?.trim() ?? "");
  if (t.length <= MAX) return t;
  const cut = t.lastIndexOf("\n", MAX);
  return `${t.slice(0, cut > MAX / 2 ? cut : MAX)}\n\n_… the rest is online._`;
};

// Where the space's projects come from, in order; `from` says which.
async function projects(c) {
  const gh = c.github && { provider: "github", repo: c.github, site: github.SITE, key: c.github, filter: c.link.issuesFilter };
  if (c.link.issues === "github" && gh) return { from: "link", projects: [gh] };
  if (c.link.issues === "linear" && c.link.linear?.teamId) return { from: "link", projects: [{ provider: "linear", site: linear.SITE, ...c.link.linear }] };
  if (c.link.jira) return { from: "link", projects: [c.link.jira] };
  if (!c.repo) return { from: gh ? "repo" : null, projects: gh ? [gh] : [] };
  const file = await fileLinks(c.repo);
  if (file.length) return { from: "file", projects: file };
  const key = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/.exec(c.space.branch ?? "")?.[1] || await suggestKey(c.repo).catch(() => "");
  const site = knownSites()[0];
  if (key && site) return { from: "guess", projects: [{ site, key }] };
  return gh ? { from: "repo", projects: [gh] } : { from: null, projects: [] };
}

export default class SpaceIssues extends View {
  init(_props, cx) {
    migrateSettings("herdr-ranch-issues");
    if (props()?.settings) return; // the cog's popup: only settingsMenu
    // Opened as one of its dialogs (Link space, Start agent): only that dialog.
    const dialog = props()?.dialog;
    if (dialog === "page") return this.pageOnly(props(), cx);
    if (dialog) { this.dialog = cx.new(dialog === "link" ? LinkDialog : dialog === "prompts" ? PromptsDialog : AgentDialog, props()); return; }
    this.issues = []; this.projects = []; this.from = null; this.error = null; this.loading = false; this.capped = false;
    this.query = ""; this.filter = null; this.mentions = null; this.mentionsVersion = 0; this.me = {}; this.open = null; this.page = null; this.pageError = null;
    this.width = lastWidth(); this.cache = null; this.signIn = null; this.version = 0; this.gen = 0;
    this.data = new Map(); this.hay = new Map(); this.saved = null; this.versions = 0; this.kept = new Map();
    // The highlight shows only while the keys move it: a clicked row isn't left marked.
    this.keys = false;
    // Loaded pages (the last PAGES), so opening one again is instant.
    this.pages = new Map();
    // A request from History or Pull requests (xref.js): the last one handled, and one waiting for the list.
    this.xseen = null; this.pendingOpen = null;
    this.handle = cx.focus_handle();
    // The open issue's page is a view of its own: a live change redraws the list only,
    // and a page that loads redraws the page only (one long render was cut off).
    this.pageView = drawn(cx, () => (this.open ? this.detail(theme()) : div()));
    // A list in a tab (props.space, from mod-buttons) shows its own space and does nothing
    // while that space isn't shown; the side panel's list follows the shown space.
    this.home = props()?.space ?? null;
    this.search = InputState.new({ placeholder: "Search issues" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.refresh(cx);
    cx.spawn(async (cx) => { await writeIcons(); cx.notify(); });
    // Updates for the suite, once a day (update.js; only the side panel's list checks).
    if (!this.home && !props()?.overlay) { cx.spawn(async () => { await checkForUpdate(); }); cx.timer.every(3600 * 1000, () => { checkForUpdate(); }); }
    cx.timer.every(120000, (cx) => { if (this.visible()) this.refresh(cx); });
    // Following the link (a space switch is caught in render): a cheap check.
    cx.timer.every(1500, (cx) => { if (this.visible() && (this.stale || contextKey(this.space()) !== this.context)) this.refresh(cx); });
    // Key commands from keys.json ("herdr-ranch-issues.down"), also reachable with `herdr-app do`.
    cx.spawn(async (cx) => { try { for (;;) this.command(await nextCommand(), cx); } catch { /* the copy is closing */ } });
  }

  // Opened as a page dialog: one issue of `p.list` (the list's issues in its order), stepped
  // with Up/Down. No list, timers or commands here: the list's copy keeps those.
  pageOnly(p, cx) {
    this.only = { list: p.list ?? [], at: Math.max(0, (p.list ?? []).findIndex((i) => i.key === p.key)) };
    this.repo = p.repo ?? null; this.github = p.github ?? null; this.kidsMap = p.kids ?? {}; this.pageW = 900; this.pages = new Map(); this.open = null; this.page = null; this.pageError = null;
    this.handle = cx.focus_handle();
    // Focus can't move inside a render, so right after: Up/Down then reach the dialog.
    cx.timer.after(0, () => { try { this.handle.focus(); } catch { /* the pointer still works */ } });
    this.pageView = drawn(cx, () => (this.open ? this.detail(theme()) : div()));
    const i = this.only.list[this.only.at];
    if (!i) return;
    if (p.page) this.pages.set(pageKey(i), p.page);
    this.load(i, cx);
  }

  step(by, cx) {
    const at = Math.max(0, Math.min(this.only.list.length - 1, this.only.at + by));
    if (at === this.only.at) return;
    this.only.at = at; this.load(this.only.list[at], cx);
  }

  // Overlay: the page opens in a dialog of its own, with what the list already has.
  openPage(i) {
    const byKey = new Map(this.issues.map((x) => [x.key, x]));
    const shown = this.items().items.filter((x) => !x.group).map((x) => byKey.get(x.data.key)).filter(Boolean);
    // One the list doesn't show (asked for by another mod) opens alone.
    const list = shown.some((x) => x.key === i.key) ? shown : [i];
    const kids = {};
    for (const x of this.issues) if (x.fields.parent) (kids[x.fields.parent.key] ??= []).push({ key: x.key, summary: x.fields.summary, done: false });
    openPageDialog("herdr-ranch-issues", { key: i.key, list: list.length ? list : [i], repo: this.repo, github: this.github, kids, page: this.pages.get(pageKey(i)) ?? null });
  }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "back") this.back(cx);
    else if (this.open) return; // the rest act on the list, which a page covers
    else if (name === "down") this.move(1, cx);
    else if (name === "up") this.move(-1, cx);
    else if (name === "open") this.enter(cx);
    else if (name === "browser") { const i = this.issues.find((x) => x.key === this.cursor); if (i) openUrl(browse(i)); }
    else if (name === "link") openLinkDialog("herdr-ranch-issues");
    else if (name === "close" && props()?.overlay) closeOverlay(props().overlay);
    // A page dialog that closes hands the keyboard back to the list (else it goes to a terminal).
    else if (name === "focus") { try { this.handle.focus(); } catch { /* not shown */ } }
  }

  space() { return this.home ? spaces().find((s) => s.id === this.home) ?? null : activeSpace(); }
  visible() { return !this.home || Boolean(this.space()?.active); }

  // Each call supersedes a load still running (`gen`), so Refresh and a space switch never
  // wait for an old one; only the latest load's answer is kept.
  // Shows the list of `space` (its project and order: `key`) at once: kept in memory, else
  // stored, else empty while it loads. Never the list of the space shown before.
  show(space, key) {
    if (this.context) { this.kept.delete(this.context); this.kept.set(this.context, Object.fromEntries(KEPT.map((k) => [k, this[k]]))); }
    if (this.kept.size > SPACES) this.kept.delete(this.kept.keys().next().value);
    // A load still running for the space shown before must not land here.
    this.gen++; this.loading = false;
    this.context = key; this.spaceId = space?.id ?? null; this.stale = true;
    this.mentions = null; this.mentionsLoading = false; this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    this.error = null; this.signIn = null; this.keys = false; this.open = null; this.shown = null; this.page = null; this.pageError = null;
    const kept = this.kept.get(key);
    if (kept) { Object.assign(this, kept); return; }
    this.restore(space);
  }

  // The stored list of `space` (none: empty).
  restore(space) {
    const last = space && remembered(`${space.id}:${order()}`);
    this.repo = last?.repo ?? null; this.projects = last?.projects ?? []; this.from = last?.from ?? null;
    this.capped = last?.capped ?? false; this.saved = null; this.meta = null; this.cursor = null;
    this.setIssues(last?.issues ?? []);
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
        this.repo = c.repo; this.github = c.github;
        const linked = await projects(c);
        if (!current()) return;
        this.projects = linked.projects; this.from = linked.from;
        if (!linked.projects.length) { this.setIssues([]); this.error = null; return; }
        const results = await Promise.all(linked.projects.map(async (p) => {
          if (isGithub(p)) {
            this.me[p.site] ??= await github.me(where(c.repo, p));
            return github.search(p, where(c.repo, p));
          }
          if (isLinear(p)) {
            this.me[p.site] ??= await linear.me();
            return linear.search(p, order());
          }
          this.me[p.site] ??= (await myself(p.site)).accountId;
          return search(p, order());
        }));
        if (!current()) return;
        this.capped = results.some((r) => r.capped); this.error = null; this.signIn = null;
        // Stored when the list or where it comes from changed.
        const meta = JSON.stringify({ repo: this.repo, projects: this.projects, from: this.from, capped: this.capped });
        if (this.setIssues(results.flatMap((r) => r.issues)) || meta !== this.meta) {
          this.meta = meta;
          remember(`${space.id}:${order()}`, { repo: this.repo, issues: this.issues, projects: this.projects, from: this.from, capped: this.capped });
        }
        if (this.filter === "mentioned") this.loadMentions(cx);
      } catch (e) {
        if (!current()) return;
        this.error = String(e?.message ?? e);
        // 401: no sign-in, or one Jira refuses (an expired or a scoped token).
        this.signIn = e?.status === 401 ? e.site ?? (this.projects.some(isLinear) ? linear.SITE : this.projects[0]?.site) : null;
      }
      finally {
        if (current()) {
          this.loading = false; cx.notify();
          if (this.pendingOpen) { const w = this.pendingOpen; this.pendingOpen = null; this.openRequest(w, cx); }
        }
      }
    });
  }

  // Another mod asks to show an issue by its key (xref.js): one in the list, else one made from
  // the key and this space's projects (a Jira or Linear key, or #12 on GitHub). Until the space's
  // projects are known it waits for the list.
  openRequest(w, cx) {
    if (!w.key) return;
    // A fresh copy (or a space switch) hasn't loaded yet: `stale` until its refresh starts.
    if (!this.projects.length && (this.loading || this.stale || this.spaceId === undefined)) { this.pendingOpen = w; return; }
    const i = this.issueFor(w);
    if (i) this.pick(i, cx);
    else if (w.url) openUrl(w.url);
    else notify({ title: `No tracker linked here has ${w.key}`, body: "Link a Jira project, a Linear team or a GitHub repository with Link space.", level: "info", timeout: 5000 });
  }
  issueFor(w) {
    const key = w.key, listed = this.issues.find((x) => x.key === key);
    if (listed) return listed;
    if (key.startsWith("#")) {
      const repo = w.github ?? this.projects.find(isGithub)?.repo ?? this.github;
      const number = Number(key.slice(1));
      return repo && number ? { provider: "github", site: github.SITE, repo, key, number, fields: { summary: "" } } : null;
    }
    const prefix = key.split("-")[0].toUpperCase();
    if (this.projects.some((p) => isLinear(p) && (p.key ?? "").toUpperCase() === prefix)) return { provider: "linear", site: linear.SITE, key, fields: { summary: "" } };
    const jira = this.projects.filter((p) => !isGithub(p) && !isLinear(p));
    const site = jira.find((p) => (p.key ?? "").toUpperCase() === prefix)?.site ?? w.site ?? jira[0]?.site ?? knownSites()[0];
    return site ? { site, key, fields: { summary: "" } } : null;
  }
  // Opens a commit or a pull request in History or Pull requests; a page dialog closes first.
  openOther(mod, what) {
    if (this.only) closeOverlay(props().overlay);
    openIn(mod, what);
  }

  // The keys for Mentioned (GitHub `mentions:@me`) or Watching (Jira), fetched when that
  // filter is picked and again on each refresh while it stays picked.
  // Mentions have a sequence of their own (`mentionsSeq`): a refresh that bumps `gen` while one
  // loads must not leave mentionsLoading stuck on. The keys land only on the space they were for.
  loadMentions(cx) {
    const context = this.context, projects = this.projects, repo = this.repo;
    if (!projects.length) return;
    const seq = this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    this.mentionsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const keys = (await Promise.all(projects.map((p) => (isGithub(p) ? github.mentioned(p, where(repo, p)) : isLinear(p) ? linear.watched(p) : watched(p))))).flat();
        if (seq === this.mentionsSeq && context === this.context) { this.mentions = new Set(keys); this.mentionsVersion++; }
      } catch (e) { if (seq === this.mentionsSeq && context === this.context) this.error = String(e?.message ?? e); }
      finally { if (seq === this.mentionsSeq) { this.mentionsLoading = false; cx.notify(); } }
    });
  }

  // The filters, like GitHub's: Assigned to me, Created by me, Mentioned (Watching on
  // Jira) and Recent activity (updated in the last 7 days). None picked: every issue.
  keep(i) {
    const me = this.me[i.site];
    if (this.filter === "assigned") return (i.assignees ?? [i.fields.assignee?.accountId]).includes(me);
    if (this.filter === "created") return i.author != null && i.author === me;
    if (this.filter === "mentioned") return Boolean(this.mentions?.has(i.key));
    if (this.filter === "recent") return Date.parse(i.fields.updated) > Date.now() - WEEK;
    return true;
  }

  // New issues replace the list only when they differ: an unchanged refresh just updates the
  // ages, so the list isn't regrouped, stored or redrawn for nothing. True when it changed.
  setIssues(issues) {
    const saved = JSON.stringify(issues);
    if (saved === this.saved) {
      for (const d of this.data.values()) d.age = ago(d.updated);
      return false;
    }
    this.saved = saved; this.issues = issues; this.version = ++this.versions;
    this.data = new Map(issues.map((i) => [i.key, rowData(i)]));
    this.hay = new Map(issues.map((i) => [i.key, haystack(i)]));
    return true;
  }

  // An issue's page takes the list's place; the list keeps its search and highlight.
  pick(i, cx) {
    this.cursor = i.key; this.keys = false;
    if (pageMode("herdr-ranch-issues") === "overlay") { this.openPage(i); cx.notify(); return; }
    this.load(i, cx);
  }
  // The list shows where it was; fresh data loads behind it.
  back(cx) {
    this.open = null; this.page = null; this.pageError = null;
    this.handle.focus(); this.refresh(cx); cx.notify(this.pageView); cx.notify();
  }

  // A page from the cache shows at once and is fetched again behind it.
  load(i, cx) {
    this.open = i; this.shown = i; this.page = this.pages.get(pageKey(i)) ?? null; this.pageError = null;
    cx.spawn(async (cx) => {
      try {
        const page = await this.fetchPage(i);
        if (this.open === i) { this.page = page; this.pageError = null; }
      }
      catch (e) { if (this.open === i && !this.page) this.pageError = String(e?.message ?? e); }
      cx.notify(this.pageView);
    });
    cx.notify(this.pageView); cx.notify();
  }

  async fetchPage(i) {
    // Jira names no pull requests: the space's repository is searched for the key. And the
    // commits on any branch of the space's repository whose message names it.
    const [page, prs, commits] = await Promise.all([
      isGithub(i) ? github.issue(i, where(this.repo, i)) : isLinear(i) ? linear.issue(i) : issue(i.site, i.key),
      !isGithub(i) && this.github ? github.prsFor(i.key, this.github, where(this.repo, { repo: this.github })).catch(() => []) : null,
      this.repo && (!isGithub(i) || sameRepo(i.repo, this.github)) ? commitsMentioning(i.key, this.repo) : null,
    ]);
    page.commits = commits;
    // Linear names its pull requests itself (GitHub attachments); else the search's.
    if (prs && !(isLinear(i) && page.prs?.length)) page.prs = prs;
    // Converted once here, not on every render (Herdr renders on any live change): the
    // description, then comments and events in time order.
    const comments = page.fields.comment?.comments ?? [];
    page.md = { description: short(text(page.fields.description)), count: comments.length };
    page.timeline = [
      ...comments.slice(-COMMENTS).map((c) => ({ who: c.author?.displayName, at: c.created, md: short(text(c.body)) || " " })),
      ...(page.events ?? []),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    delete page.fields.comment; delete page.events;
    this.pages.delete(pageKey(i)); this.pages.set(pageKey(i), page);
    if (this.pages.size > PAGES) this.pages.delete(this.pages.keys().next().value);
    return page;
  }

  // The page of the issue the highlight or the pointer rests on, fetched after 300 ms there.
  prefetch(i, cx) {
    if (this.pages.has(pageKey(i))) return;
    cx.spawn(async (cx) => {
      await cx.sleep(300);
      if ((this.cursor === i.key || this.hovered === i.key) && !this.pages.has(pageKey(i)) && !this.open) await this.fetchPage(i).catch(() => null);
    });
  }

  // Grouping hundreds of issues on every render costs too much script time: kept until
  // the issues, the search or the filter change. `items` are the list's rows (headings and
  // issues, with their row data), at most SHOWN issues; `total` is how many match.
  items() {
    const here = this.branchKey();
    const k = `${this.version}|${this.query}|${this.filter}|${this.mentionsVersion}|${here}`;
    if (this.cache?.k !== k) {
      const ws = words(this.query);
      const groups = rows(this.issues, (i) => matches(this.hay.get(i.key), ws) && this.keep(i), order());
      const items = [];
      // The issue the shown branch names, pinned on top (it stays in its own group too).
      // Only when it passes the search and the filter too.
      const hereIssue = here && this.issues.find((x) => x.key === here);
      const mine = hereIssue && matches(this.hay.get(here), ws) && this.keep(hereIssue) ? this.data.get(here) : null;
      if (mine) items.push({ key: "group-here", group: { label: "This branch", count: "1" } }, { key: `here-${here}`, data: mine, depth: 0 });
      let left = SHOWN;
      for (const g of groups) {
        if (left <= 0) break;
        const shown = g.rows.slice(0, left); left -= shown.length;
        items.push({ key: `group-${g.id}`, group: { label: g.label, count: String(g.rows.length) } },
          ...shown.map((r) => ({ key: `issue-${r.issue.key}`, data: this.data.get(r.issue.key), depth: r.depth })));
      }
      const flat = groups.flatMap((g) => g.rows.map((r) => r.issue));
      // The key column fits the longest key shown: "#172" needs far less than "ACME0010-1156".
      const longest = items.reduce((n, i) => Math.max(n, i.data?.key.length ?? 0), 0);
      this.cache = { k, items, flat: flat.slice(0, SHOWN), total: flat.length, keyW: Math.min(110, Math.max(36, Math.ceil(longest * 6.6) + 8)) };
    }
    return this.cache;
  }

  // The issue key in the shown space's branch: RKT-412 from feature/RKT-412-x or agent/RKT-412-…,
  // #12 from issue-12-x or 12-x on a GitHub-linked space.
  branchKey() {
    const b = this.space()?.branch ?? "";
    const jira = /(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]{1,19}-\d+)(?![0-9])/.exec(b)?.[1];
    if (jira && this.data.has(jira)) return jira;
    const n = /(?:^|[/-])issue-(\d+)(?![0-9])/.exec(b)?.[1];
    return n ? `#${n}` : jira ?? null;
  }

  move(step, cx) {
    const flat = this.items().flat;
    if (!flat.length) return;
    const at = flat.findIndex((i) => i.key === this.cursor);
    // The keys move the highlight and Enter opens the page.
    const next = flat[Math.max(0, Math.min(flat.length - 1, at < 0 ? 0 : at + step))];
    this.cursor = next.key; this.keys = true; this.prefetch(next, cx);
    cx.notify();
  }

  enter(cx) {
    const i = this.issues.find((x) => x.key === this.cursor);
    if (i) { this.pick(i, cx); this.keys = true; } // opened with the keys: keep the highlight
  }

  dispatch(i, page) {
    const title = page.fields.summary;
    // From a page dialog: the agent's dialog takes its place.
    if (this.only) closeOverlay(props().overlay);
    const f = page.fields, branch = isGithub(i) ? `agent/issue-${i.number}-${slug(title)}-${hash(`github-${i.repo}-${i.number}`)}`
      : `agent/${i.key}-${slug(title)}-${hash(`jira-${i.site}-${i.key}`)}`;
    const tab = `${i.key} ${title}`.slice(0, 60);
    openAgentDialog("herdr-ranch-issues", {
      kind: "issue", repo: this.repo.main, on: this.repo.on, key: i.key, title, icon: issueKind(f.issuetype?.name, f.labels ?? []),
      vars: {
        key: isGithub(i) ? `${i.repo}${i.key}` : i.key, title, url: browse(i), type: f.issuetype?.name ?? "", status: f.status?.name ?? "",
        priority: f.priority?.name ?? "", labels: (f.labels ?? []).join(", "), description: text(f.description) || "(no description)", tracker: home(i),
      },
      // A branch per mode (agent/plan-…, agent/investigate-…), so planning and then working on one issue don't collide.
      branches: { work: branch, plan: branch.replace(/^agent\//, "agent/plan-"), investigate: branch.replace(/^agent\//, "agent/investigate-") }, tabs: { work: tab, plan: `Plan ${tab}`.slice(0, 60), investigate: `Investigate ${tab}`.slice(0, 60) },
    });
  }

  // One row from its row data and the styles `render` picked once (`s`). Built once per
  // render: hover is a style (no script runs on it), and only entering a row calls back,
  // to fetch its page ahead.
  row(d, depth, s) {
    const t = s.t;
    const status = div().flex_none().max_w(110).truncate().px(6).py(1).rounded(4).text_size(fs.tiny)
      .bg(d.active ? s.activeBg : t.raised).text_color(d.active ? t.accent : t.muted).child(d.status);
    const blocked = (e) => (d.blocked ? e.child(div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(fs.tiny).text_color(t.ansi1).child("blocked")) : e);
    const kind = icon(d.kind, kindColor(d.kind, t));
    const key = div().w(s.keyW).flex_none().truncate().text_size(fs.meta).text_color(t.dim).child(d.key);
    const title = div().flex_1().min_w(0).truncate().child(d.title);
    const age = div().w(30).flex_none().text_right().text_size(fs.meta).text_color(t.dim).child(d.age);
    const agent = (e) => { const c = s.agents?.has(d.key) && agentChip(`agent-${depth}-${d.key}`, s.agents.get(d.key), t); return c ? e.child(c) : e; };
    const base = (e) => e.flex_none().pl(10 + depth * 18).pr(10).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .when(s.keys && s.cursor === d.key, (e) => e.bg(t.selected));
    // Narrow (the side panel): two lines, so the summary keeps the whole width.
    if (s.two) return base(v_flex()).h(fs.row2).justify_center().gap(3)
      .child(h_flex().gap(8).items_center().child(kind).child(key).child(title).child(age))
      .child(agent(blocked(h_flex().pl(s.keyW + 30).gap(6).items_center().child(avatar(d.assignee, t, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).text_color(t.muted).child(d.assignee ?? "Unassigned")))).child(status));
    return agent(blocked(base(h_flex()).h(fs.row).gap(8).items_center().child(kind).child(key).child(title))).child(status)
      .child(avatar(d.assignee, t))
      .child(age);
  }

  // Herdr calls this when the copy goes (only on this root view, never on the dialogs made with
  // cx.new). A page dialog or a Link space / Start agent / Prompts dialog (closed with Esc, × or a
  // click beside it) hands the keyboard back to the list, else keys would go to a terminal.
  async close() { if (this.only || this.dialog) run("herdr-ranch-issues.focus"); }

  // Goes to an agent's space; a page dialog closes first, so it doesn't cover that space.
  go(id) {
    if (this.only) closeOverlay(props().overlay);
    goToSpace(id);
  }

  // Sub-tasks: Jira's from the page; GitHub's from the list (its children by parent).
  kids(key) {
    if (this.only) return this.kidsMap[key] ?? [];
    return this.issues.filter((x) => x.fields.parent?.key === key).map((x) => ({ key: x.key, summary: x.fields.summary, done: false }));
  }

  // The commits whose message names the issue, newest first, from any branch of the space's
  // repository: each opens in History, and the last line searches History for the key.
  commitList(i, commits, t) {
    const at = { cwd: this.repo?.main, on: this.repo?.on ?? null }, SHOW = 8;
    const all = div().id("commits-all").text_size(fs.tiny).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent))
      .on_click(() => this.openOther(MODS.history, { search: i.key, ...at }))
      .child(commits.length > SHOW ? `All ${commits.length >= 20 ? "20+" : commits.length} in History` : "Search History");
    if (!commits.length) return v_flex().gap(4).child(div().text_size(fs.meta).text_color(t.dim).child(`No commit names ${i.key}.`)).child(all);
    return v_flex().gap(4).children(commits.slice(0, SHOW).map((c) => h_flex().id(`commit-${c.sha}`).gap(6).items_center().text_size(fs.meta).min_w(0)
      .cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => this.openOther(MODS.history, { sha: c.sha, ...at }))
      .child(div().flex_none().font_family("Menlo").text_color(t.dim).child(c.short))
      .child(div().flex_1().min_w(0).truncate().child(c.title || "(no message)"))
      .child(div().flex_none().text_size(fs.tiny).text_color(t.dim).child(ago(c.at))))).child(all);
  }

  // The page's own keys (Up, Down and Esc are the dialog's or the list's): ⌘↵ Start agent, O open, C copy the key.
  pageKey(e, cx) {
    const i = this.open, p = this.page, m = e.modifiers ?? {};
    if (!i) return false;
    if (e.key === "enter" && m.platform) { const a = liveAgent(agentSpaces(this.repo?.main).issues.get(i.key)); if (a) this.go(a.id); else if (this.repo && p) this.dispatch(i, p); return true; }
    if (m.platform || m.control || m.alt) return false;
    if (e.key === "o") { openUrl(browse(i)); return true; }
    if (e.key === "c") { const k = isGithub(i) ? `${i.repo}${i.key}` : i.key; cx.write_to_clipboard(k); notify({ title: `Copied ${k}`, level: "success", timeout: 2000 }); return true; }
    return false;
  }

  // GitHub's issue page: header (position, actions, title, state badge, byline), the
  // conversation as a timeline, properties in a sidebar. `i` and `p`: the open issue and its page.
  detail(t, i = this.open, p = this.page) {
    const k = kit(t), f = p?.fields ?? i.fields, gh = isGithub(i);
    const kind = issueKind(f.issuetype?.name, f.labels ?? []);
    const cat = f.status?.statusCategory?.key ?? i.fields.status?.statusCategory?.key;
    const closed = gh && f.status?.name === "Closed";
    const badge = gh ? k.badge(closed ? "Closed" : "Open", closed ? t.ansi5 : t.ansi2, "issue")
      : k.badge(f.status?.name ?? "?", cat === "done" ? t.ansi2 : cat === "indeterminate" ? t.accent : t.muted, cat === "done" ? "done" : cat === "indeterminate" ? "pending" : "circle");
    const reporter = f.reporter?.displayName, created = f.created;
    const full = !this.only && pageMode("herdr-ranch-issues") === "full";
    const nav = this.only ? h_flex().gap(6).items_center().text_size(fs.meta).text_color(t.muted)
        .child(k.arrow("prev", "↑", (cx) => this.step(-1, cx), this.only.at > 0))
        .child(k.arrow("next", "↓", (cx) => this.step(1, cx), this.only.at < this.only.list.length - 1))
        .child(`${this.only.at + 1} of ${this.only.list.length}`)
      : full ? k.button("issue-back", "← Back", () => run("herdr-ranch-issues.back")) : null;
    const timeline = p ? p.timeline.map((x, n) => (x.md != null
      ? k.card(`c-${i.key}-${n}`, x.who, "commented", `${ago(x.at)} ago`, TextView.markdown(`comment-${i.key}-${n}`, x.md).selectable(true).on_link_click((url) => openUrl(url)))
      : k.event(`e-${i.key}-${n}`, x.who, x.text, `${ago(x.at)} ago`, x.color && t[x.color]))) : [];
    const sub = p?.sub?.length ? p.sub : this.kids(i.key);
    const prs = p?.prs ?? [];
    const prIcon = (s) => (s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : s === "DRAFT" ? "draft" : "pr");
    const working = agentSpaces(this.repo?.main).issues.get(i.key) ?? [], lead = liveAgent(working);
    // On a Jira issue, the keys it names (parent, sub-tasks, relations) open on Jira too.
    const jira = (key, id) => (!gh && !isLinear(i) && i.site && key ? div().id(id).flex_none().px(5).rounded(4).text_size(fs.tiny).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.accent)).on_click(() => openUrl(`https://${i.site}/browse/${key}`)).child("Jira ↗") : null);
    const withJira = (row, key, id) => { const j = jira(key, id); return j ? row.child(j) : row; };
    const side = [
      k.agents(working, (id) => this.go(id)),
      k.section("Assignee", f.assignee ? k.person(f.assignee.displayName) : div().text_size(fs.meta).text_color(t.dim).child("Nobody")),
      reporter && k.section(gh ? "Author" : "Reporter", k.person(reporter)),
      f.priority?.name && k.section("Priority", div().text_size(fs.meta).child(f.priority.name)),
      f.labels?.length > 0 && k.section("Labels", h_flex().flex_wrap().gap(4).children(f.labels.map((l) => k.label(l)))),
      f.parent?.key && k.section("Parent", withJira(h_flex().gap(6).items_center().text_size(fs.meta).child(div().flex_1().text_color(t.muted).child(f.parent.key)), f.parent.key, "parent-jira")),
      f.milestone && k.section("Milestone", div().text_size(fs.meta).child(f.milestone)),
      sub.length > 0 && k.section("Sub-tasks", v_flex().gap(4).children(sub.map((x) => withJira(h_flex().gap(6).items_center().text_size(fs.meta).min_w(0)
          .child(icon(x.done ? "done" : "circle", x.done ? t.ansi2 : t.dim, 13))
          .child(div().flex_none().text_color(t.dim).child(x.key))
          .child(div().flex_1().min_w(0).truncate().when(x.done, (e) => e.line_through().text_color(t.muted)).child(x.summary)), x.key, `sub-jira-${x.key}`))),
        div().text_size(fs.tiny).text_color(t.dim).child(`${sub.filter((x) => x.done).length} of ${sub.length}`)),
      p?.relations?.length > 0 && k.section("Relations", v_flex().gap(4).children(p.relations.map((x, n) => v_flex().id(`rel-${n}`).gap(1).min_w(0).text_size(fs.meta)
          .child(div().text_size(fs.tiny).text_color(/block/.test(x.label) && !x.done ? t.ansi1 : t.dim).child(x.label))
          .child(withJira(h_flex().gap(6).items_center().min_w(0)
            .child(icon(x.done ? "done" : "circle", x.done ? t.ansi2 : t.dim, 13))
            .child(div().flex_none().text_color(t.dim).child(x.key))
            .child(div().flex_1().min_w(0).truncate().when(x.done, (e) => e.line_through().text_color(t.muted)).child(x.summary)), x.key, `rel-jira-${n}`))))),
      // A pull request of the space's repository opens in Pull requests; another one on GitHub.
      p && k.section("Development", prs.length ? v_flex().gap(4).children(prs.map((x) => h_flex().id(`pr-${x.number}`).gap(6).items_center().text_size(fs.meta).min_w(0)
          .cursor_pointer().hover((s) => s.text_color(t.accent))
          .on_click(() => (this.github && sameRepo(repoOfUrl(x.url), this.github) ? this.openOther(MODS.prs, { number: x.number, github: this.github }) : openUrl(x.url)))
          .child(icon(prIcon(x.state), kindColor(prIcon(x.state), t), 13))
          .child(div().flex_none().text_color(t.dim).child(`#${x.number}`))
          .child(div().flex_1().min_w(0).truncate().child(x.title))
          .when(Boolean(x.checks && (x.checks.fail || x.checks.pending || x.checks.pass)), (e) => {
            const c = x.checks, st = c.fail ? "x" : c.pending ? "pending" : "check";
            return e.child(h_flex().flex_none().gap(2).items_center().text_color(kindColor(st, t)).child(icon(st, kindColor(st, t), 11)).child(String(c.fail || c.pending || c.pass)));
          })))
        : div().text_size(fs.meta).text_color(t.dim).child(gh ? "No pull request mentions this issue." : this.github ? `No pull request names ${i.key}.` : "Link a GitHub repository to see pull requests.")),
      p?.commits && k.section("Commits", this.commitList(i, p.commits, t)),
    ];
    const keys = [...(this.only || split() ? [[["↑", "↓"], "previous / next"]] : []), ...(lead ? [[["⌘", "↵"], "go to agent"]] : this.repo && p ? [[["⌘", "↵"], "Start agent"]] : []),
      [["O"], `open in ${home(i)}`], [["C"], "copy key"], [["Esc"], this.only ? "close" : "back"]];
    return pageLayout({
      id: "issue-detail", t, wide: (this.only ? this.pageW : this.width) >= PAGE_WIDE, nav,
      actions: [
        k.button("issue-open", `Open in ${home(i)}`, () => openUrl(browse(i)), { hint: "O" }),
        ...(lead ? [
          ...(this.repo && p ? [k.button("issue-agent", "Start another", () => this.dispatch(i, p))] : []),
          k.button("issue-go", `Go to agent · ${AGENT_STATUS[lead.status]?.[0] ?? "idle"}`, () => this.go(lead.id), { primary: true, icon: "bot", hint: "⌘↵" }),
        ] : this.repo && p ? [k.button("issue-agent", "Start agent", () => this.dispatch(i, p), { primary: true, icon: "bot", hint: "⌘↵" })] : []),
      ],
      title: f.summary, key: i.key,
      status: h_flex().gap(8).items_center().flex_wrap().child(badge)
        .child(h_flex().gap(4).items_center().text_size(fs.meta).text_color(kindColor(kind, t)).child(icon(kind, kindColor(kind, t), 13)).child(div().text_color(t.foreground).child(f.issuetype?.name ?? "Issue")))
        .when(Boolean(reporter), (e) => e.child(h_flex().gap(4).text_size(fs.meta).text_color(t.muted)
          .child(div().font_semibold().text_color(t.foreground).child(reporter))
          .child(`${gh ? "opened" : "reported"} this${created ? ` ${ago(created)} ago` : ""}${p ? ` · ${p.md.count} comment${p.md.count === 1 ? "" : "s"}` : ""}`))),
      main: [
        p ? k.card(`card-desc-${i.key}`, reporter, gh ? "opened" : "reported", created ? `${ago(created)} ago` : "", TextView.markdown(`desc-${i.key}`, p.md.description || "_No description._").selectable(true).on_link_click((url) => openUrl(url)))
          : div().p(10).text_color(this.pageError ? t.ansi1 : t.dim).child(this.pageError ?? "Loading the description and comments…"),
        ...timeline,
        ...(p && p.md.count > COMMENTS ? [div().pl(38).text_size(fs.meta).text_color(t.dim).child(`Older comments are in ${home(i)}.`)] : []),
      ],
      side,
      footer: k.footer(keys),
    });
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
    if (this.open) this.watchAgents(cx, agentSpaces(this.repo?.main).issues.get(this.open.key));
    if (this.only) {
      // A page belongs to the space it was opened in: a space switch closes it.
      const now = activeSpace()?.id ?? null;
      if (this.onlySpace === undefined) this.onlySpace = now;
      else if (now !== this.onlySpace) { try { cx.timer.after(0, () => closeOverlay(props().overlay)); } catch { /* closes on the next change */ } }
      return pageDialog("issue-dialog", this.handle, this.pageView, { mod: "herdr-ranch-issues",
        step: (by, cx) => this.step(by, cx), key: (e, cx) => this.pageKey(e, cx),
        width: (w, cx) => { const was = this.pageW >= PAGE_WIDE; this.pageW = w; if (was !== (w >= PAGE_WIDE)) cx.notify(this.pageView); },
      });
    }
    if (props()?.settings) return settingsMenu("herdr-ranch-issues", [OPENS, ORDER, PAGE]);
    const req = takeOpen(MODS.issues, this.xseen);
    if (req) { this.xseen = req.seq; try { cx.timer.after(0, (cx) => this.openRequest(req.what ?? {}, cx)); } catch { this.xseen = null; } }
    // A space switch shows that space's list in this very render, and loads it right after.
    const space = this.space();
    if ((space?.id ?? null) !== this.spaceId) {
      this.show(space, contextKey(space));
      try { cx.timer.after(0, (cx) => { if (this.stale) this.refresh(cx); }); } catch { /* the 1.5 s check loads it */ }
    }
    const inSplit = split(), full = pageMode("herdr-ranch-issues") === "full";
    if (inSplit !== this.wasSplit) {
      this.wasSplit = inSplit;
      if (this.open) try { cx.timer.after(0, (cx) => cx.notify(this.pageView)); } catch { /* shown on the next page change */ }
    }
    const t = theme(), overlay = props()?.overlay, wide = this.width >= WIDE;
    const { items, total, keyW } = this.projects.length ? this.items() : { items: [], total: 0, keyW: 36 };
    const toggle = (id, label, on, flip) => div().id(id).px(8).py(2).flex_none().rounded(6).cursor_pointer().text_size(fs.meta)
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { flip(cx); cx.notify(); }).child(label);
    const unlinked = !this.loading && !this.error && !this.projects.length;
    const empty = this.signIn === linear.SITE ? "Linear needs an API key: connect it in Link space." : this.signIn ? `Jira doesn't accept the sign-in for ${this.signIn}.` : this.error || (this.loading ? "Loading issues…" : unlinked ? "No issues linked to this space: link a Jira project, a Linear team or a GitHub repository." : this.issues.length ? (this.filter === "mentioned" && this.mentionsLoading ? "Loading…" : "Nothing matches.") : this.projects.some((p) => isLinear(p) && p.filter === "cycle") ? "No open issues in the active cycle. Link space can show all open ones." : this.projects.some((p) => isLinear(p) && p.filter === "mine") ? "No open issues assigned to you. Link space can show all open ones." : "No open issues.");
    const source = this.projects.map((p) => (isGithub(p) ? `GitHub ${p.repo}` : isLinear(p) ? `Linear ${p.key}` : p.key)).join(", ")
      + (this.from === "guess" ? " (guessed)" : this.from === "file" ? " (.herdr/jira.toml)" : "");
    const heading = (g) => h_flex().h(fs.head).flex_none().px(10).gap(6).items_end().text_size(fs.meta).text_color(t.dim)
      .child(div().font_semibold().child(g.label)).child(div().child(g.count));
    const s = { t, keyW, activeBg: t.accent + "30", two: this.width < ROOMY, keys: this.keys, cursor: this.cursor, agents: agentSpaces(this.repo?.main).issues };
    const issue = (key) => this.issues.find((x) => x.key === key);
    // A plain list, built once per render. A virtual list calls its row builder for every
    // frame drawn (hovering included), which made hovering lag; this one runs no script
    // between renders. SHOWN caps what a render builds.
    const [shownItems, windowed] = this.keyWindow(items, (i) => i.data?.key === this.cursor, s.two ? fs.row2 : fs.row);
    const list = v_flex().flex_1().min_w(0).min_h(0)
      .when(items.length > 0, (e) => e.child(v_flex().id(windowed ? "issue-list-keys" : "issue-list").w_full().flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .children(shownItems.map((i) => (i.group ? heading(i.group) : this.row(i.data, i.depth, s).id(i.key)
          .on_click((_e, cx) => { const x = issue(i.data.key); if (x) { this.handle.focus(); this.pick(x, cx); } })
          .on_hover((on, cx) => {
            if (!on) { if (this.hovered === i.data.key) this.hovered = null; return; }
            this.hovered = i.data.key; const x = issue(i.data.key); if (x) this.prefetch(x, cx);
          }))))))
      .when(total > SHOWN, (e) => e.child(div().px(10).py(4).text_size(fs.meta).text_color(t.dim).child(`Showing ${SHOWN} of ${total}: search to narrow`)))
      .when(this.capped && items.length > 0, (e) => e.child(div().px(10).py(4).text_size(fs.meta).text_color(t.dim).child(order() === "backlog" ? "Showing the first 500 issues of the backlog" : "Showing the 500 most recently updated issues")))
      .when(!items.length, (e) => e.child(v_flex().p(12).gap(8).items_start()
        .child(div().text_color(this.error ? t.ansi1 : t.dim).child(empty))
        .when(unlinked, (e) => e.child(toggle("link-empty", "Link this space", false, () => openLinkDialog("herdr-ranch-issues"))))
        .when(Boolean(this.signIn), (e) => e
          .child(div().text_size(fs.meta).text_color(t.muted).child(this.signIn === linear.SITE
            ? `Connect in Link space (a personal API key, stored in ${STORE[platform()]}), or set LINEAR_API_KEY, then Refresh.`
            : `Connect in Link space (email and a classic API token, stored in ${STORE[platform()]}), or set JIRA_EMAIL and JIRA_API_TOKEN, then Refresh.`))
          .child(h_flex().gap(6)
            .child(toggle("token-page", this.signIn === linear.SITE ? "API keys ↗" : "API tokens ↗", false, () => openUrl(this.signIn === linear.SITE ? "https://linear.app/settings/account/security" : TOKEN_PAGE)))
            .child(toggle("sign-in-help", "Link space", false, () => openLinkDialog("herdr-ranch-issues")))))));
    const watching = this.projects.length > 0 && this.projects.every((p) => !isGithub(p));
    const filters = h_flex().child(segmented("filter", [["assigned", "Assigned"], ["created", "Created"], ["mentioned", watching ? "Watching" : "Mentioned"], ["recent", "Recent"]], this.filter, (id, cx) => {
      this.filter = id;
      if (this.filter === "mentioned" && !this.mentions && !this.mentionsLoading) this.loadMentions(cx);
    }, t));
    // Refresh (Herdr's spinner while loading) and the cog for the settings: Herdr's own icons,
    // since svg() can't read icons from a linked mod folder.
    const iconButton = (id, glyph, click) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(glyph);
    const search = div().min_w(0).px(8).py(3).rounded(6).border_1().border_color(t.input).text_size(fs.meta).child(Input.new(this.search));
    const close = div().id("close").px(6).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click(() => closeOverlay(overlay)).child("×");
    return v_flex().id("herdr-ranch-issues").relative().overflow_hidden().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fs.body)
      .on_size_change((size, cx) => { this.height = size.height; this.resized(Math.round(size.width), cx); })
      .track_focus(this.handle)
      .on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* best effort */ } })
      .on_key_down((e, cx) => {
        // In a split Up and Down step through the issues, the page following along.
        if (this.open && inSplit && (e.key === "down" || e.key === "up")) { this.move(e.key === "down" ? 1 : -1, cx); const i = this.issues.find((x) => x.key === this.cursor); if (i) this.load(i, cx); }
        else if (this.open) { if (e.key === "escape") this.back(cx); else if (!this.pageKey(e, cx)) return; }
        else if (e.key === "down") this.move(1, cx);
        else if (e.key === "up") this.move(-1, cx);
        else if (e.key === "enter") this.enter(cx);
        else if (e.key === "escape" && overlay) closeOverlay(overlay);
        else return;
        cx.stop_propagation();
      })
      .when(Boolean(this.open) && full, (e) => e.child(this.pageView))
      .when(!this.open || !full, (e) => e.child(this.paged(inSplit, t, v_flex().flex_1().min_h(0).w_full()
      .child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_semibold().child("Issues"))
          .child(div().flex_1().min_w(0).text_size(fs.meta).text_color(t.dim).truncate().child(this.loading && this.issues.length ? `${source} · Refreshing…` : source))
          .when(wide, (e) => e.child(search.w(220)))
          .child(iconButton("refresh", this.loading ? svg(SPINNER).size(14).spin(900) : "↻", (cx) => this.refresh(cx)))
          .child(iconButton("settings", svg(COG).size(14), () => openSettings("herdr-ranch-issues")))
          .when(Boolean(overlay), (e) => e.child(close)))
        .when(!wide, (e) => e.child(search.w_full()))
        .child(filters))
      .when(Boolean(this.error && this.issues.length), (e) => e.child(div().px(14).py(4).text_size(fs.meta).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_1().min_h(0).child(list))
      .child(kit(t).footer([[["↑", "↓"], "move"], [["↵"], "open"], ...(overlay ? [[["Esc"], "close"]] : [])])))));
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
    const apply = (cx) => { this.settling = false; if (this.nextWidth !== this.width) { this.width = this.nextWidth; keepWidth(this.width); cx.notify(); if (this.open) cx.notify(this.pageView); } };
    try { cx.timer.after(200, apply); } catch { apply(cx); }
  }

  // Split: the list on top and the open issue's page under it, in Herdr's own split.
  paged(inSplit, t, list) {
    return inSplit ? splitView("issue-page", list, this.pageView, Boolean(this.open), (cx) => this.back(cx)) : list;
  }


}
