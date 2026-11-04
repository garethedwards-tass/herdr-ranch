// Stacks of dependent pull requests: found from the list, named, grouped and given a blocker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { listExec, answer, which } from "./stubs/pr-graphql.mjs";
import { list as listPrs } from "../herdr-ranch-prs/mods/herdr-ranch-prs/data.js";
import { stacks, stackOf } from "../herdr-ranch-prs/mods/herdr-ranch-prs/stacks.js";

// Through `list`, so the stacks see the same slim pull requests the mod does.
async function slimPrs(open, closed = [], login = "me") {
  state.exec = listExec(open, closed);
  try { return await listPrs({ github: "o/r", cwd: "/repo", on: null }, login); } finally { state.exec = null; }
}
const ok = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const failed = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
const running = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
const pr = (number, base = "main", o = {}) => ({ number, title: `PR ${number}`, author: { login: "me" }, state: "OPEN", isDraft: false, reviewDecision: "", reviewRequests: [], statusCheckRollup: [], headRefName: `b${number}`, baseRefName: base, ...o });
const ready = (number, base, o = {}) => pr(number, base, { reviewDecision: "APPROVED", statusCheckRollup: [ok], ...o });
const layers = (s) => s.layers.map((l) => [l.number, l.level]);
const found = async (open, closed) => stacks(await slimPrs(open, closed));

test("stacks: a chain of three is one stack, bottom first", async () => {
  const s = await found([pr(3, "b2"), pr(1, "main"), pr(2, "b1")]);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, "stack-1");
  assert.equal(s[0].trunk, "main");
  assert.equal(s[0].name, "PR 1");
  assert.deepEqual(layers(s[0]), [[1, 1], [2, 2], [3, 3]]);
});

test("stacks: a single PR is no stack", async () => {
  assert.deepEqual(await found([pr(1, "main")]), []);
});

test("stacks: a merged lower layer is left out", async () => {
  const s = await found([pr(2, "b1"), pr(3, "b2")], [pr(1, "main", { state: "MERGED" })]);
  assert.equal(s.length, 1);
  assert.equal(s[0].trunk, "b1");
  assert.deepEqual(layers(s[0]), [[2, 1], [3, 2]]);
});

test("stacks: a base cycle ends and makes no stack", async () => {
  assert.deepEqual(await found([pr(1, "b2"), pr(2, "b1")]), []);
});

test("stacks: forks never join", async () => {
  const s = await found([pr(1, "main", { headRefName: "fix" }), pr(2, "main", { headRefName: "fix", isCrossRepository: true }), pr(3, "fix")]);
  assert.equal(s.length, 1);
  assert.deepEqual(layers(s[0]), [[1, 1], [3, 2]]);
  assert.equal(stackOf(s).has(2), false);
  assert.equal(stackOf(s).get(3), s[0]);
});

test("stacks: a branching stack is depth-first, children by number", async () => {
  const s = await found([pr(1, "main"), pr(3, "b1"), pr(2, "b1"), pr(4, "b2")]);
  assert.equal(s.length, 1);
  assert.deepEqual(layers(s[0]), [[1, 1], [2, 2], [4, 3], [3, 2]]);
});

test("stacks: the group is the least ready layer", async () => {
  const cases = [
    ["a layer asks for my review", [ready(1, "main"), pr(2, "b1", { author: { login: "ada" }, reviewRequests: [{ login: "me" }] }), pr(3, "b2", { statusCheckRollup: [failed] })], "review"],
    ["a layer of mine fails", [ready(1, "main"), pr(2, "b1", { statusCheckRollup: [failed] })], "fix"],
    ["every layer ready", [ready(1, "main"), ready(2, "b1")], "ready"],
    ["a layer waits on review", [ready(1, "main"), pr(2, "b1")], "open"],
  ];
  for (const [name, open, group] of cases) assert.equal((await found(open))[0].group, group, name);
});

// The gh stack check and what Start agent gets for a stack.
import { hasGhStack, hash } from "../herdr-ranch-prs/mods/herdr-ranch-prs/data.js";
import { stackAgent } from "../herdr-ranch-prs/mods/herdr-ranch-prs/stacks.js";

test("ghStack: found in gh extension list, asked once per machine", async () => {
  let calls = 0;
  state.exec = (cmd, args) => { calls++; return { code: 0, stdout: "gh dash\tdlvhdr/gh-dash\tv4.25.2\ngh stack\tgithub/gh-stack\tv0.1.0\n", stderr: "" }; };
  try {
    assert.equal(await hasGhStack({ cwd: "/repo", on: "m1" }), true);
    assert.equal(await hasGhStack({ cwd: "/repo", on: "m1" }), true);
    assert.equal(calls, 1);
  } finally { state.exec = null; }
});

test("ghStack: missing or gh failing is false", async () => {
  state.exec = () => ({ code: 0, stdout: "gh dash\tdlvhdr/gh-dash\tv4.25.2\n", stderr: "" });
  try { assert.equal(await hasGhStack({ cwd: "/repo", on: "m2" }), false); } finally { state.exec = null; }
  state.exec = () => ({ code: 1, stdout: "", stderr: "boom" });
  try { assert.equal(await hasGhStack({ cwd: "/repo", on: "m3" }), false); } finally { state.exec = null; }
});

const three = async () => {
  const prs = await slimPrs([ready(1, "main"), ready(2, "b1"), pr(3, "b2", { statusCheckRollup: [failed], reviewDecision: "CHANGES_REQUESTED" })]);
  return [stacks(prs)[0], new Map(prs.map((p) => [p.number, p]))];
};

test("stackAgent: vars for a three-layer stack", async () => {
  const [s, byNumber] = await three();
  const a = stackAgent(s, byNumber, "o/r");
  assert.equal(a.vars.count, 3);
  assert.equal(a.vars.trunk, "main");
  assert.equal(a.vars.top, 3);
  assert.equal(a.vars.bottom, 1);
  assert.equal(a.vars.title, "PR 1");
  assert.equal(a.vars.repo, "o/r");
  assert.equal(a.vars.layers, "#1 PR 1 (b1 → main)\n#2 PR 2 (b2 → b1)\n#3 PR 3 (b3 → b2)");
  assert.equal(a.vars.blockers, "#3: 1 failing check, changes requested");
});

test("stackAgent: no blockers is none", async () => {
  const prs = await slimPrs([ready(1, "main"), ready(2, "b1")]);
  assert.equal(stackAgent(stacks(prs)[0], new Map(prs.map((p) => [p.number, p])), "o/r").vars.blockers, "none");
});

test("stackAgent: branches and tabs", async () => {
  const [s, byNumber] = await three();
  const a = stackAgent(s, byNumber, "o/r"), h = hash("github-stack-o/r-1");
  assert.equal(a.branches["stack-review"], `agent/stack-review-1-pr-1-${h}`);
  assert.equal(a.branches["stack-fix"], `agent/stack-1-pr-1-${h}`);
  assert.deepEqual(a.tabs, { "stack-review": "Review stack PR 1", "stack-fix": "Fix stack PR 1" });
  assert.equal(a.key, "3 PRs");
  assert.equal(a.title, "PR 1");
});

test("ghStack: a missing extension is asked again, so installing it counts on the next refresh", async () => {
  let installed = false;
  state.exec = () => ({ code: 0, stdout: installed ? "gh stack\tgithub/gh-stack\tv0.1.0\n" : "", stderr: "" });
  try {
    assert.equal(await hasGhStack({ cwd: "/repo", on: "m4" }), false);
    installed = true;
    assert.equal(await hasGhStack({ cwd: "/repo", on: "m4" }), true);
  } finally { state.exec = null; }
});

test("gh: a GitHub 5xx is asked again once, so a passing 504 doesn't fail the list", async () => {
  let calls = 0;
  state.exec = (cmd, args) => {
    calls++;
    if (calls === 1) return { code: 1, stdout: "", stderr: "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)" };
    return { code: 0, stdout: answer(which(args) === "open" ? [pr(1, "main")] : []), stderr: "" };
  };
  try {
    const listed = await listPrs({ github: "o/r", cwd: "/repo", on: null }, "me");
    assert.deepEqual(listed.map((p) => p.number), [1]);
    assert.equal(calls, 3, "one retry, then the second list");
  } finally { state.exec = null; }
});

test("gh: other failures are not retried", async () => {
  let calls = 0;
  state.exec = () => { calls++; return { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }; };
  try { await assert.rejects(listPrs({ github: "o/r", cwd: "/repo", on: null }, "me"), /401/); assert.equal(calls, 2, "open and closed, once each"); } finally { state.exec = null; }
});

// Review with agent opens on fixing for your own work, on reviewing for someone else's.
import { agentMode } from "../herdr-ranch-prs/mods/herdr-ranch-prs/stacks.js";

test("agentMode: your pull request opens on Address review comments, someone else's on Review", () => {
  assert.equal(agentMode({ author: { login: "me" } }, "me"), "comments");
  assert.equal(agentMode({ author: { login: "ada" } }, "me"), "review");
  assert.equal(agentMode({ author: { login: "ada" } }, null), "review", "unknown login reviews");
});

test("agentMode: a stack with a layer of yours opens on Fix stack to merge, else on Review stack", async () => {
  const prs = await slimPrs([pr(1, "main", { author: { login: "ada" } }), pr(2, "b1", { author: { login: "me" } })]);
  const byNumber = new Map(prs.map((p) => [p.number, p])), s = stacks(prs)[0];
  assert.equal(agentMode(s, "me", byNumber), "stack-fix");
  assert.equal(agentMode(s, "bob", byNumber), "stack-review");
});
