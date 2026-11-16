// The Agents list's Claude Code side: session records folded into stats, tasks and subagents.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, apply, totals, windowOf, tokens, parseFirstRead, pickSession, subagentOf, taskList, projectDir, utf8Length, configDirs } from "../herdr-ranch-agents/mods/herdr-ranch-agents/claude.js";
import { modelName } from "../herdr-ranch-agents/mods/herdr-ranch-agents/extras.js";

const reply = (id, usage, content = [], extra = {}) => ({ type: "assistant", requestedModel: "claude-opus-5-5", effort: "medium", ...extra, message: { id, model: "claude-opus-5-5", usage, content } });
const u = (input, cacheWrite, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output });

test("apply: model, effort, title, mode, context and usage counted once per reply", () => {
  const st = apply(emptyState(), [
    { type: "ai-title", aiTitle: "Fix the build" }, { type: "mode", mode: "plan" },
    reply("msg_1", u(10, 100, 1000, 50)), reply("msg_1", u(10, 100, 1000, 60)), reply("msg_2", u(2, 20, 2000, 5)),
    { type: "assistant", isSidechain: true, message: { id: "msg_s", model: "claude-haiku-5-5", usage: u(1, 1, 1, 1) } },
  ]);
  assert.deepEqual([st.title, st.mode, st.model, st.effort, st.context], ["Fix the build", "plan", "claude-opus-5-5", "medium", 2022]);
  assert.deepEqual(totals(st), { input: 12, cacheRead: 3000, cacheWrite: 120, output: 65, replies: 2 });
});

test("apply: tasks from TaskCreate results and TaskUpdate, subagents done when their call returns", () => {
  const st = apply(emptyState(), [
    reply("m1", null, [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "Write tests" } }, { type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "Ship" } }]),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Task #1 created successfully: Write tests" }, { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: "Task #2 created successfully: Ship" }] }] } },
    reply("m2", null, [{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }, { type: "tool_use", id: "u2", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } }]),
    reply("m3", null, [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Find it", subagent_type: "Explore" } }, { type: "tool_use", id: "a2", name: "Agent", input: { description: "Watch", run_in_background: true } }]),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "found" }, { type: "tool_result", tool_use_id: "a2", content: "started" }] } },
  ]);
  const tl = taskList(st);
  assert.deepEqual(tl.list.map((t) => [t.id, t.subject, t.status]), [["1", "Write tests", "completed"], ["2", "Ship", "in_progress"]]);
  assert.equal(tl.done, 1); assert.equal(tl.active.subject, "Ship");
  assert.deepEqual([...st.agents.values()].map((a) => [a.type, a.done]), [["Explore", true], ["general-purpose", false]]);
  apply(st, [reply("m4", null, [{ type: "tool_use", id: "u3", name: "TaskUpdate", input: { taskId: "2", status: "deleted" } }])]);
  assert.equal(taskList(st).list.length, 1);
});

test("parseFirstRead: sections, and usage paired with its reply's id", () => {
  const out = ["SIZE\t1234", "LINES", JSON.stringify({ type: "ai-title", aiTitle: "T" }), "LAST", JSON.stringify(reply("msg_9", u(1, 2, 3, 4))), "USAGE",
    '"id":"msg_1"', '"usage":{"input_tokens":5,"cache_creation_input_tokens":6,"cache_read_input_tokens":7,"output_tokens":8', '"id":"msg_9"', '"usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4'].join("\n");
  const { st, size } = parseFirstRead(out);
  assert.equal(size, 1234); assert.equal(st.title, "T"); assert.equal(st.context, 6);
  assert.deepEqual(totals(st), { input: 6, cacheRead: 10, cacheWrite: 8, output: 12, replies: 2 });
});

test("pickSession, subagentOf, windows, names and paths", () => {
  const a = { sessionId: "a", name: "x", title: "Fix the build" }, b = { sessionId: "b", name: "Other" };
  assert.equal(pickSession([a], "anything"), a);
  assert.equal(pickSession([a, b], "✳ Fix the build"), a);
  assert.equal(pickSession([a, b], "Other"), b);
  assert.equal(pickSession([a, b], "nope"), null);
  assert.equal(subagentOf({ toolUseId: "t1", finished: false }, new Set(["t1"])).done, false);
  assert.equal(subagentOf({ toolUseId: "t1" }, new Set(["t1"])).done, true);
  assert.equal(subagentOf({ toolUseId: "t1", requestShape: "background" }, new Set(["t1"])).done, false);
  assert.equal(windowOf({ requested: "claude-opus-5-5[1m]" }), 1_000_000);
  assert.equal(windowOf({ requested: "claude-opus-5-5" }), 200_000);
  assert.deepEqual([tokens(812), tokens(45300), tokens(1_234_567), tokens(34_000_000)], ["812", "45.3k", "1.2M", "34M"]);
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-sonnet-5-5[1m]"), "Sonnet 5.5 (1M)");
  assert.equal(projectDir("/Users/me/.claude", "/Users/me/.config/herdr-app"), "/Users/me/.claude/projects/-Users-me--config-herdr-app");
  assert.deepEqual(configDirs("/Users/me", { accounts: [{ claudeDir: "~/.claude-work" }, { ghUser: "x" }, { claudeDir: "/opt/c" }, { claudeDir: "~/.claude" }] }), ["/Users/me/.claude", "/Users/me/.claude-work", "/opt/c"]);
  assert.equal(utf8Length("a·€😀"), 1 + 2 + 3 + 4);
});

import { keysFor, promptText, runningAgents, stopOffered, busyTitle, busyScreen, vimInsert, resumeArgs, envOf, setupFor, scriptFor } from "../herdr-ranch-agents/mods/herdr-ranch-agents/revive.js";

test("revive: typable keys, the prompt, background agents, /stop, busy, vim", () => {
  assert.deepEqual(keysFor("sh /Users/a.b/x-1=2"), ["s", "h", "space", "/", "shift+u", "s", "e", "r", "s", "/", "a", ".", "b", "/", "x", "-", "1", "=", "2"]);
  assert.equal(keysFor("echo $HOME"), null);
  assert.equal(keysFor("a_b"), null);
  const screen = "  some reply\n───\n❯ carry on with both\n───\n  ⏵⏵ auto mode on · ← 1 agent · PR #2";
  assert.equal(promptText(screen), "carry on with both");
  assert.equal(promptText("❯ \n"), "");
  assert.equal(promptText("no prompt"), null);
  assert.equal(runningAgents(screen), true);
  assert.equal(runningAgents("❯ x\n  ⏵⏵ auto mode on · PR #2"), false);
  assert.equal(stopOffered("❯ /stop\n  ❯ /stop      Stop this background session; transcript and worktree are kept"), true);
  assert.equal(stopOffered("  ❯ /status   Show status"), false);
  assert.equal(busyTitle("◑ TASS-1 fix"), true);
  assert.equal(busyTitle("✳ Tassdocker setup"), false);
  assert.equal(busyTitle("TASS-10497 product impact"), false);
  assert.equal(busyTitle(""), false);
  assert.equal(busyScreen("✻ Working… (12s · esc to interrupt)\n❯ \n"), true);
  assert.equal(busyScreen("✻ Worked for 9m\n❯ \n"), false);
  assert.equal(vimInsert("❯ draft\n  -- INSERT -- ⏵⏵ auto mode on"), true);
  assert.equal(vimInsert("❯ draft\n  ⏵⏵ auto mode on"), false);
});

test("revive: Claude Code's options again, with --resume, and nothing it can't read the same way", () => {
  const R = (args) => resumeArgs(args, "ID");
  assert.deepEqual(R(["--model", "opus", "--effort", "high", "--permission-mode=acceptEdits", "--dangerously-skip-permissions", "Plan the work"]),
    ["--model", "opus", "--effort", "high", "--permission-mode=acceptEdits", "--dangerously-skip-permissions", "--resume", "ID"]);
  // Session choices go, an optional -r value too (and only when it is one).
  assert.deepEqual(R(["--continue", "--fork-session", "-r", "old", "--session-id", "x"]), ["--resume", "ID"]);
  assert.deepEqual(R(["-r", "--dangerously-skip-permissions"]), ["--dangerously-skip-permissions", "--resume", "ID"]);
  assert.deepEqual(R(["--resume", "--model", "opus"]), ["--model", "opus", "--resume", "ID"]);
  // Several values, all kept; short names; = forms.
  assert.deepEqual(R(["--add-dir", "../api", "../web", "--allowedTools", "Bash", "Edit"]), ["--add-dir", "../api", "../web", "--allowedTools", "Bash", "Edit", "--resume", "ID"]);
  assert.deepEqual(R(["-n", "auth work", "--model=us.anthropic.claude:1"]), ["-n", "auth work", "--model=us.anthropic.claude:1", "--resume", "ID"]);
  assert.deepEqual(R(["--append-system-prompt", "line one\nline two"]), ["--append-system-prompt", "line one\nline two", "--resume", "ID"]);
  // An option it doesn't know: refuse, rather than read its value as a prompt.
  assert.throws(() => R(["--brand-new-flag", "value"]), /--brand-new-flag/);
  assert.throws(() => R(["-p", "hi"]), /-p/);
});

test("revive: the account comes from the shell, or from the account Claude Code names", () => {
  const list = [{ id: "personal-1", claudeDir: "~/.claude-personal", ghUser: "octo" }];
  const shell = "-zsh TERM=x HOME=/Users/a PATH=/bin";
  // Same as its shell (nothing set for it, or a GH_TOKEN from the profile): inherit.
  assert.equal(setupFor("claude TERM=x PATH=/bin", shell, list), "");
  assert.equal(setupFor("claude GH_TOKEN=abc", "-zsh GH_TOKEN=abc", list), "");
  // Set only for Claude Code, by an account it names: that account's setup.
  assert.equal(setupFor("claude HERDR_RANCH_ACCOUNT=personal-1 CLAUDE_CONFIG_DIR=/Users/a/.claude-personal GH_TOKEN=t", shell, list),
    `export HERDR_RANCH_ACCOUNT=personal-1; export CLAUDE_CONFIG_DIR="$HOME"'/.claude-personal'; GH_TOKEN=$(gh auth token --user 'octo' 2>/dev/null) && export GH_TOKEN || echo 'herdr-ranch: no gh token for octo (gh auth login)' >&2`);
  // Set only for it, by nothing it names (or an account since removed): refuse.
  assert.equal(setupFor("claude CLAUDE_CONFIG_DIR=/x", shell, list), null);
  assert.equal(setupFor("claude HERDR_RANCH_ACCOUNT=gone CLAUDE_CONFIG_DIR=/x", shell, list), null);
  assert.equal(envOf("a B=1 C=2", "C"), "2");

  const s = scriptFor("export X=1", ["--model", "opus", "--resume", "abc-1"]);
  assert.ok(s.endsWith("export X=1\nexec claude '--model' 'opus' '--resume' 'abc-1'\n"));
});
