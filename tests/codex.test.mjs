// Codex agents in the Agents list (herdr-ranch-agents/codex.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionList, parseIndex, pickCodex, parseRead, codexResumeArgs, codexPrompt, resumedId, codexModel, codexShort, codexScript } from "../herdr-ranch-agents/mods/herdr-ranch-agents/codex.js";

const meta = (id, cwd, extra = '"source":"cli"') => `{"timestamp":"t","type":"session_meta","payload":{"session_id":"${id}","id":"${id}","cwd":"${cwd}",${extra}}}`;

test("parseSessionList: your conversations only, newest first", () => {
  const out = [
    `2026/11/18/a.jsonl\t100\t${meta("A", "/w/clif")}`,
    `2026/11/19/b.jsonl\t300\t${meta("B", "/w/clif", '"parent_thread_id":"A","source":{"subagent":"review"}')}`,
    `2026/11/19/c.jsonl\t200\t${meta("C", "/w/other")}`,
    "garbage",
  ].join("\n");
  const list = parseSessionList(out, "/h/.codex/sessions");
  assert.deepEqual(list.map((s) => s.id), ["C", "A"]);
  assert.equal(list[1].file, "/h/.codex/sessions/2026/11/18/a.jsonl");
});

test("pickCodex: the title's name picks among a folder's conversations, else the newest", () => {
  const list = [{ id: "new", cwd: "/w" }, { id: "old", cwd: "/w" }, { id: "x", cwd: "/y" }];
  const names = parseIndex('{"id":"old","thread_name":"Review code"}\n{"id":"new","thread_name":"Fix bug"}\n{cut');
  assert.equal(pickCodex(list, "/w", "Review code | clif", names).id, "old");
  assert.equal(pickCodex(list, "/w", "zsh", names).id, "new");
  assert.equal(pickCodex(list, "/none", "", names), null);
});

test("parseRead: the newest model, effort, tokens and window", () => {
  const out = [
    '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"medium","collaboration_mode":{"settings":{"model":"other"}}}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":32913},"model_context_window":475000}}}',
    "SIZE 1234",
  ].join("\n");
  assert.deepEqual(parseRead(out), { st: { model: "gpt-6.1-sol", effort: "medium", context: 32913, window: 475000 }, size: 1234 });
  assert.deepEqual(parseRead("SIZE 5"), { st: {}, size: 5 });
});

test("codexResumeArgs: keeps options, drops prompts and sessions, names the conversation", () => {
  assert.deepEqual(codexResumeArgs(["resume"], "ID"), ["resume", "ID"]);
  assert.deepEqual(codexResumeArgs(["resume", "--last", "-m", "gpt-6", "old-id"], "ID"), ["resume", "-m", "gpt-6", "ID"]);
  assert.deepEqual(codexResumeArgs(["--yolo", "-c", "a=1", "--model=x", "fix the bug"], "ID"), ["resume", "--yolo", "-c", "a=1", "--model=x", "ID"]);
  assert.throws(() => codexResumeArgs(["--mystery"], "ID"), /Unknown Codex option/);
  assert.throws(() => codexResumeArgs(["-m"], "ID"), /no value/);
});

test("codexPrompt, resumedId and names", () => {
  assert.equal(codexPrompt("out\n› Ask Codex to do anything\n\n  GPT-6.1-Sol medium"), "Ask Codex to do anything");
  assert.equal(codexPrompt("› x\n"), "x");
  assert.equal(codexPrompt("no prompt"), null);
  assert.equal(resumedId("To continue this session, run codex resume 01a1ed67-4883-7c72-9ed1-8553ddde64ee"), "01a1ed67-4883-7c72-9ed1-8553ddde64ee");
  assert.equal(codexModel("gpt-6.1-sol"), "GPT-6.1-Sol");
  assert.equal(codexShort("gpt-6.1-sol"), "Sol");
  assert.equal(codexShort("gpt-6.1"), "GPT-6.1");
  assert.equal(codexShort(null), "Codex");
});

test("codexScript: goes to the folder, sets the login, resumes", () => {
  assert.equal(codexScript("/w/it's", "unset CODEX_HOME", ["resume", "ID"]).split("\n").slice(1).join("\n"),
    "cd '/w/it'\\''s' || exit 1\nunset CODEX_HOME\nexec codex 'resume' 'ID'\n");
});
