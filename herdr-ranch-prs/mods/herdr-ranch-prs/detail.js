// A pull request's page, laid out like GitHub's: a header (position, actions, title, state
// badge, "wants to merge"), tabs (Conversation, Checks, Files), the conversation as a
// timeline ending in the merge box, and reviewers, assignees, labels and linked issues in a
// sidebar.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { ago } from "./data.js";
import { fs, icon, kindColor, liveAgent, AGENT_STATUS, imagesAsLinks, openUrl } from "./links.js";
import { kit, pageLayout } from "./page-kit.js";

const VERDICT = { APPROVED: ["approved", "check", "ansi2"], CHANGES_REQUESTED: ["changes requested", "x", "ansi1"], COMMENTED: ["commented", "comment", "muted"], DISMISSED: ["dismissed", "x", "dim"], REQUESTED: ["requested", "pending", "ansi3"] };
const KEY = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{1,19}-\d+(?![0-9])/g;

// Markdown is laid out again on every render, and a long text takes the render past the
// app's time limit ("interrupted"), so pages show the start and link to the rest.
const MAX = 2000;
const short = (text) => {
  const t = imagesAsLinks(text?.trim() ?? "");
  return t.length <= MAX ? t : `${t.slice(0, t.lastIndexOf("\n", MAX) > MAX / 2 ? t.lastIndexOf("\n", MAX) : MAX)}\n\n_… the rest is on GitHub._`;
};

// The timeline in time order: comments, reviews with a body or verdict, and events.
// Worked out once when the page loads (`prepare`), not on every render.
function conversation(pr) {
  const items = [
    ...(pr.comments ?? []).map((c) => ({ who: c.author?.login, at: c.createdAt, body: short(c.body) || " ", verdict: null })),
    ...(pr.reviews ?? []).filter((r) => r.body || r.state !== "COMMENTED")
      .map((r) => ({ who: r.author?.login, at: r.submittedAt, body: short(r.body), verdict: r.state })),
    ...(pr.events ?? []),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// What the page draws from a loaded pull request, worked out once.
export function prepare(pr) {
  const keys = [...new Set(`${pr.title} ${pr.headRefName} ${(pr.body ?? "").slice(0, 2000)}`.match(KEY) ?? [])].slice(0, 3);
  const out = { ...pr, body: short(pr.body), conversation: conversation(pr), keys, commentCount: (pr.comments ?? []).length };
  delete out.comments; delete out.reviews; delete out.events;
  return out;
}

// `pr` is a prepared page, or the list's row (`loading: true`) until the page arrives: the
// header shows at once and the rest says it is loading. `a`: { error, nav, open, review,
// copyBranch, tab, pickTab, wide, login, jira (site), jiraIssues, keys (footer) }.
export function detail(pr, t, a) {
  const k = kit(t), loading = Boolean(pr.loading);
  const state = pr.state === "MERGED" ? ["Merged", "merged", t.ansi5] : pr.state === "CLOSED" ? ["Closed", "closed", t.ansi1]
    : pr.isDraft ? ["Draft", "draft", t.dim] : ["Open", "pr", t.ansi2];
  const checks = pr.statusCheckRollup ?? [];
  const n = { pass: 0, fail: 0, pending: 0 };
  for (const c of checks) n[c.state]++;
  const files = pr.files ?? [];
  const tab = loading ? "conversation" : a.tab;
  const color = { pass: t.ansi2, fail: t.ansi1, pending: t.ansi3 };

  const merge = () => {
    const row = (id, c, glyph, title, sub, click) => h_flex().id(id).gap(10).items_center().px(12).py(9).border_b_1().border_color(t.border)
      .when(Boolean(click), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)))
      .child(div().size(26).flex_none().rounded_full().bg(c).flex().items_center().justify_center().child(icon(glyph, t.background, 14)))
      .child(v_flex().flex_1().min_w(0).child(div().font_semibold().text_size(fs.body).child(title)).child(div().text_size(fs.meta).text_color(t.muted).child(sub)));
    const asked = (pr.reviewers ?? []).some((r) => r.login === a.login && r.state === "REQUESTED");
    const rows = [];
    // A merged or closed pull request needs only its outcome.
    if (pr.state === "MERGED" || pr.state === "CLOSED") {
      rows.push(pr.state === "MERGED" ? row("m-merge", t.ansi5, "merged", "Merged", pr.mergedAt ? `${ago(pr.mergedAt)} ago` : "This pull request is merged.")
        : row("m-merge", t.ansi1, "closed", "Closed without merging", "Reopen it on GitHub to continue."));
      return v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().ml(38).children(rows);
    }
    if (checks.length) rows.push(n.fail ? row("m-checks", t.ansi1, "x", `${n.fail} failing check${n.fail > 1 ? "s" : ""}`, `${n.pass} passed, ${n.pending} running · see Checks`, (cx) => a.pickTab("checks", cx))
      : n.pending ? row("m-checks", t.ansi3, "pending", `${n.pending} check${n.pending > 1 ? "s" : ""} running`, `${n.pass} passed so far · see Checks`, (cx) => a.pickTab("checks", cx))
      : row("m-checks", t.ansi2, "check", "All checks have passed", `${n.pass} successful check${n.pass > 1 ? "s" : ""}`, (cx) => a.pickTab("checks", cx)));
    const d = pr.reviewDecision;
    rows.push(d === "APPROVED" ? row("m-review", t.ansi2, "check", "Approved", "The required reviews are in.")
      : d === "CHANGES_REQUESTED" ? row("m-review", t.ansi1, "x", "Changes requested", "A reviewer asked for changes.")
      : d === "REVIEW_REQUIRED" ? row("m-review", t.ansi3, "pending", "Review required", asked ? "You were asked to review." : "At least one approving review is needed.")
      : row("m-review", t.dim, "comment", "No review required", asked ? "You were asked to review." : "Reviews are optional here."));
    const ms = pr.mergeStateStatus;
    const [mc, mi, mt] = pr.state === "MERGED" ? [t.ansi5, "merged", "Merged"] : pr.state === "CLOSED" ? [t.ansi1, "closed", "Closed without merging"]
      : ms === "CLEAN" ? [t.ansi2, "check", "Ready to merge"] : ms === "DIRTY" ? [t.ansi1, "x", "This branch has conflicts"]
      : ms === "BEHIND" ? [t.ansi3, "pending", `Behind ${pr.baseRefName ?? "the base branch"}`] : ms === "UNSTABLE" ? [t.ansi3, "pending", "Can merge, with failing checks"]
      : ms === "DRAFT" || pr.isDraft ? [t.dim, "draft", "Draft: not ready for review"] : [t.dim, "x", "Merging is blocked"];
    rows.push(row("m-merge", mc, mi, mt, "Merge on GitHub: these mods never write to GitHub."));
    return v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().ml(38).children(rows);
  };

  const conversationTab = () => [
    k.card("pr-body", pr.author?.login, "opened", pr.createdAt ? `${ago(pr.createdAt)} ago` : "", TextView.markdown(`body-${pr.number}`, pr.body || "_No description._").selectable(true).on_link_click((url) => openUrl(url))),
    ...pr.conversation.map((c, i) => (c.text != null
      ? k.event(`ev-${pr.number}-${i}`, c.who, c.text, `${ago(c.at)} ago`, c.color && t[c.color])
      : k.card(`cv-${pr.number}-${i}`, c.who, c.verdict ? h_flex().gap(6).items_center().child("reviewed").child(k.pill(VERDICT[c.verdict]?.[0] ?? c.verdict.toLowerCase(), t[VERDICT[c.verdict]?.[2]] ?? t.muted)) : "commented",
        c.at ? `${ago(c.at)} ago` : "", c.body ? TextView.markdown(`comment-${pr.number}-${i}`, c.body).selectable(true).on_link_click((url) => openUrl(url)) : div().text_size(fs.meta).text_color(t.dim).child("No comment.")))),
    merge(),
  ];
  const checksTab = () => [checks.length
    ? v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().children(checks.map((c, i) => h_flex().id(`check-${i}`).gap(8).items_center().px(12).py(6)
      .when(i > 0, (e) => e.border_t_1().border_color(t.border)).text_size(fs.meta)
      .child(icon(c.state === "pass" ? "check" : c.state === "fail" ? "x" : "pending", color[c.state], 13))
      .child(div().flex_1().min_w(0).truncate().child(c.name))
      .child(div().text_color(t.dim).child(c.label))))
    : div().text_color(t.dim).child("No checks ran on this pull request.")];
  const filesTab = () => [files.length
    ? v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().children(files.map((f, i) => h_flex().id(`file-${i}`).gap(8).items_center().px(12).py(5)
      .when(i > 0, (e) => e.border_t_1().border_color(t.border)).text_size(fs.meta)
      .child(div().flex_1().min_w(0).truncate().font_family("Menlo").child(f.path))
      .child(div().flex_none().text_color(t.ansi2).child(`+${f.additions}`))
      .child(div().flex_none().w(44).text_right().text_color(t.ansi1).child(`−${f.deletions}`))))
      .when(pr.changedFiles > files.length, (e) => e.child(div().text_size(fs.meta).text_color(t.dim).child(`${pr.changedFiles - files.length} more files are on GitHub.`)))
    : div().text_color(t.dim).child("No files.")];

  const people = (logins) => (logins?.length ? v_flex().gap(5).children(logins.map((l) => k.person(l))) : div().text_size(fs.meta).text_color(t.dim).child("Nobody"));
  const issues = [
    ...(pr.issues ?? []).map((i) => ({ id: `gi-${i.number}`, label: `#${i.number}`, title: i.repo && i.repo !== a.github ? i.repo : "", url: i.url, kind: "issue" })),
    // Only keys of the space's linked Jira project: "UTF-8" or "SHA-256" in a title aren't issues.
    ...(pr.keys ?? []).filter((key) => a.jiraKey && key.startsWith(`${a.jiraKey}-`)).map((key) => {
      const j = a.jiraIssues?.[key];
      return { id: `ji-${key}`, label: key, title: j?.summary ?? "", url: a.jira ? `https://${a.jira}/browse/${key}` : null, kind: j?.kind ?? "issue", done: j?.done };
    }),
  ];
  const lead = liveAgent(a.agents);
  const side = loading ? [k.agents(a.agents, a.go)] : [
    k.agents(a.agents, a.go),
    k.section("Reviewers", (pr.reviewers ?? []).length ? v_flex().gap(5).children(pr.reviewers.map((r) => {
      const [label, glyph, c] = VERDICT[r.state] ?? [r.state.toLowerCase(), "comment", "muted"];
      return h_flex().gap(6).items_center().min_w(0).child(div().flex_1().min_w(0).child(k.person(r.login, r.login === a.login ? `${r.login} (you)` : r.login)))
        .child(h_flex().flex_none().gap(3).items_center().text_size(fs.tiny).text_color(t[c] ?? t.muted).child(icon(glyph, t[c] ?? t.muted, 12)).child(label));
    })) : div().text_size(fs.meta).text_color(t.dim).child("Nobody asked")),
    k.section("Assignees", people(pr.assignees)),
    (pr.labels ?? []).length > 0 && k.section("Labels", h_flex().flex_wrap().gap(4).children(pr.labels.map((l) => k.label(l)))),
    k.section("Development", issues.length ? v_flex().gap(4).children(issues.map((x) => h_flex().id(x.id).gap(6).items_center().min_w(0).text_size(fs.meta)
        .when(Boolean(x.url), (e) => e.cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => a.openUrl(x.url)))
        .child(icon(x.kind, kindColor(x.kind, t), 13)).child(div().flex_none().text_color(t.dim).child(x.label))
        .child(div().min_w(0).truncate().when(Boolean(x.done), (e) => e.line_through().text_color(t.muted)).child(x.title))))
      : div().text_size(fs.meta).text_color(t.dim).child("No linked issue")),
    k.section("Changes", h_flex().gap(6).text_size(fs.meta).child(div().text_color(t.ansi2).child(`+${pr.additions}`)).child(div().text_color(t.ansi1).child(`−${pr.deletions}`))
      .when(pr.changedFiles != null, (e) => e.child(div().text_color(t.dim).child(`${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`)))),
  ];

  const commits = pr.commitCount ? `${pr.commitCount} commit${pr.commitCount > 1 ? "s" : ""}` : "";
  return pageLayout({
    id: "pr-detail", t, wide: a.wide, nav: a.nav,
    actions: [
      k.button("pr-open", "Open on GitHub", a.open, { hint: "O" }),
      ...(lead ? [
        ...(pr.state === "OPEN" && a.review && !loading ? [k.button("pr-review", "Start another", a.review)] : []),
        k.button("pr-go", `Go to agent · ${AGENT_STATUS[lead.status]?.[0] ?? "idle"}`, () => a.go(lead.id), { primary: true, icon: "bot", hint: "⌘↵" }),
      ] : pr.state === "OPEN" && a.review && !loading ? [k.button("pr-review", "Agent review", a.review, { primary: true, icon: "bot", hint: "⌘↵" })] : []),
    ],
    title: pr.title, key: `#${pr.number}`,
    status: h_flex().gap(6).items_center().flex_wrap().text_size(fs.meta).text_color(t.muted)
      .child(k.badge(state[0], state[2], state[1]))
      .child(div().font_semibold().text_color(t.foreground).child(pr.author?.login ?? "?"))
      .child(pr.state === "MERGED" ? `merged ${commits}` : `wants to merge ${commits}`).when(Boolean(pr.baseRefName), (e) => e.child("into").child(k.code(pr.baseRefName)))
      .child("from").child(k.code(pr.headRefName ?? ""))
      .child(div().id("copy-branch").cursor_pointer().rounded(4).p(2).hover((s) => s.bg(t.hover)).on_click((_e, cx) => a.copyBranch(cx)).child(icon("copy", t.muted, 13))),
    tabs: k.tabs(tab, [["conversation", "Conversation", loading ? null : pr.commentCount], ["checks", "Checks", loading ? null : checks.length], ["files", "Files", loading ? null : pr.changedFiles ?? files.length]], a.pickTab),
    main: loading ? [div().p(10).text_color(a.error ? t.ansi1 : t.dim).child(a.error ?? "Loading the description, checks and conversation…")]
      : tab === "checks" ? checksTab() : tab === "files" ? filesTab() : conversationTab(),
    side,
    footer: k.footer(a.keys),
  });
}
