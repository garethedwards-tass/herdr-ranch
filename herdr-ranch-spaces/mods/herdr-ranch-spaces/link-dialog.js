// "Link space": which GitHub repository and Jira project a space works on.
// Part of herdr-ranch-prs and herdr-ranch-issues: each opens itself as this dialog with props
// { dialog: "link", space }. The source is shared/link-dialog.js.
// GitHub: the repository with suggestions from `gh` (its own sign-in: `gh auth login`).
// Jira: the site, whether the sign-in works, and the project, searched in Jira as you type.
// Connect takes an email and a classic API token, tests them against Jira, and hands a
// working pair to the system's credential store (jira-client.js storeSignIn); the token
// is never kept in Herdr's settings. docs/connect-jira.md explains every way to connect.
// Issues: from Jira (the default when a project is linked) or from the GitHub repository.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, exec, run } from "herdr";
import { spaceRepo, linkOf, saveLink, knownSites, detectGithub, openUrl } from "./links.js";
import { credentials, myself, findProjects, cleanSite, call, TOKEN_PAGE, storeSignIn, removeSignIn, platform, STORE, validSite, trustedSite, trustSite } from "./jira-client.js";
import { fs } from "./links.js";
import { linearKey, viewer as linearViewer, findTeams, connectLinear, disconnectLinear, KEY_PAGE as LINEAR_KEY_PAGE } from "./linear-client.js";

const branchKey = (branch) => /\b([A-Z][A-Z0-9]{1,9})-\d+\b/.exec(branch ?? "")?.[1] ?? "";
const WAIT = 350; // ms of no typing before a search runs
const DEFAULT_FILTER = "sprint in openSprints()";
const GUIDE = "https://github.com/jslowack/herdr-ranch/blob/main/docs/connect-jira.md";
// The filter presets; anything else is custom JQL.
const norm = (jql) => (jql ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// Linear's presets: the active cycle, every open issue, mine.
const LINEAR_PRESETS = [["", "All open"], ["cycle", "Active cycle"], ["mine", "Assigned to me"]];
const PRESETS = [["sprint", "Current sprint", DEFAULT_FILTER], ["open", "All open", ""], ["mine", "Assigned to me", "assignee = currentUser()"]];

export class LinkDialog extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
    this.repo = null; this.error = "";
    this.github = InputState.new({ placeholder: "owner/repo" });
    this.site = InputState.new({ placeholder: "example.atlassian.net" });
    this.project = InputState.new({ placeholder: "Search projects" });
    this.filter = InputState.new({ placeholder: "Optional JQL; empty shows every open issue" });
    this.ghFilter = InputState.new({ placeholder: "Optional GitHub search, e.g. label:bug milestone:v2" });
    this.issues = "jira";
    this.email = InputState.new({ placeholder: "you@example.com" });
    this.token = InputState.new({ placeholder: "Paste a classic API token" });
    try { this.token.set_masked(true); } catch { /* shown as typed */ }
    this.connecting = false; this.connectError = ""; this.showForm = false; this.custom = false; this.ghLogin = null;
    // Linear: the key's state, the team search and the chosen team and preset.
    this.lin = { state: "checking" }; this.linKey = InputState.new({ placeholder: "lin_api_…" });
    try { this.linKey.set_masked(true); } catch { /* shown as typed */ }
    this.linTeam = InputState.new({ placeholder: "Search teams" }); this.teams = []; this.linChosen = null; this.linFilter = ""; this.linOpen = false; this.linForm = false; this.linError = "";
    this.linTeam.on("change", (_e, cx) => { if (!typed("linTeam", this.linTeam)) return; this.linChosen = null; this.linOpen = true; this.debounce("linTeam", cx); });
    this.linTeam.on("focus", (_e, cx) => { this.linOpen = true; cx.notify(); });
    this.handle = cx.focus_handle();

    // GitHub suggestions: your repositories once, then `gh search repos` as you type.
    this.repos = []; this.found = []; this.ghSignedOut = false; this.ghOpen = false;
    // Jira: whether the sign-in works on the site, and the projects matching the typed text.
    this.auth = { state: "none" }; this.projects = []; this.chosen = null; this.jiraOpen = false; this.guess = "";
    this.seq = {};

    // set_value() may raise "change" too: values the dialog set itself are not typing.
    this.quiet = {};
    const typed = (what, state) => { const v = state.value(); if (this.quiet[what] === v) return false; delete this.quiet[what]; return true; };
    this.github.on("change", (_e, cx) => { if (!typed("github", this.github)) return; this.ghOpen = true; this.debounce("github", cx); });
    this.github.on("focus", (_e, cx) => { this.ghOpen = true; cx.notify(); });
    this.site.on("change", (_e, cx) => { this.auth = { state: "none" }; this.projects = []; this.debounce("site", cx); });
    this.project.on("change", (_e, cx) => { if (!typed("project", this.project)) return; this.chosen = null; this.jiraOpen = true; this.debounce("project", cx); });
    this.project.on("focus", (_e, cx) => { this.jiraOpen = true; cx.notify(); });
    this.filter.on("change", (_e, cx) => { if (this.filterError) { this.filterError = ""; cx.notify(); } });
    this.ghFilter.on("change", (_e, cx) => { if (this.ghFilterError) { this.ghFilterError = ""; cx.notify(); } });
    this.ghFilterError = "";
    this.filterError = ""; this.saving = false;

    cx.spawn(async (cx) => {
      this.repo = await spaceRepo(this.space).catch(() => null);
      const link = linkOf(this.space, this.repo) ?? {};
      const github = link.github || (this.repo ? await detectGithub(this.repo).catch(() => null) : null);
      this.set("github", this.github, github ?? "");
      this.guess = link.jira?.key ?? branchKey(this.space?.branch);
      this.site.set_value(link.jira?.site ?? knownSites()[0] ?? "");
      if (link.jira?.key) { this.chosen = { key: link.jira.key, name: "" }; this.set("project", this.project, link.jira.key); }
      // A new Jira link starts on the open sprints; an existing one keeps its filter, empty included.
      this.filter.set_value(link.jira ? link.jira.filter ?? "" : DEFAULT_FILTER);
      this.ghFilter.set_value(link.issuesFilter ?? "");
      this.custom = !PRESETS.some(([, , q]) => norm(q) === norm(this.filter.value()));
      const mail = this.repo ? await exec("git", ["-C", this.repo.main, "config", "user.email"], { on: this.repo.on }).catch(() => null) : null;
      if (mail?.code === 0) this.email.set_value(mail.stdout.trim());
      this.issues = link.issues ?? (link.jira ? "jira" : this.guess ? "jira" : "github");
      if (link.linear?.teamId) { this.linChosen = { id: link.linear.teamId, key: link.linear.key, name: link.linear.name ?? "" }; this.set("linTeam", this.linTeam, link.linear.key); this.linFilter = link.linear.filter ?? ""; }
      this.checkLinear(cx);
      this.ghOpen = false; this.jiraOpen = false;
      this.checkSite(cx);
      cx.notify();
      const list = await exec("gh", ["repo", "list", "--limit", "200", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"]).catch(() => null);
      if (list?.code === 0) this.repos = list.stdout.split("\n").filter(Boolean);
      else this.ghSignedOut = true;
      const who = this.ghSignedOut ? null : await exec("gh", ["api", "user", "--jq", ".login"]).catch(() => null);
      if (who?.code === 0) this.ghLogin = who.stdout.trim();
      cx.notify();
    });
  }

  // Esc, Cancel and Save close it here; the list that opened it gets the keyboard back. Not a Herdr
  // hook (a child view never gets one): a click beside the dialog goes through the root view's close().
  close() { closeOverlay(props().overlay); const m = props()?.mod; if (m) run(`${m}.focus`); }

  set(what, state, value) { this.quiet[what] = value; state.set_value(value); }

  // A search runs once typing stops for WAIT ms: each keystroke sleeps, and only the
  // latest one goes on. No timer runs while nothing is typed.
  debounce(what, cx) {
    const n = this.seq[what] = (this.seq[what] ?? 0) + 1;
    cx.spawn(async (cx) => {
      await cx.sleep(WAIT);
      if (this.seq[what] !== n) return;
      if (what === "github") this.searchGithub(cx);
      if (what === "site") this.checkSite(cx, true);
      if (what === "project") this.searchProjects(cx);
      if (what === "linTeam") this.searchTeams(cx);
    });
  }

  searchGithub(cx) {
    const q = this.github.value().trim();
    if (q.length < 3 || this.ghSignedOut) { this.found = []; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["search", "repos", q, "--limit", "8", "--json", "fullName", "--jq", ".[].fullName"]).catch(() => null);
      if (this.github.value().trim() === q) { this.found = r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : []; cx.notify(); }
    });
  }

  ghSuggestions() {
    const q = this.github.value().trim().toLowerCase();
    const mine = this.repos.filter((r) => !q || r.toLowerCase().includes(q));
    return [...new Set([...mine, ...this.found])].filter((r) => r.toLowerCase() !== q).slice(0, 6);
  }

  // Whether the stored sign-in works on this site; then the first projects.
  // `typed`: the person typed this site (typing stopped), so it counts as theirs, and the
  // generic JIRA_API_TOKEN may be tried there; a site prefilled from a repository is not.
  checkSite(cx, typed = false) {
    const site = cleanSite(this.site.value());
    if (!site) { this.auth = { state: "none" }; cx.notify(); return; }
    if (!validSite(site)) { this.auth = { state: "error", site, message: "That isn't a site name: example.atlassian.net" }; cx.notify(); return; }
    if (typed) trustSite(site);
    if (!trustedSite(site)) { this.auth = { state: "untrusted", site }; cx.notify(); return; }
    this.auth = { state: "checking", site };
    cx.notify();
    cx.spawn(async (cx) => {
      let auth, c;
      try {
        c = await credentials(site);
        if (!c) auth = { state: "out", site };
        else {
          const me = await myself(site);
          auth = { state: "in", site, who: me.displayName ?? me.emailAddress ?? c.email, from: c.from };
        }
      } catch (e) { auth = { state: e?.status === 401 ? "refused" : "error", site, from: c?.from, message: String(e?.message ?? e) }; }
      if (cleanSite(this.site.value()) !== site) return;
      this.auth = auth;
      cx.notify();
      if (auth.state === "in") this.searchProjects(cx);
    });
  }

  searchProjects(cx) {
    const site = cleanSite(this.site.value());
    if (this.auth.state !== "in" || this.auth.site !== site) return;
    const typed = this.project.value().trim(), q = typed || this.guess;
    cx.spawn(async (cx) => {
      try {
        let found = await findProjects(site, q);
        // An empty search with a guess: the guess first, then the rest.
        if (!typed && this.guess) found = [...found, ...(await findProjects(site, "")).filter((p) => !found.some((f) => f.key === p.key))];
        if (this.project.value().trim() === typed) { this.projects = found.slice(0, 8); cx.notify(); }
      } catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
    });
  }

  // Tests the typed email and token against Jira, then stores a working pair.
  connect(cx) {
    const site = cleanSite(this.site.value()), email = this.email.value().trim(), token = this.token.value().trim();
    if (!site || !email || !token) { this.connectError = "The site, your email and a token, please."; cx.notify(); return; }
    if (!validSite(site)) { this.connectError = "That isn't a site name: example.atlassian.net"; cx.notify(); return; }
    if (this.connecting) return;
    // Typed here by the person: from now on a sign-in may go to this host.
    trustSite(site);
    this.connecting = true; this.connectError = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await myself(site, { email, token });
        const failed = await storeSignIn(site, email, token);
        if (failed) this.connectError = failed;
        else { this.token.set_value(""); this.showForm = false; this.checkSite(cx); }
      } catch (e) {
        this.connectError = e?.status === 401 ? "Jira doesn't accept this token. Is it a classic token (not one with scopes), for this email, not expired?"
          : String(e?.message ?? e);
      }
      this.connecting = false; cx.notify();
    });
  }

  // Whether a Linear key is set and works; then the first teams.
  checkLinear(cx) {
    this.lin = { state: "checking" }; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const k = await linearKey();
        if (!k) this.lin = { state: "out" };
        else { const me = await linearViewer(); this.lin = { state: "in", who: me?.name ?? me?.email ?? "you", from: k.from }; this.searchTeams(cx); }
      } catch (e) { this.lin = { state: e?.status === 401 ? "refused" : "error", message: String(e?.message ?? e) }; }
      cx.notify();
    });
  }

  searchTeams(cx) {
    if (this.lin.state !== "in") return;
    const q = this.linTeam.value().trim();
    cx.spawn(async (cx) => {
      try { const found = await findTeams(q); if (this.linTeam.value().trim() === q) { this.teams = found.slice(0, 8); cx.notify(); } }
      catch (e) { this.linError = String(e?.message ?? e); cx.notify(); }
    });
  }

  connectLinear(cx) {
    const token = this.linKey.value().trim();
    if (!token) { this.linError = "Paste a personal API key."; cx.notify(); return; }
    if (this.connecting) return;
    this.connecting = true; this.linError = ""; cx.notify();
    cx.spawn(async (cx) => {
      try { await connectLinear(token); this.linKey.set_value(""); this.linForm = false; this.checkLinear(cx); }
      catch (e) { this.linError = e?.status === 401 ? "Linear doesn't accept this key." : String(e?.message ?? e); }
      this.connecting = false; cx.notify();
    });
  }

  disconnect(cx) {
    const site = cleanSite(this.site.value());
    cx.spawn(async (cx) => { await removeSignIn(site); this.showForm = true; this.checkSite(cx); });
  }

  choose(p, cx) {
    this.chosen = p; this.jiraOpen = false;
    this.set("project", this.project, p.key);
    this.seq.project = (this.seq.project ?? 0) + 1;
    cx.notify();
  }

  save(cx) {
    const github = this.github.value().trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    // With issues from GitHub the Jira fields are hidden: a Jira link is kept only when both are filled.
    const fromGh = this.issues !== "jira", typedKey = (this.chosen?.key ?? this.project.value()).trim();
    const site = fromGh && !(cleanSite(this.site.value()) && typedKey) ? "" : cleanSite(this.site.value());
    const key = site ? typedKey.toUpperCase() : "", filter = this.filter.value().trim();
    if (!fromGh && Boolean(cleanSite(this.site.value())) !== Boolean(typedKey)) { this.error = "Jira needs both the site and a project."; cx.notify(); return; }
    if (github && !/^[\w.-]+\/[\w.-]+$/.test(github)) { this.error = "GitHub repository: owner/repo."; cx.notify(); return; }
    if (site && !validSite(site)) { this.error = "Jira site: a host name, e.g. example.atlassian.net."; cx.notify(); return; }
    if (site) trustSite(site);
    if (key && !/^[A-Z][A-Z0-9_]+$/.test(key)) { this.error = "Pick a project from the list, or type its key."; cx.notify(); return; }
    const ghFilter = this.ghFilter.value().trim(), fromGithub = this.issues === "github", fromLinear = this.issues === "linear";
    if (fromLinear && !this.linChosen) { this.error = "Pick a Linear team."; cx.notify(); return; }
    const store = () => {
      saveLink(this.space, this.repo, {
        ...(github ? { github } : {}),
        ...(site ? { jira: { site, key, ...(filter ? { filter } : {}) } } : {}),
        ...(fromGithub ? { issues: "github" } : {}),
        ...(fromLinear ? { issues: "linear", linear: { teamId: this.linChosen.id, key: this.linChosen.key, name: this.linChosen.name, ...(this.linFilter ? { filter: this.linFilter } : {}) } } : {}),
        ...(ghFilter ? { issuesFilter: ghFilter } : {}),
      });
      this.close();
    };
    const checkJira = filter && site && key && !fromGithub, checkGithub = ghFilter && fromGithub;
    if (!checkJira && !checkGithub) { store(); return; }
    if (this.saving) return;
    // Filters go into the panel's query as is: ask Jira or GitHub whether it parses first.
    // Only a rejected query stops the save; without a sign-in it can't be checked.
    this.saving = true; this.error = ""; this.filterError = ""; this.ghFilterError = ""; cx.notify();
    cx.spawn(async (cx) => {
      if (checkJira) {
        try {
          await call(site, "/rest/api/3/search/jql", { jql: `project = "${key}" AND statusCategory != Done AND (${filter})`, fields: ["id"], maxResults: 1 });
        } catch (e) {
          if (e?.status === 400) this.filterError = `${String(e.message).replace(/^Jira 400 \([^)]*\): /, "")} Example: sprint in openSprints()`;
        }
      }
      if (checkGithub) {
        const repo = github || (this.repo ? await detectGithub(this.repo).catch(() => null) : null);
        const r = repo ? await exec("gh", ["issue", "list", "-R", repo, "--state", "open", "--limit", "1", "--search", ghFilter, "--json", "number"]).catch(() => null) : null;
        // GitHub reads unknown words as search text, so only a failing gh stops the save
        // (an unknown repository, say); a missing gh leaves the filter unchecked.
        if (r && r.code !== 0) this.ghFilterError = (r.stderr || r.stdout || "GitHub rejects this search.").trim();
      }
      this.saving = false;
      if (this.filterError || this.ghFilterError) { cx.notify(); return; }
      store();
    });
  }

  render(cx) {
    const t = theme(), os = platform();
    // Links one space: a switch to another closes it, so Save can't land on a space not shown.
    const sp = spaces().find((x) => x.active)?.id ?? null;
    if (this.openSpace === undefined) this.openSpace = sp;
    else if (sp !== this.openSpace && !this.saving) { try { cx.timer.after(0, () => this.close()); } catch { /* next change */ } }
    const label = (text) => div().text_size(fs.tiny).text_color(t.muted).child(text);
    const hint = (text, color) => div().text_size(fs.tiny).text_color(color ?? t.dim).child(text);
    const box = (state, focused) => div().px(8).py(5).rounded(6).border_1().border_color(focused ? t.accent : t.input).bg(t.background).child(Input.new(state));
    const button = (id, text, kind, onClick) => h_flex().id(id).flex_none().gap(6).items_center().px(12).py(5).rounded(6).text_size(fs.meta).cursor_pointer()
      .when(kind === "primary", (e) => e.bg(t.ansi2).text_color(t.background).font_semibold())
      .when(kind === "blue", (e) => e.bg(t.accent).text_color(t.background).font_semibold())
      .when(kind === "link", (e) => e.px(2).text_color(t.accent))
      .when(!kind, (e) => e.border_1().border_color(t.border).bg(t.background))
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)).child(text);
    const chip = (id, text, on, onClick) => div().id(id).px(9).py(1).rounded_full().text_size(fs.tiny).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.accent : t.muted).when(on, (e) => e.bg(t.accent + "14"))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(text);
    const seg = (id, options, current, pick) => h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(fs.meta)
      .children(options.map(([value, text], n) => div().id(`${id}-${value}`).px(10).py(3).cursor_pointer().when(n > 0, (e) => e.border_l_1().border_color(t.border))
        .when(current === value, (e) => e.bg(t.selected).font_semibold()).hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(value, cx)).child(text)));
    const section = (n, title, right, body, dim) => v_flex().rounded(8).border_1().border_color(t.border).when(Boolean(dim), (e) => e.opacity(0.55))
      .child(h_flex().gap(8).items_center().px(12).py(8).border_b_1().border_color(t.border).text_size(fs.meta).font_semibold()
        .child(div().size(18).flex_none().rounded_full().bg(t.selected).flex().items_center().justify_center().text_size(fs.tiny - 1).text_color(t.muted).child(String(n)))
        .child(div().flex_1().child(title)).when(Boolean(right), (e) => e.child(right)))
      .child(v_flex().gap(8).px(12).py(10).child(body));
    const status = (color, bg, text, right) => h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(bg).text_size(fs.meta).text_color(color)
      .child(div().size(8).flex_none().rounded_full().bg(color)).child(div().flex_1().min_w(0).child(text)).when(Boolean(right), (e) => e.child(right));
    const suggestions = (id, rows) => v_flex().id(id).mt(2).p(4).gap(1).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .children(rows.map(([key, main, side, pick]) => h_flex().id(`${id}-${key}`).h(26).px(8).gap(8).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(cx))
        .child(div().flex_none().text_size(fs.meta).child(main))
        .child(div().flex_1().min_w(0).truncate().text_size(fs.tiny).text_color(t.dim).child(side ?? ""))));

    const gh = this.ghOpen ? this.ghSuggestions() : [];
    const a = this.auth, site = cleanSite(this.site.value());
    const signedIn = a.state === "in" && a.site === site;
    const jira = this.issues === "jira";
    const filter = this.filter.value().trim();
    const preset = this.custom ? "custom" : PRESETS.find(([, , q]) => norm(q) === norm(filter))?.[0] ?? "custom";
    const showForm = jira && site && (!signedIn || this.showForm) && a.state !== "checking";

    const jiraStatus = !site ? null
      : a.state === "checking" ? status(t.dim, t.surface, "Checking the sign-in…")
      : signedIn ? status(t.ansi2, t.ansi2 + "1a", h_flex().gap(4).child("Connected to").child(div().font_semibold().child(site)).child(`as ${a.who}`),
        h_flex().gap(6).items_center().child(hint(a.from, t.ansi2)).child(button("change", this.showForm ? "Hide" : "Change", "link", (cx) => { this.showForm = !this.showForm; cx.notify(); })))
      : a.state === "refused" ? status(t.ansi1, t.ansi1 + "14", `Jira doesn't accept the sign-in from ${a.from ?? "the credential store or environment"}: connect again with a classic token.`)
      : a.state === "error" ? status(t.ansi1, t.ansi1 + "14", a.message)
      : a.state === "untrusted" ? status(t.ansi3, t.ansi3 + "14", `${site} isn't an Atlassian Cloud host. Connect or Save lets the mods send your sign-in there.`)
      : status(t.muted, t.surface, "Not connected to this site yet");

    const form = v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(v_flex().gap(4).child(label("Email")).child(box(this.email, false)))
      .child(v_flex().gap(4)
        .child(h_flex().child(div().flex_1().child(label("API token"))).child(button("token-page", "Create a token ↗", "link", () => openUrl(TOKEN_PAGE))))
        .child(box(this.token, false)))
      .when(Boolean(this.connectError), (e) => e.child(hint(this.connectError, t.ansi1)))
      .child(hint(`Tested against Jira, then stored in ${STORE[os]}. Never in Herdr's settings.`))
      .child(h_flex().gap(8).items_center().justify_end()
        .when(signedIn, (e) => e.child(button("disconnect", "Remove sign-in", null, (cx) => this.disconnect(cx))))
        .child(button("connect", this.connecting ? "Testing…" : "Connect", "blue", (cx) => this.connect(cx))));

    // Linear: the key's state and a Connect form, like Jira's.
    const L = this.lin;
    const linStatus = L.state === "checking" ? status(t.dim, t.surface, "Checking the Linear key…")
      : L.state === "in" ? status(t.ansi2, t.ansi2 + "1a", h_flex().gap(4).child("Connected to Linear as").child(div().font_semibold().child(L.who)),
        h_flex().gap(6).items_center().child(hint(L.from, t.ansi2)).child(button("lin-change", this.linForm ? "Hide" : "Change", "link", (cx) => { this.linForm = !this.linForm; cx.notify(); })))
      : L.state === "refused" ? status(t.ansi1, t.ansi1 + "14", "Linear doesn't accept the stored key: connect again.")
      : L.state === "error" ? status(t.ansi1, t.ansi1 + "14", L.message)
      : status(t.muted, t.surface, "No Linear key yet");
    const linearBody = v_flex().gap(8).child(linStatus)
      .when(L.state !== "in" || this.linForm, (e) => e.child(v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(v_flex().gap(4)
          .child(h_flex().child(div().flex_1().child(label("Personal API key"))).child(button("lin-key-page", "Create a key ↗", "link", () => openUrl(LINEAR_KEY_PAGE))))
          .child(box(this.linKey, false)))
        .when(Boolean(this.linError), (e) => e.child(hint(this.linError, t.ansi1)))
        .child(hint(`Tested against Linear, then stored in ${STORE[os]}. Never in Herdr's settings.`))
        .child(h_flex().gap(8).items_center().justify_end()
          .when(L.state === "in", (e) => e.child(button("lin-disconnect", "Remove key", null, (cx) => cx.spawn(async (cx) => { await disconnectLinear(); this.linForm = true; this.checkLinear(cx); }))))
          .child(button("lin-connect", this.connecting ? "Testing…" : "Connect", "blue", (cx) => this.connectLinear(cx))))));

    return v_flex().id("space-link").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.ghOpen || this.jiraOpen || this.linOpen) { this.ghOpen = false; this.jiraOpen = false; this.linOpen = false; cx.notify(); } else this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.save(cx); cx.stop_propagation(); }
      })
      .child(v_flex().flex_none().gap(3).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
        .child(div().font_semibold().text_size(fs.title + 1).child("Link space"))
        .child(h_flex().gap(4).text_size(fs.meta).text_color(t.muted).min_w(0)
          .child(div().font_semibold().text_color(t.foreground).child(this.space?.name ?? "?"))
          .child(div().min_w(0).truncate().child("and its worktrees: where its pull requests and issues come from."))))
      .child(v_flex().id("space-link-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
        .child(section(1, "GitHub repository", null, v_flex().gap(4)
          .child(box(this.github, this.ghOpen))
          .when(gh.length > 0, (e) => e.child(suggestions("gh", gh.map((r) => [r, r, this.repos.includes(r) ? "" : "search", (cx) => {
            this.set("github", this.github, r); this.ghOpen = false; this.seq.github = (this.seq.github ?? 0) + 1; cx.notify();
          }]))))
          .child(this.ghSignedOut ? hint("gh is not signed in: run `gh auth login` in a terminal, then reopen this dialog.", t.ansi1)
            : h_flex().gap(6).items_center().child(div().size(8).rounded_full().bg(this.ghLogin ? t.ansi2 : t.dim))
              .child(hint(this.ghLogin ? `gh is signed in as ${this.ghLogin} · empty uses the folder's remote` : "Empty uses the folder's remote")))))
        .child(section(2, "Issues from", seg("issues", [["jira", "Jira"], ["linear", "Linear"], ["github", "GitHub"]], this.issues, (v, cx) => { this.issues = v; cx.notify(); }),
          jira ? v_flex().gap(8)
            .child(v_flex().gap(4).child(label("Jira site")).child(box(this.site, false)))
            .when(Boolean(jiraStatus), (e) => e.child(jiraStatus))
            .when(Boolean(showForm), (e) => e.child(form))
          : this.issues === "linear" ? linearBody
          : v_flex().gap(4).child(label("GitHub issue filter (optional)")).child(box(this.ghFilter, false))
            .child(hint("GitHub search, e.g. label:bug milestone:v2"))
            .when(Boolean(this.ghFilterError), (e) => e.child(hint(this.ghFilterError, t.ansi1)))))
        .when(this.issues === "linear", (e) => e.child(section(3, "Team and filter", null, v_flex().gap(10)
          .child(v_flex().gap(4).child(label("Team")).child(box(this.linTeam, this.linOpen))
            .when(this.linOpen && this.teams.length > 0, (e) => e.child(suggestions("lin", this.teams.map((tm) => [tm.id, tm.key, tm.name, (cx) => {
              this.linChosen = tm; this.linOpen = false; this.set("linTeam", this.linTeam, tm.key); this.seq.linTeam = (this.seq.linTeam ?? 0) + 1; cx.notify();
            }]))))
            .child(hint(this.linChosen?.name ? this.linChosen.name : this.lin.state === "in" ? "Type to search your teams." : "Connect first to search teams.")))
          .child(v_flex().gap(4).child(label("Show"))
            .child(h_flex().gap(6).flex_wrap().children(LINEAR_PRESETS.map(([v, text]) => chip(`lf-${v || "all"}`, text, this.linFilter === v, (cx) => { this.linFilter = v; cx.notify(); }))))), this.lin.state !== "in")))
        .when(jira, (e) => e.child(section(3, "Project and filter", null, v_flex().gap(10)
          .child(v_flex().gap(4)
            .child(label("Project"))
            .child(box(this.project, this.jiraOpen))
            .when(this.jiraOpen && signedIn && this.projects.length > 0, (e) => e.child(suggestions("jira", this.projects.map((p) => [p.key, p.key, `${p.name}${p.key === this.guess ? " (from the branch)" : ""}`, (cx) => this.choose(p, cx)]))))
            .child(hint(this.chosen?.name ? this.chosen.name : signedIn ? (this.projects.length && this.jiraOpen ? "Pick one from the list, or type its key." : "Type a few letters to search your projects.") : "Connect first to search projects; a typed key works too.")))
          .child(v_flex().gap(4)
            .child(label("Show"))
            .child(h_flex().gap(6).flex_wrap()
              .children(PRESETS.map(([id, text, q]) => chip(`f-${id}`, text, preset === id, (cx) => { this.custom = false; this.filter.set_value(q); this.filterError = ""; cx.notify(); })))
              .child(chip("f-custom", "Custom JQL…", preset === "custom", (cx) => { this.custom = true; cx.notify(); })))
            .when(preset === "custom", (e) => e.child(box(this.filter, false)).child(hint("JQL that narrows the project's open issues, e.g. labels = backend")))
            .when(Boolean(this.filterError), (e) => e.child(hint(this.filterError, t.ansi1)))), !site)))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface)
        .child(button("guide", "How to connect ↗", "link", () => openUrl(this.issues === "linear" ? "https://github.com/jslowack/herdr-ranch#connect-linear" : this.issues === "github" ? "https://github.com/jslowack/herdr-ranch#link-a-space" : GUIDE)))
        .child(div().flex_1())
        .child(button("cancel", "Cancel", null, () => this.close()))
        .child(button("save", this.saving ? "Checking the filter…" : "Save  ⌘↵", "primary", (cx) => this.save(cx))));
  }
}
