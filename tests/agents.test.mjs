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

import { keysFor, promptText, runningAgents, stopOffered, busyTitle, busyScreen, vimInsert, resumeArgs, helpArity, envVar, setupFor, scriptFor } from "../herdr-ranch-agents/mods/herdr-ranch-agents/revive.js";

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
  assert.equal(busyTitle("◑ ACME-1 fix"), true);
  assert.equal(busyTitle("✳ Docker setup"), false);
  assert.equal(busyTitle("ACME-10497 product impact"), false);
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
  // An option it doesn't know: refuse, rather than read its value as a prompt; and options whose
  // session can't be resumed. A worktree is a session's folder: the script goes there instead.
  assert.throws(() => R(["--brand-new-flag", "value"]), /--brand-new-flag/);
  assert.throws(() => R(["-p", "hi"]), /--print/);
  assert.throws(() => R(["--no-session-persistence"]), /isn't saved/);
  assert.deepEqual(R(["-w", "feature", "--model", "opus"]), ["--model", "opus", "--resume", "ID"]);
});

test("revive: the option table from claude --help (wrapped description lines don't count)", () => {
  const t = helpArity(`Options:
  --add-dir <directories...>            Additional directories
  --bg, --background                    Start in the background and with
                                        --resume <session-id>, continues that
  --plugin-dir <path>                   Load a plugin (repeat:
                                        --plugin-dir A --plugin-dir B.zip)
  -r, --resume [value]                  Resume a conversation
  -n, --name <name>                     Set a display name
  --verbose                             Override verbose mode`);
  assert.deepEqual(t, { "--add-dir": "*", "--bg": 0, "--background": 0, "--plugin-dir": 1, "-r": "?", "--resume": "?", "-n": 1, "--name": 1, "--verbose": 0 });
  assert.deepEqual(resumeArgs(["--plugin-dir", "x", "--verbose", "hi"], "ID", t), ["--plugin-dir", "x", "--verbose", "--resume", "ID"]);
});

test("revive: the account from the session's config folder; HERDR_RANCH_ACCOUNT only when it agrees", () => {
  const home = "/Users/a";
  const list = [{ id: "personal-1", claudeDir: "~/.claude-personal", ghUser: "octo" }, { id: "gh-2", ghUser: "work" }];
  // The usual folder: unset whatever the shell has; a GitHub-only account named by Claude Code adds its login.
  assert.equal(setupFor({ configDir: `${home}/.claude`, home, list }), "unset CLAUDE_CONFIG_DIR");
  assert.equal(setupFor({ configDir: `${home}/.claude`, home, named: "gh-2", list }),
    `export HERDR_RANCH_ACCOUNT=gh-2; GH_TOKEN=$(gh auth token --user 'work' 2>/dev/null) && export GH_TOKEN || echo 'herdr-ranch: no gh token for work (gh auth login)' >&2; unset CLAUDE_CONFIG_DIR`);
  // An account's folder: that account, whatever Claude Code names (a stale inherited name can't win).
  assert.match(setupFor({ configDir: `${home}/.claude-personal`, home, named: "gh-2", list }), /^export HERDR_RANCH_ACCOUNT=personal-1; export CLAUDE_CONFIG_DIR="\$HOME"'\/\.claude-personal'; GH_TOKEN/);
  // A folder no account has (spaces included): just that folder.
  assert.equal(setupFor({ configDir: "/opt/claude cfg", home, list }), "export CLAUDE_CONFIG_DIR='/opt/claude cfg'");

  // Environment only after the arguments, so argument text can't pass for it.
  const argv = ["claude", "why is HERDR_RANCH_ACCOUNT=x empty"];
  assert.equal(envVar("claude why is HERDR_RANCH_ACCOUNT=x empty TERM=y HERDR_RANCH_ACCOUNT=real-1\n", argv, "HERDR_RANCH_ACCOUNT"), "real-1");
  assert.equal(envVar("claude why is HERDR_RANCH_ACCOUNT=x empty TERM=y", argv, "HERDR_RANCH_ACCOUNT"), undefined);
  assert.equal(envVar("something else", argv, "TERM"), undefined);

  const s = scriptFor("/w/my repo", "unset CLAUDE_CONFIG_DIR", ["--model", "opus", "--resume", "abc-1"]);
  assert.ok(s.endsWith("cd '/w/my repo' || exit 1\nunset CLAUDE_CONFIG_DIR\nexec claude '--model' 'opus' '--resume' 'abc-1'\n"));
});

test("apply: a reply Claude Code wrote itself (a usage limit) keeps the model and context, and says what stopped it", () => {
  const limit = { type: "assistant", isApiErrorMessage: true, timestamp: "2026-11-17T02:00:00Z", message: { id: "x-1", model: "<synthetic>", usage: u(0, 0, 0, 0), content: [{ type: "text", text: "You've hit your 5-hour limit · resets 3:30pm" }] } };
  const st = apply(emptyState(), [reply("msg_1", u(2, 100, 1000, 5)), limit]);
  assert.deepEqual([st.model, st.context, st.apiError?.text], ["claude-opus-5-5", 1102, "You've hit your 5-hour limit · resets 3:30pm"]);
  apply(st, [reply("msg_2", u(1, 10, 2000, 5))]);
  assert.equal(st.apiError, null);
  const first = parseFirstRead(["SIZE\t10", "LINES", "LAST", JSON.stringify(reply("msg_1", u(2, 100, 1000, 5))), JSON.stringify(limit), "USAGE"].join("\n")).st;
  assert.deepEqual([first.context, Boolean(first.apiError)], [1102, true]);
});

test("pickSession: several sessions in one folder, the terminal's own process wins", () => {
  const list = [{ pid: 65177, sessionId: "bg", title: "Old" }, { pid: 30972, sessionId: "mine", title: "Other" }];
  assert.equal(pickSession(list, "Nothing alike", 30972).sessionId, "mine");
  assert.equal(pickSession(list, "Nothing alike"), null);
  assert.equal(pickSession(list, "Old", 1).sessionId, "bg");
});
