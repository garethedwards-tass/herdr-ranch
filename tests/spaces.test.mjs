// The Spaces list's git side: a place's repo and branch, worktree lists, the rows in order
// (worktree spaces under their repository, checkouts without a space after them), and labels.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { place, probe, parseWorktrees, arrange, tail, linkLabel, countStatus, workIn, checkoutAt, hasWork, workText, issueBranch, parseRefs, addArgs, worktreePath, parseStatus, switchArgs, diverged, switchRisk, stashMessage } from "../herdr-ranch-spaces/mods/herdr-ranch-spaces/git.js";
import { source, looksLikeKey } from "../herdr-ranch-spaces/mods/herdr-ranch-spaces/issues.js";
import { accountOf, setAccount, addAccount, removeAccount, checkAccount, envScript, argvAs, parseGhAccounts } from "../herdr-ranch-spaces/mods/herdr-ranch-spaces/accounts.js";

test("place: the first terminal's live folder, else the space's folder", () => {
  const s = { folder: "/made", tabs: [{ id: "t1" }] };
  assert.equal(place(s, [{ tab: "t1", cwd: "/now" }]), "/now");
  assert.equal(place(s, [{ tab: "t2", cwd: "/else" }]), "/made");
});

test("probe: a main checkout, a worktree, and outside git", async () => {
  const answer = (map) => (cmd, args) => { for (const [k, v] of Object.entries(map)) if (args.join(" ").includes(k)) return v; return { code: 1, stdout: "", stderr: "" }; };
  state.exec = answer({
    "--show-toplevel": { code: 0, stdout: "/w/herdr/feat-x\n" }, "--git-common-dir": { code: 0, stdout: "/src/herdr/.git\n" },
    "symbolic-ref": { code: 0, stdout: "refs/heads/feat/x\n" }, "rev-list": { code: 0, stdout: "2\t1\n" },
  });
  assert.deepEqual(await probe("/w/herdr/feat-x", null), { name: "herdr", branch: "feat/x", ahead: 2, behind: 1, repo: JSON.stringify([null, "/src/herdr/.git"]), main: "/src/herdr", top: "/w/herdr/feat-x", linked: true });
  state.exec = answer({ "--show-toplevel": { code: 0, stdout: "/src/herdr\n" }, "--git-common-dir": { code: 0, stdout: "/src/herdr/.git\n" }, "symbolic-ref": { code: 1, stdout: "" } });
  const main = await probe("/src/herdr", null);
  assert.equal(main.linked, false); assert.equal(main.branch, null); assert.equal(main.ahead, 0);
  state.exec = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  assert.equal(await probe("/tmp", null), null);
  state.exec = () => ({ code: 1, stdout: "", stderr: "connection lost" });
  await assert.rejects(probe("/x", "box"));
  state.exec = null;
});

test("parseWorktrees: main first, prunable and bare left out", () => {
  const got = parseWorktrees("worktree /src/r\nHEAD a\nbranch refs/heads/main\n\nworktree /w/r/feat\nHEAD b\nbranch refs/heads/feat/a\nlocked\n\nworktree /w/r/gone\nHEAD c\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\nworktree /w/r/det\nHEAD d\ndetached\n");
  assert.deepEqual(got, [
    { path: "/src/r", branch: "main", main: true, locked: false },
    { path: "/w/r/feat", branch: "feat/a", main: false, locked: true },
    { path: "/w/r/det", branch: null, main: false, locked: false },
  ]);
});

test("arrange: worktree spaces under their repo, checkouts without a space folded after them", () => {
  const R = JSON.stringify([null, "/src/r/.git"]);
  const g = (top, linked) => ({ name: "r", branch: "b", repo: R, main: "/src/r", top, linked });
  const list = [
    { w: { id: "a", machine: null }, i: 0, g: g("/w/r/a", true), at: "/w/r/a/sub" },
    { w: { id: "m", machine: null }, i: 1, g: g("/src/r", false), at: "/src/r" },
    { w: { id: "x", machine: null }, i: 2, g: null, at: "/tmp" },
  ];
  const trees = { [R]: [{ path: "/src/r", main: true }, { path: "/w/r/a" }, { path: "/w/r/b", branch: "b" }, { path: "/w/r/c", branch: "c" }] };
  const shape = (rows) => rows.map((r) => [r.kind, r.w?.id ?? r.c?.path ?? r.count, r.tree]);
  assert.deepEqual(shape(arrange(list, trees)), [["space", "m", null], ["space", "a", "├─"], ["more", 2, "└─"], ["space", "x", null]]);
  assert.deepEqual(shape(arrange(list, trees, new Set([R]))), [["space", "m", null], ["space", "a", "├─"], ["more", 2, "├─"], ["loose", "/w/r/b", "├─"], ["loose", "/w/r/c", "└─"], ["space", "x", null]]);
  // No main checkout space: the worktree space stays where it is, with nothing under it.
  assert.deepEqual(shape(arrange([list[0], list[2]], trees)), [["space", "a", null], ["space", "x", null]]);
});

test("tail: only what the name doesn't say", () => {
  assert.equal(tail({ name: "herdr", branch: "spike" }, null, "work"), "herdr · spike");
  assert.equal(tail({ name: "herdr", branch: "main" }, null, "herdr"), "");
  assert.equal(tail({ name: "herdr", branch: "master" }, null, "work"), "herdr");
  assert.equal(tail({ name: "herdr", branch: "spike" }, "├─", "spike"), "");
  assert.equal(tail({ name: "herdr", branch: null }, "└─", "x"), "detached");
  assert.equal(tail(null, null, "x"), "");
});

test("linkLabel: the issue tracker's key, else the GitHub repository", () => {
  assert.equal(linkLabel({ github: "o/repo", jira: { site: "s", key: "TASS" } }), "TASS");
  assert.equal(linkLabel({ github: "o/repo", jira: { site: "s", key: "TASS" }, issues: "github" }), "repo");
  assert.equal(linkLabel({ issues: "linear", linear: { key: "ENG" } }), "ENG");
  assert.equal(linkLabel(null), "");
});

test("work: uncommitted files and commits on no remote, read without writing under .git", async () => {
  assert.equal(countStatus(" M a.js\0?? b.txt\0"), 2);
  assert.equal(countStatus(""), 0);
  const ran = [];
  state.exec = (cmd, args) => { ran.push(args); return args.includes("status") ? { code: 0, stdout: " M a\0" } : { code: 0, stdout: "3\n" }; };
  assert.deepEqual(await workIn("/w/x", null, true), { changes: 1, unpushed: 3 });
  assert.ok(ran.find((a) => a.includes("status"))[0] === "--no-optional-locks");
  assert.ok(ran.some((a) => a.join(" ") === "rev-list --count HEAD --not --remotes"));
  // No remote: nothing counts as unpushed.
  assert.deepEqual(await workIn("/w/x", null, false), { changes: 1, unpushed: 0 });
  state.exec = null;
  assert.equal(hasWork({ changes: 0, unpushed: 0 }), false);
  assert.equal(workText({ changes: 1, unpushed: 2 }), "1 uncommitted file · 2 commits not pushed anywhere");
  assert.equal(checkoutAt([{ path: "/src/r" }, { path: "/src/r/.claude/worktrees/a" }], "/src/r/.claude/worktrees/a/sub").path, "/src/r/.claude/worktrees/a");
});

test("arrange: the fold counts the worktrees with work", () => {
  const R = JSON.stringify([null, "/src/r/.git"]);
  const list = [{ w: { id: "m", machine: null }, i: 0, g: { repo: R, main: "/src/r", linked: false }, at: "/src/r" }];
  const trees = { [R]: [{ path: "/src/r", main: true }, { path: "/w/a", changes: 2 }, { path: "/w/b", changes: 0, unpushed: 0 }] };
  const more = arrange(list, trees).find((r) => r.kind === "more");
  assert.equal(more.count, 2); assert.equal(more.busy, 1);
  assert.equal(arrange(list, trees, new Set([R])).find((r) => r.kind === "loose").main, "/src/r");
});

test("parseRefs: local branches with their checkouts, remote ones only without a local branch", () => {
  const got = parseRefs("refs/heads/main\t30\nrefs/remotes/origin/HEAD\t30\nrefs/remotes/origin/main\t30\nrefs/remotes/origin/feat/x\t20\nrefs/heads/TASS-1-a\t10\n", [{ path: "/w/t", branch: "TASS-1-a" }]);
  assert.deepEqual(got.map((b) => [b.name, b.remote, b.ref, b.path]), [["main", null, "main", null], ["feat/x", "origin", "origin/feat/x", null], ["TASS-1-a", null, "TASS-1-a", "/w/t"]]);
});

test("new worktree: branch names from issues, git worktree add's arguments, where it goes", () => {
  assert.equal(issueBranch("TASS-15439", "Request ID: add it to every log line, please"), "TASS-15439-request-id-add-it-to-every");
  assert.equal(issueBranch("#12", "Fix it"), "issue-12-fix-it");
  assert.equal(issueBranch("ENG-3", ""), "ENG-3");
  assert.deepEqual(addArgs("/p", { name: "a", exists: true }), ["worktree", "add", "/p", "a"]);
  assert.deepEqual(addArgs("/p", { name: "x", remote: "origin", ref: "origin/x" }), ["worktree", "add", "--track", "-b", "x", "/p", "origin/x"]);
  assert.deepEqual(addArgs("/p", { name: "n", fresh: true }), ["worktree", "add", "-b", "n", "/p", "HEAD"]);
  assert.equal(worktreePath("/Users/me", "tassweb", "feat/a b"), "/Users/me/.herdr/worktrees/tassweb/feat-a-b");
});

test("issues: which tracker a link reads, and what looks like a key", () => {
  assert.deepEqual(source({ jira: { site: "s.atlassian.net", key: "TASS" }, github: "o/r" }), { kind: "jira", site: "s.atlassian.net", project: "TASS" });
  assert.deepEqual(source({ jira: { site: "s", key: "T" }, issues: "github", github: "o/r" }), { kind: "github", repo: "o/r" });
  assert.deepEqual(source({ issues: "linear", linear: { teamId: "t1" } }), { kind: "linear", team: "t1" });
  assert.deepEqual(source(null, "o/detected"), { kind: "github", repo: "o/detected" });
  assert.equal(source(null, null), null);
  assert.ok(looksLikeKey("TASS-12") && looksLikeKey("#4") && !looksLikeKey("tass") && !looksLikeKey("fix-12"));
});

test("parseStatus: branch, upstream, ahead/behind and the files by kind", () => {
  const st = parseStatus("## feat/x...origin/feat/x [ahead 2, behind 3]\0M  staged.js\0 M work.js\0MM both.js\0?? new.txt\0UU clash.cfc\0");
  assert.deepEqual([st.branch, st.upstream, st.ahead, st.behind, st.gone], ["feat/x", "origin/feat/x", 2, 3, false]);
  assert.deepEqual(st.files.map((f) => [f.path, f.kind]), [["staged.js", "staged"], ["work.js", "changed"], ["both.js", "both"], ["new.txt", "untracked"], ["clash.cfc", "conflict"]]);
  assert.deepEqual([parseStatus("## main\0").branch, parseStatus("## main\0").upstream], ["main", null]);
  assert.equal(parseStatus("## HEAD (no branch)\0").branch, null);
  assert.equal(parseStatus("## a...origin/a [gone]\0").gone, true);
  assert.equal(parseStatus("## No commits yet on main\0").branch, "main");
});

test("switchArgs and diverged: switching to local, remote and new branches; a pull that can't fast-forward", () => {
  assert.deepEqual(switchArgs({ name: "a" }), ["switch", "a"]);
  assert.deepEqual(switchArgs({ name: "x", remote: "origin", ref: "origin/x" }), ["switch", "--track", "-c", "x", "origin/x"]);
  assert.deepEqual(switchArgs({ name: "n", fresh: true }), ["switch", "-c", "n"]);
  assert.ok(diverged("fatal: Not possible to fast-forward, aborting."));
  assert.ok(!diverged("fatal: couldn't find remote ref"));
});

test("switchRisk: tracked changes ask first, conflicts block, untracked files stay", () => {
  const st = parseStatus("## main\0M  a.js\0 M b.js\0?? n.txt\0");
  const r = switchRisk(st.files);
  assert.deepEqual([r.tracked.map((f) => f.path), r.conflicts.length, r.untracked], [["a.js", "b.js"], 0, 1]);
  assert.equal(switchRisk(parseStatus("## main\0UU c.js\0").files).conflicts.length, 1);
  assert.equal(switchRisk(parseStatus("## main\0?? n.txt\0").files).tracked.length, 0);
  assert.equal(stashMessage("main", "feat/x"), "herdr-ranch: main before switching to feat/x");
  assert.equal(stashMessage(null, "x"), "herdr-ranch: detached before switching to x");
});

test("accounts: per space, worktree spaces follow the repository's, removing clears its spaces", () => {
  state.shared["ranch-accounts"] = undefined;
  const work = addAccount({ label: "Work", claudeDir: "~/.claude-work", ghUser: "octo-work" });
  const repo = { main: "/src/r", on: null };
  setAccount({ id: "s1" }, repo, work);
  assert.equal(accountOf({ id: "s1" }, repo).label, "Work");
  assert.equal(accountOf({ id: "wt" }, repo).label, "Work");
  assert.equal(accountOf({ id: "other" }, { main: "/src/x", on: null }), null);
  setAccount({ id: "s1" }, repo, null);
  assert.equal(accountOf({ id: "s1" }, repo), null);
  setAccount({ id: "s1" }, repo, work);
  removeAccount(work.id);
  assert.equal(accountOf({ id: "s1" }, repo), null);
  assert.deepEqual(state.shared["ranch-accounts"], { accounts: [], spaces: {} });
});

test("accounts: checks, the sh that sets the variables (no token on the command line), gh's accounts", () => {
  assert.equal(checkAccount({ label: "Work", claudeDir: "~/.claude-work" }), "");
  assert.match(checkAccount({ label: "Work" }), /Claude Code folder, a GitHub user/);
  assert.match(checkAccount({ label: "x", claudeDir: "~/a'b" }), /folder/);
  assert.match(checkAccount({ label: "x", ghUser: "a b" }), /GitHub/);
  const sh = envScript({ claudeDir: "~/.claude-work", ghUser: "octo" });
  assert.equal(sh, `export CLAUDE_CONFIG_DIR="$HOME"'/.claude-work'; GH_TOKEN=$(gh auth token --user 'octo' 2>/dev/null) && export GH_TOKEN || echo 'herdr-ranch: no gh token for octo (gh auth login)' >&2`);
  const argv = argvAs({ claudeDir: "/opt/c" }, "claude");
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  assert.match(argv[2], /^export CLAUDE_CONFIG_DIR='\/opt\/c'; claude; exec /);
  assert.deepEqual(parseGhAccounts("  ✓ Logged in to github.com account alice (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account bob-2 (keyring)"), ["alice", "bob-2"]);
});
