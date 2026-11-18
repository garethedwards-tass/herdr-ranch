// Agents working in a checkout now: the Agents list publishes each Claude Code agent's folder,
// the Spaces list matches agents to checkouts. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPlaces, agentsIn } from "../herdr-ranch-spaces/mods/herdr-ranch-spaces/agents-at.js";
import { placesOf } from "../herdr-ranch-agents/mods/herdr-ranch-agents/places.js";
import { apply, emptyState } from "../herdr-ranch-agents/mods/herdr-ranch-agents/claude.js";

const sp = [
  { id: "s1", name: "webapp", machine: null, tabs: [{ id: "tab1" }, { id: "tab2" }] },
  { id: "s2", name: "ACME-12", machine: null, tabs: [{ id: "tab3" }] },
];
const ps = [
  { pane: "p1", terminal: "t1", tab: "tab1", cwd: "/r/webapp", status: "working", program: { name: "Claude Code" } },
  { pane: "p2", terminal: "t2", tab: "tab2", cwd: "/r/webapp", status: null }, // a shell
  { pane: "p3", terminal: "t3", tab: "tab3", cwd: "/w/webapp/ACME-12", status: "blocked", program: { name: "Codex" } },
];
const checkouts = [{ path: "/r/webapp", main: true }, { path: "/w/webapp/ACME-12" }, { path: "/r/webapp/.claude/worktrees/x" }];

test("agentPlaces: agents only, with their space, and the live folder over the pane's", () => {
  const got = agentPlaces(ps, sp, { t1: { cwd: "/r/webapp/.claude/worktrees/x/src" } });
  assert.deepEqual(got.map((a) => [a.terminal, a.space, a.cwd, a.status, a.name]), [
    ["t1", "s1", "/r/webapp/.claude/worktrees/x/src", "working", "Claude Code"],
    ["t3", "s2", "/w/webapp/ACME-12", "blocked", "Codex"],
  ]);
});

test("agentsIn: the deepest checkout holds the agent; its own space is left out; most urgent first", () => {
  const places = agentPlaces(ps, sp, { t1: { cwd: "/w/webapp/ACME-12/src" } });
  assert.deepEqual(agentsIn(places, checkouts, "/w/webapp/ACME-12").map((a) => a.terminal), ["t3", "t1"]);
  assert.deepEqual(agentsIn(places, checkouts, "/w/webapp/ACME-12", "s2").map((a) => a.terminal), ["t1"]);
  assert.deepEqual(agentsIn(places, checkouts, "/r/webapp"), []);
  const inner = agentPlaces(ps, sp, { t1: { cwd: "/r/webapp/.claude/worktrees/x" } });
  assert.deepEqual(agentsIn(inner, checkouts, "/r/webapp/.claude/worktrees/x").map((a) => a.terminal), ["t1"]);
  assert.deepEqual(agentsIn(inner, checkouts, "/r/webapp"), [], "a worktree inside the main checkout isn't the main checkout");
  assert.deepEqual(agentsIn(inner, checkouts, "/w/webapp/ACME-12", null, "remote"), [], "another machine's checkout");
});

test("apply and placesOf: the latest main-thread record's folder, else where the session started", () => {
  const st = apply(emptyState(), [{ type: "user", cwd: "/r/webapp" }, { type: "assistant", cwd: "/r/webapp/tests", message: {} }, { type: "assistant", isSidechain: true, cwd: "/elsewhere", message: {} }]);
  assert.equal(st.cwd, "/r/webapp/tests");
  const claude = new Map([["t1", { st, cwd: "/r/webapp" }], ["t2", { st: emptyState(), cwd: "/r/other" }], ["t3", { st: emptyState() }]]);
  assert.deepEqual(placesOf(claude), { t1: { cwd: "/r/webapp/tests", home: "/r/webapp" }, t2: { cwd: "/r/other", home: "/r/other" } });
});

test("agentsAway: a space's own agents in another checkout than its own", async () => {
  const { agentsAway } = await import("../herdr-ranch-spaces/mods/herdr-ranch-spaces/agents-at.js");
  const places = agentPlaces(ps, sp, { t1: { cwd: "/w/webapp/ACME-12/src" } });
  assert.deepEqual(agentsAway(places, checkouts, "s1", "/r/webapp").map((a) => [a.terminal, a.checkout]), [["t1", "/w/webapp/ACME-12"]]);
  assert.deepEqual(agentsAway(places, checkouts, "s2", "/w/webapp/ACME-12"), [], "at home");
  assert.deepEqual(agentsAway(agentPlaces(ps, sp, {}), checkouts, "s1", "/r/webapp"), []);
});

test("place: an agent's session home over Herdr's out-of-date folder; its current folder doesn't move the space", async () => {
  const { place } = await import("../herdr-ranch-spaces/mods/herdr-ranch-spaces/git.js");
  const s = { tabs: [{ id: "tab1" }], folder: "/made/here" };
  const panes = [{ terminal: "t1", tab: "tab1", cwd: "/old/name" }];
  assert.equal(place(s, panes, { t1: { cwd: "/w/webapp/ACME-12", home: "/new/name" } }), "/new/name");
  assert.equal(place(s, panes, {}), "/old/name");
  assert.equal(place(s, [], {}), "/made/here");
});

test("worktree marker: git's answer tells a linked worktree from a main checkout; the agent's folder now", async () => {
  const { parseRevParse, agentFolders } = await import("../herdr-ranch-agents/mods/herdr-ranch-agents/worktree.js");
  assert.deepEqual(parseRevParse("/w/webapp/ACME-12\n/r/webapp/.git\n"), { top: "/w/webapp/ACME-12", linked: true, main: "/r/webapp" });
  assert.equal(parseRevParse("/r/webapp\n/r/webapp/.git\n").linked, false);
  assert.equal(parseRevParse(""), null);
  const claude = new Map([["t1", { st: { cwd: "/w/webapp/ACME-12/src" }, cwd: "/r/webapp" }]]);
  assert.deepEqual(agentFolders([{ address: "t1" }, { address: "t2" }, { address: "t3" }], claude, [{ address: "t2", cwd: "/r/other" }, { address: "t3", cwd: null }]),
    { t1: "/w/webapp/ACME-12/src", t2: "/r/other" });
});
