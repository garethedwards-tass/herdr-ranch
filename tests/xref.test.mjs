// Links between History, Pull requests and Issues (shared/xref.js), and History's git calls for
// them. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { ticketKeys, jiraSite, jiraSiteFor, jiraUrl, prRefs, closingRefs, githubFromRemote, linkFor, prefixesFor, repoOfUrl, sameRepo, takeOpen, openIn, reveal, mentionPattern, mentionArgs, commitsMentioning, MODS } from "../shared/xref.js";
import { repoOf, one, prsOf, mainOf } from "../herdr-ranch-history/mods/herdr-ranch-history/git.js";

const US = "\x1f", RS = "\x1e";

test("ticketKeys: any key but known words, each once, in order", () => {
  assert.deepEqual(ticketKeys("TASS-12 fix, see TASS-9 and TASS-12; UTF-8 and SHA-256 aren't tickets"), ["TASS-12", "TASS-9"]);
  assert.deepEqual(ticketKeys("TASS-12x and a-1 and TASS_1"), []);
  assert.deepEqual(ticketKeys("feature/TASS-7_fix"), ["TASS-7"]);
});

test("ticketKeys: with the linked prefixes, only those, in any case", () => {
  assert.deepEqual(ticketKeys("tass-12: refactor ABC-3, XTASS-5, TASS-1234", ["TASS"]), ["TASS-12", "TASS-1234"]);
  assert.deepEqual(prefixesFor({ jira: { key: "TASS" }, linear: { key: "ENG" } }), ["TASS", "ENG"]);
  assert.equal(prefixesFor({ github: "a/b" }), null);
});

test("prRefs: GitHub's merge commit and a squash merge's (#n)", () => {
  assert.deepEqual(prRefs("Merge pull request #42 from me/branch"), [42]);
  assert.deepEqual(prRefs("feat(prs): a Pushed filter (#16)"), [16]);
  assert.deepEqual(prRefs("Bump to #3 in the list"), []);
});

test("closingRefs: only issues a message closes", () => {
  assert.deepEqual(closingRefs("Fixes #4, closes: #12 and resolved #7; see #9"), [4, 12, 7]);
});

test("githubFromRemote and repoOfUrl", () => {
  assert.equal(githubFromRemote("git@github.com:jslowack/herdr-ranch.git"), "jslowack/herdr-ranch");
  assert.equal(githubFromRemote("https://github.com/jslowack/herdr-ranch\n"), "jslowack/herdr-ranch");
  assert.equal(githubFromRemote("https://gitlab.com/a/b.git"), null);
  assert.equal(repoOfUrl("https://github.com/a/b/pull/3"), "a/b");
  assert.ok(sameRepo("A/b", "a/B"));
});

test("linkFor: the Link space entry of a repository on its machine", () => {
  state.shared["space-links"] = { s1: { main: "/r", on: null, github: "a/b" }, s2: { main: "/r", on: "vps", github: "c/d" } };
  assert.equal(linkFor("/r", null).github, "a/b");
  assert.equal(linkFor("/r", "vps").github, "c/d");
  assert.equal(linkFor("/x", null), null);
});

test("takeOpen: a fresh request for this mod, once", () => {
  state.shared["ranch-open"] = { to: MODS.prs, what: { number: 3 }, seq: "s1", at: Date.now() };
  assert.equal(takeOpen(MODS.issues, null), null);
  assert.equal(takeOpen(MODS.prs, null).what.number, 3);
  // Taken: a second copy (the panel and a tab) doesn't open it again.
  assert.equal(takeOpen(MODS.prs, null), null);
  state.shared["ranch-open"] = { to: MODS.prs, what: { number: 4 }, seq: "s2", at: Date.now() };
  assert.equal(takeOpen(MODS.prs, "s2"), null);
  state.shared["ranch-open"] = { to: MODS.prs, what: { number: 5 }, seq: "s3", at: Date.now() - 60000 };
  assert.equal(takeOpen(MODS.prs, null), null);
});

test("reveal: the side panel, the mod's tab when it opens as a tab, else a new tab", () => {
  state.layout = { id: "root", children: [{ id: "panel", children: [{ id: "panel-body", type: "stack", children: [{ id: "files" }, { id: "herdr-ranch-issues", content: { mod: "herdr-ranch-issues" } }] }] }] };
  state.spaces = [{ id: "p1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }];
  state.panes = [{ tab: "t2", mod: "herdr-ranch-prs" }];
  state.ran = []; reveal("herdr-ranch-issues");
  assert.deepEqual(state.ran, [["layout.select", { stack: "panel-body", child: "herdr-ranch-issues" }], ["layout.show", { id: "panel" }]]);
  state.ran = []; reveal("herdr-ranch-prs");
  assert.deepEqual(state.ran, [["tab.select", { id: "t2" }]]);
  state.ran = []; reveal("herdr-ranch-history");
  assert.deepEqual(state.ran, [["tab.new", { name: "History", mod: "herdr-ranch-history", props: { space: "p1" } }]]);
  // "Opens in: Tab" picks the tab over a panel block.
  state.panes = [{ tab: "t1", mod: "herdr-ranch-issues" }];
  state.shared["mod-settings"] = { "herdr-ranch-issues": { opens: "tab" } };
  state.ran = []; openIn("herdr-ranch-issues", { key: "TASS-1" });
  assert.deepEqual(state.ran, [["tab.select", { id: "t1" }]]);
  assert.equal(state.shared["ranch-open"].what.key, "TASS-1");
  delete state.shared["mod-settings"]; state.layout = null; state.panes = []; state.spaces = [];
});

test("commitsMentioning: a whole-word grep on every branch, parsed", async () => {
  assert.equal(mentionPattern("TASS-12"), "(^|[^A-Za-z0-9_])TASS-12([^0-9]|$)");
  assert.equal(mentionPattern("#12"), "#12([^0-9]|$)");
  assert.ok(mentionArgs("TASS-12").includes("--all"));
  let got;
  state.exec = (cmd, args) => { got = [cmd, args]; return { code: 0, stdout: `${"a".repeat(40)}${US}aaaaaaa${US}Ann${US}2026-11-12T10:00:00+10:00${US}TASS-12 fix it${RS}\n`, stderr: "" }; };
  const list = await commitsMentioning("TASS-12", { main: "/r", on: null });
  assert.equal(got[0], "git");
  assert.ok(got[1].includes("--grep=(^|[^A-Za-z0-9_])TASS-12([^0-9]|$)"));
  assert.deepEqual(list.map((c) => [c.short, c.title, c.author]), [["aaaaaaa", "TASS-12 fix it", "Ann"]]);
  state.exec = () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  assert.deepEqual(await commitsMentioning("TASS-12", { main: "/r" }), []);
  assert.deepEqual(await commitsMentioning("TASS-12", null), []);
  state.exec = null;
});

test("History: repoOf finds the main checkout of a worktree; one and prsOf", async () => {
  assert.equal(mainOf(".git", "/r"), "/r");
  assert.equal(mainOf("../../.git", "/r/src/lib"), "/r");
  assert.equal(mainOf("/r/.git", "/w/feat"), "/r");
  assert.equal(mainOf("/srv/bare.git", "/srv"), "");
  state.exec = (cmd, args) => (args[0] === "rev-parse" ? { code: 0, stdout: "/w/feat\nfeat\n/r/.git\n", stderr: "" } : null);
  assert.deepEqual(await repoOf("/w/feat", null), { top: "/w/feat", branch: "feat", main: "/r", on: null });
  state.exec = (cmd, args) => (args[0] === "log" ? { code: 0, stdout: `${"b".repeat(40)}${US}bbbbbbb${US}Ann${US}2026-11-12T10:00:00+10:00${US}p1${US}${US}Fix (#5)${RS}`, stderr: "" } : null);
  assert.equal((await one({ top: "/r" }, "bbbbbbb")).title, "Fix (#5)");
  state.exec = () => ({ code: 128, stdout: "", stderr: "fatal: bad object" });
  await assert.rejects(one({ top: "/r" }, "ccccccc"));
  state.exec = (cmd, args) => (cmd === "gh" ? { code: 0, stdout: '{"number":5,"title":"Fix","state":"closed","merged_at":"2026-11-12T00:00:00Z","draft":false}\n{"number":6,"title":"Draft","state":"open","merged_at":null,"draft":true}\n', stderr: "" } : null);
  assert.deepEqual(await prsOf({ top: "/r" }, "a/b", "b".repeat(40)), [{ number: 5, title: "Fix", state: "MERGED" }, { number: 6, title: "Draft", state: "DRAFT" }]);
  state.exec = null;
});

test("jiraSite and jiraUrl: the link's site, else the most linked one; only Jira-shaped keys", () => {
  state.shared["space-links"] = { a: { jira: { site: "one.atlassian.net" } }, b: { jira: { site: "two.atlassian.net" } }, c: { jira: { site: "two.atlassian.net" } } };
  assert.equal(jiraSite({ jira: { site: "mine.atlassian.net" } }), "mine.atlassian.net");
  assert.equal(jiraSite(null), "two.atlassian.net");
  assert.equal(jiraUrl("two.atlassian.net", "TASS-12"), "https://two.atlassian.net/browse/TASS-12");
  assert.equal(jiraUrl("two.atlassian.net", "#12"), null);
  assert.equal(jiraUrl(null, "TASS-12"), null);
  state.shared["space-links"] = {};
  assert.equal(jiraSite(null), null);
});

test("prefixesFor and jiraSiteFor: unlinked repositories use what other spaces link", () => {
  state.shared["space-links"] = { a: { jira: { site: "acme.atlassian.net", key: "TASS" } }, b: { linear: { key: "ENG" } } };
  assert.deepEqual(prefixesFor(null), ["TASS", "ENG"]);
  assert.deepEqual(ticketKeys("GPT-4 and TASS-3 and ENG-9", prefixesFor(null)), ["TASS-3", "ENG-9"]);
  assert.equal(jiraSiteFor("TASS-3", null), "acme.atlassian.net");
  assert.equal(jiraSiteFor("ENG-9", null), null);
  assert.equal(jiraSiteFor("OPS-1", { jira: { site: "mine.atlassian.net", key: "OPS" } }), "mine.atlassian.net");
  state.shared["space-links"] = {};
  assert.equal(prefixesFor(null), null);
});
