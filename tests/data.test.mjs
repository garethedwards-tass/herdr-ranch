// The pure parts of the lists: issue rows, ADF to Markdown, GitHub label priorities, and
// what each pull request waits on. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { listExec } from "./stubs/pr-graphql.mjs";
import { rows, haystack, words, matches } from "../herdr-ranch-issues/mods/herdr-ranch-issues/rows.js";
import { adfToMarkdown } from "../herdr-ranch-issues/mods/herdr-ranch-issues/adf.js";
import { search as githubSearch } from "../herdr-ranch-issues/mods/herdr-ranch-issues/github.js";
import { list as listPrs, GROUPS as PR_GROUPS } from "../herdr-ranch-prs/mods/herdr-ranch-prs/data.js";

// An issue in the shape the Jira, Linear and GitHub sides all return.
const issue = (key, { priority, parent, summary = `Issue ${key}`, status = "To Do", assignee, labels = [], type = "Task" } = {}) => ({
  key,
  fields: {
    summary, labels,
    priority: priority ? { name: priority } : null,
    parent: parent ? { key: parent } : null,
    status: { name: status },
    assignee: assignee ? { displayName: assignee } : null,
    issuetype: { name: type },
  },
});
const all = () => true;
// [group id, [[key, depth], ...]] per group, for short assertions.
const shape = (groups) => groups.map((g) => [g.id, g.rows.map((r) => [r.issue.key, r.depth])]);

test("rows: priority names map to their group", () => {
  const cases = [
    ["Highest", "high"], ["High", "high"], ["Blocker", "high"], ["Critical", "high"],
    ["Medium", "medium"], ["Major", "medium"],
    ["Low", "low"], ["Lowest", "low"], ["Minor", "low"], ["Trivial", "low"],
    [undefined, "none"], ["Whatever", "none"],
  ];
  for (const [name, group] of cases) {
    assert.deepEqual(shape(rows([issue("A-1", { priority: name })], all)), [[group, [["A-1", 0]]]], `${name} goes to ${group}`);
  }
});

test("rows: groups come in priority order, empty ones are left out, labels are set", () => {
  const groups = rows([issue("A-1", { priority: "Low" }), issue("A-2", { priority: "High" }), issue("A-3")], all);
  assert.deepEqual(groups.map((g) => [g.id, g.label]), [["high", "High"], ["low", "Low"], ["none", "No priority"]]);
});

test("rows: a sub-task sits under its parent in the same group, at any depth", () => {
  const list = [
    issue("A-3", { priority: "High", parent: "A-2" }),
    issue("A-1", { priority: "High" }),
    issue("A-2", { priority: "High", parent: "A-1" }),
    issue("A-4", { priority: "High", parent: "NOT-LISTED" }),
  ];
  assert.deepEqual(shape(rows(list, all)), [["high", [["A-1", 0], ["A-2", 1], ["A-3", 2], ["A-4", 0]]]]);
});

test("rows: a sub-task in another priority group than its parent stays at the top of its own group", () => {
  const groups = rows([issue("A-1", { priority: "High" }), issue("A-2", { priority: "Low", parent: "A-1" })], all);
  assert.deepEqual(shape(groups), [["high", [["A-1", 0]]], ["low", [["A-2", 0]]]]);
});

test("rows: backlog order is one group in the given order, with nesting", () => {
  const list = [issue("A-2", { priority: "Low" }), issue("A-1", { priority: "High" }), issue("A-3", { parent: "A-2" })];
  assert.deepEqual(shape(rows(list, all, "backlog")), [["backlog", [["A-2", 0], ["A-3", 1], ["A-1", 0]]]]);
});

test("rows: a match keeps its parent in view, the rest is filtered out", () => {
  const list = [issue("A-1", { priority: "High" }), issue("A-2", { priority: "High", parent: "A-1" }), issue("A-3", { priority: "High" })];
  assert.deepEqual(shape(rows(list, (i) => i.key === "A-2")), [["high", [["A-1", 0], ["A-2", 1]]]]);
  assert.deepEqual(rows(list, () => false), []);
});

test("search: every word must match, a capital makes that word case-sensitive", () => {
  const hay = haystack(issue("RKT-7", { summary: "Login fails on Safari", status: "In Progress", assignee: "Ada Lovelace", labels: ["frontend"], type: "Bug" }));
  const cases = [
    ["login", true], ["Login", true], ["LOGIN", false], ["safari fails", true],
    ["rkt-7", true], ["RKT-7", true], ["progress", true], ["ada", true], ["frontend", true], ["bug", true],
    ["login chrome", false], ["", true], ["   ", true],
  ];
  for (const [query, expected] of cases) assert.equal(matches(hay, words(query)), expected, JSON.stringify(query));
});

test("words: splits on any whitespace and drops empties", () => {
  assert.deepEqual(words("  a\tb \n c  "), ["a", "b", "c"]);
});

// ADF builders.
const doc = (...content) => ({ type: "doc", version: 1, content });
const p = (...content) => ({ type: "paragraph", content });
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const li = (...content) => ({ type: "listItem", content });

test("adfToMarkdown: table of cases", () => {
  const cases = [
    ["nothing", null, ""],
    ["a string stays as is", "plain *text*", "plain *text*"],
    ["paragraphs are separated by a blank line", doc(p(t("one")), p(t("two"))), "one\n\ntwo"],
    ["an empty paragraph is dropped", doc(p(t("one")), p(), p(t("two"))), "one\n\ntwo"],
    ["a hard break", doc(p(t("a"), { type: "hardBreak" }, t("b"))), "a  \nb"],
    ["a heading", doc({ type: "heading", attrs: { level: 3 }, content: [t("Title")] }), "### Title"],
    ["marks", doc(p(t("b", [{ type: "strong" }]), t(" "), t("i", [{ type: "em" }]), t(" "), t("s", [{ type: "strike" }]), t(" "), t("c", [{ type: "code" }]))), "**b** _i_ ~~s~~ `c`"],
    ["a link", doc(p(t("docs", [{ type: "link", attrs: { href: "https://example.com" } }]))), "[docs](https://example.com)"],
    ["a link without href keeps the text", doc(p(t("docs", [{ type: "link", attrs: {} }]))), "docs"],
    ["an inline card", doc(p({ type: "inlineCard", attrs: { url: "https://example.com/x" } })), "<https://example.com/x>"],
    ["a mention uses its text", doc(p(t("ping "), { type: "mention", attrs: { id: "1", text: "@Ada" } })), "ping @Ada"],
    ["a mention without text", doc(p({ type: "mention", attrs: { id: "1" } })), "@someone"],
    ["an emoji", doc(p({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } })), "😄"],
    ["a status lozenge", doc(p({ type: "status", attrs: { text: "DONE" } })), "[DONE]"],
    ["a date", doc(p({ type: "date", attrs: { timestamp: "1700000000000" } })), "2023-11-14"],
    ["a bullet list", doc({ type: "bulletList", content: [li(p(t("a"))), li(p(t("b")))] }), "- a\n- b"],
    ["an ordered list starts at its order", doc({ type: "orderedList", attrs: { order: 3 }, content: [li(p(t("a"))), li(p(t("b")))] }), "3. a\n4. b"],
    ["a nested list is indented", doc({ type: "bulletList", content: [li(p(t("a")), { type: "bulletList", content: [li(p(t("a1")))] })] }), "- a\n  - a1"],
    ["a task list", doc({ type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [t("x")] }, { type: "taskItem", attrs: { state: "TODO" }, content: [t("y")] }] }), "- [x] x\n- [ ] y"],
    ["a code block with its language", doc({ type: "codeBlock", attrs: { language: "js" }, content: [t("let a = 1;\nlet b = 2;")] }), "```js\nlet a = 1;\nlet b = 2;\n```"],
    ["a code block without a language", doc({ type: "codeBlock", content: [t("x")] }), "```\nx\n```"],
    ["a blockquote", doc({ type: "blockquote", content: [p(t("q"))] }), "> q"],
    ["a rule", doc(p(t("a")), { type: "rule" }, p(t("b"))), "a\n\n---\n\nb"],
    ["media is a placeholder", doc({ type: "mediaSingle", content: [{ type: "media", attrs: {} }] }), "_(attachment)_"],
    ["a table, pipes escaped", doc({ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("h1"))] }, { type: "tableHeader", content: [p(t("h2"))] }] },
      { type: "tableRow", content: [{ type: "tableCell", content: [p(t("a|b"))] }, { type: "tableCell", content: [p(t("c"))] }] },
    ] }), "| h1 | h2 |\n| --- | --- |\n| a\\|b | c |"],
    ["an unknown node keeps its text", doc({ type: "somethingNew", content: [p(t("kept"))] }), "kept"],
  ];
  for (const [name, input, expected] of cases) assert.equal(adfToMarkdown(input), expected, name);
});

// GitHub issues come through `gh issue list`; the stub answers with these labels.
async function githubPriorities(labelSets) {
  state.exec = (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.ok(args.includes("--state") && args[args.indexOf("--state") + 1] === "open", "only open issues are listed");
    const raw = labelSets.map((labels, n) => ({ number: n + 1, title: ` T${n + 1} `, labels: labels.map((name) => ({ name })), assignees: [], url: `https://github.com/o/r/issues/${n + 1}` }));
    return { code: 0, stdout: JSON.stringify(raw), stderr: "" };
  };
  try {
    const { issues } = await githubSearch({ repo: "o/r" }, { cwd: "/repo", on: null });
    return issues;
  } finally { state.exec = null; }
}

test("github: label to priority", async () => {
  const cases = [
    [["P0"], "High"], [["P1"], "High"], [["p1"], "High"], [["P2"], "Medium"], [["P3"], "Low"], [["P4"], "Low"],
    [["priority: high"], "High"], [["Priority: Medium"], "Medium"], [["priority/low"], "Low"],
    [["priority-0"], "High"], [["priority-2"], "Medium"], [["priority-3"], "Low"], [["priority: p1"], "High"],
    [["critical"], "High"], [["urgent"], "High"], [["blocker"], "High"], [["normal"], "Medium"], [["minor"], "Low"],
    [["bug"], null], [["enhancement"], null], [["bug", "enhancement"], null], [[], null],
    [["bug", "P1"], "High"], [["P3", "critical"], "Low"], [["P5"], null],
  ];
  const issues = await githubPriorities(cases.map(([labels]) => labels));
  cases.forEach(([labels, expected], n) => assert.equal(issues[n].fields.priority?.name ?? null, expected, JSON.stringify(labels)));
});

test("github: issues come in the shared shape, so rows groups them", async () => {
  const issues = await githubPriorities([["bug"], ["P0", "bug"]]);
  assert.equal(issues[0].key, "#1");
  assert.equal(issues[0].fields.summary, "T1", "titles are trimmed");
  assert.deepEqual(issues[0].fields.labels, ["bug"]);
  assert.equal(issues[0].fields.status.name, "Open");
  assert.deepEqual(shape(rows(issues, all)), [["high", [["#2", 0]]], ["none", [["#1", 0]]]]);
});

// Pull requests come through one GraphQL query for open and one for closed.
async function prGroups(open, closed = [], login = "me") {
  state.exec = listExec(open, closed);
  try { return await listPrs({ github: "o/r", cwd: "/repo", on: null }, login); } finally { state.exec = null; }
}
const ok = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const failed = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
const running = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
const pr = (number, o = {}) => ({ number, title: `PR ${number}`, author: { login: "me" }, state: "OPEN", isDraft: false, reviewDecision: "", reviewRequests: [], statusCheckRollup: [], headRefName: `b${number}`, ...o });

test("prs: what each pull request waits on", async () => {
  const cases = [
    ["someone asked me to review", pr(1, { author: { login: "ada" }, reviewRequests: [{ login: "me" }] }), "review"],
    ["my own, with my review requested, is not a review", pr(2, { reviewRequests: [{ login: "me" }] }), "open"],
    ["mine, changes requested", pr(3, { reviewDecision: "CHANGES_REQUESTED" }), "fix"],
    ["mine, a failing check", pr(4, { statusCheckRollup: [ok, failed] }), "fix"],
    ["a failing status context", pr(5, { statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] }), "fix"],
    ["approved, checks green", pr(6, { reviewDecision: "APPROVED", statusCheckRollup: [ok, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }] }), "ready"],
    ["someone else's, approved and green, is ready too", pr(7, { author: { login: "ada" }, reviewDecision: "APPROVED" }), "ready"],
    ["approved, a check still running", pr(8, { reviewDecision: "APPROVED", statusCheckRollup: [running] }), "open"],
    ["approved but a draft", pr(9, { reviewDecision: "APPROVED", isDraft: true }), "open"],
    ["someone else's, failing, not asked", pr(10, { author: { login: "ada" }, statusCheckRollup: [failed] }), "open"],
    ["review requested wins over failing checks", pr(11, { author: { login: "ada" }, reviewRequests: [{ login: "me" }], statusCheckRollup: [failed] }), "review"],
  ];
  const listed = await prGroups(cases.map(([, p]) => p));
  cases.forEach(([name, , group], n) => assert.equal(listed[n].group, group, name));
});

test("prs: closed and merged are recently closed, a duplicate is kept once", async () => {
  const listed = await prGroups([pr(1)], [pr(1, { state: "MERGED" }), pr(2, { state: "CLOSED" }), pr(3, { state: "MERGED" })]);
  assert.deepEqual(listed.map((p) => [p.number, p.group]), [[1, "open"], [2, "closed"], [3, "closed"]]);
});

test("prs: the groups the list shows, in order", () => {
  assert.deepEqual(PR_GROUPS.map(([id]) => id), ["review", "fix", "ready", "open", "closed"]);
});

test("prs: checks are counted per state", async () => {
  const [p] = await prGroups([pr(1, { statusCheckRollup: [ok, failed, running, { __typename: "StatusContext", state: "PENDING" }, { __typename: "StatusContext", state: "SUCCESS" }] })]);
  assert.deepEqual(p.checks, { pass: 2, fail: 1, pending: 2 });
});

test("prs: the list asks GitHub for check counts, never every check run", async () => {
  const asked = [];
  state.exec = (cmd, args) => { asked.push([cmd, args]); return listExec([pr(1)])(cmd, args); };
  try { await listPrs({ github: "o/r", cwd: "/repo", on: null }, "me"); } finally { state.exec = null; }
  assert.equal(asked.length, 2, "open and closed");
  for (const [cmd, args] of asked) {
    assert.equal(cmd, "gh");
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    const query = args.find((a) => a.startsWith("query="));
    assert.match(query, /checkRunCountsByState/);
    assert.doesNotMatch(query, /contexts\(first/, "no check runs one by one");
    assert.ok(args.includes("owner=o") && args.includes("name=r"), "the repository as variables");
  }
});

test("prs: no checks yet, a team asked to review, a deleted author", async () => {
  const [p] = await prGroups([pr(1, { author: null, reviewDecision: null, reviewRequests: [{ name: "backend" }, { login: "me" }], assignees: [{ login: "ada" }] })]);
  assert.deepEqual(p.checks, { pass: 0, fail: 0, pending: 0 });
  assert.equal(p.author.login, null);
  assert.deepEqual(p.reviewRequests.map((r) => r.login), [undefined, "me"]);
  assert.deepEqual(p.assignees, ["ada"]);
  assert.equal(p.reviewDecision, "", "GraphQL's null decision is gh's empty one");
});

test("prs: every check state counts as pass, fail or pending", async () => {
  const run = (status, conclusion = null) => ({ __typename: "CheckRun", status, conclusion });
  const ctx = (s) => ({ __typename: "StatusContext", state: s });
  const rollup = [
    ...["SUCCESS", "NEUTRAL", "SKIPPED"].map((c) => run("COMPLETED", c)),
    ...["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].map((c) => run("COMPLETED", c)),
    ...["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].map((st) => run(st)),
    ctx("SUCCESS"), ctx("FAILURE"), ctx("ERROR"), ctx("PENDING"), ctx("EXPECTED"),
  ];
  const [p] = await prGroups([pr(1, { statusCheckRollup: rollup })]);
  assert.deepEqual(p.checks, { pass: 4, fail: 8, pending: 7 });
});

test("list: each pull request carries when its newest commit was made (Pushed filter)", async () => {
  const pr = (number, pushedAt) => ({ number, title: `PR ${number}`, author: { login: "a" }, headRefName: `b${number}`, baseRefName: "main", isDraft: false, reviewDecision: "", additions: 1, deletions: 0, updatedAt: "2026-11-01T00:00:00Z", url: `u${number}`, state: "OPEN", pushedAt });
  state.exec = listExec([pr(1, "2026-11-12T10:00:00Z"), pr(2, null)]);
  try {
    const got = await listPrs({ github: "o/r", cwd: "/repo", on: null }, "me");
    assert.deepEqual(got.map((p) => [p.number, p.pushedAt]), [[1, "2026-11-12T10:00:00Z"], [2, null]]);
  } finally { state.exec = null; }
});
