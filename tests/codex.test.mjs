// Codex agents in the Agents list (herdr-ranch-agents/codex.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { state } from "./stubs/herdr.mjs";
import { parseSessionList, parseIndex, pickCodex, parseRead, codexResumeArgs, codexPrompt, resumedId, codexModel, codexShort, codexScript, codexSessions, readCodex } from "../herdr-ranch-agents/mods/herdr-ranch-agents/codex.js";

// The real shell scripts, run on files in a temporary folder.
const realExec = () => { state.exec = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }; };

const meta = (id, cwd, extra = '"source":"cli"') => `{"timestamp":"t","type":"session_meta","payload":{"session_id":"${id}","id":"${id}","cwd":"${cwd}",${extra}}}`;

test("parseSessionList: your conversations only, newest first", () => {
  const out = [
    `2026/11/18/a.jsonl\t100\t"id":"A" "cwd":"/w/clif" "source":"cli"`,
    `2026/11/19/b.jsonl\t300\t"id":"B" "parent_thread_id":"A" "cwd":"/w/clif" "source":{`,
    `2026/11/19/c.jsonl\t200\t"id":"C" "cwd":"/w/other"`,
    `2026/11/19/d.jsonl\t400\t"id":"D" "cwd":"/w/other" "source":"exec"`,
    "garbage",
  ].join("\n");
  const list = parseSessionList(out, "/h/.codex/sessions");
  assert.deepEqual(list.map((s) => s.id), ["C", "A"]);
  assert.equal(list[1].file, "/h/.codex/sessions/2026/11/18/a.jsonl");
});

test("pickCodex: the title's name picks among a folder's conversations, else the newest", () => {
  const list = [{ id: "new", cwd: "/w" }, { id: "old", cwd: "/w" }, { id: "x", cwd: "/y" }];
  const names = parseIndex('{"id":"old","thread_name":"Review code"}\n{"id":"new","thread_name":"Fix bug"}\n{cut');
  assert.equal(pickCodex(list, "/w", "Review code | clif", names, 2).id, "old");
  assert.equal(pickCodex(list, "/w", "Review code | clif", names, 2).sure, true);
  assert.equal(pickCodex(list, "/w", "zsh", names).id, "new");
  assert.equal(pickCodex(list, "/w", "zsh", names, 1).sure, true);
  assert.equal(pickCodex(list, "/w", "zsh", names, 2).sure, false); // two Codex terminals in /w, unnamed
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
  assert.deepEqual(codexResumeArgs(["--yolo", "-c", "a=1", "--model=x", "fix the bug"], "ID"), ["resume", "-c", "a=1", "--model=x", "--yolo", "ID"]);
  assert.throws(() => codexResumeArgs(["--mystery"], "ID"), /Unknown Codex option/);
  // -C: the script already goes to that folder; a relative path after it can't be placed.
  assert.deepEqual(codexResumeArgs(["-C", "sub", "--add-dir", "/abs", "-m", "x"], "ID"), ["resume", "--add-dir", "/abs", "-m", "x", "ID"]);
  assert.deepEqual(codexResumeArgs(["--cd=sub"], "ID"), ["resume", "ID"]);
  assert.throws(() => codexResumeArgs(["-C", "sub", "--add-dir", "rel"], "ID"), /relative/);
  assert.deepEqual(codexResumeArgs(["--add-dir", "rel"], "ID"), ["resume", "--add-dir", "rel", "ID"]);
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

test("codexSessions: finds conversations by their fields wherever they are in a long first line", async () => {
  realExec();
  const dir = mkdtempSync(join(tmpdir(), "codex-"));
  mkdirSync(join(dir, "2026/11/19"), { recursive: true });
  const long = "y".repeat(20000);
  writeFileSync(join(dir, "2026/11/19/rollout-a.jsonl"), `{"type":"session_meta","payload":{"session_id":"A","id":"A","base_instructions":{"text":"${long}"},"cwd":"/w","source":"cli"}}\n{"type":"x"}\n`);
  writeFileSync(join(dir, "2026/11/19/rollout-b.jsonl"), `{"type":"session_meta","payload":{"id":"B","parent_thread_id":"A","cwd":"/w","source":{"subagent":"review"}}}\n`);
  const list = await codexSessions(dir);
  state.exec = null;
  assert.deepEqual(list.map((s) => [s.id, s.cwd]), [["A", "/w"]]);
});

test("readCodex: whole lines only, and a token_count without usage keeps the last one with it", async () => {
  realExec();
  const f = join(mkdtempSync(join(tmpdir(), "codex-")), "r.jsonl");
  const usage = (n) => `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":${n}},"model_context_window":1000}}}`;
  const empty = '{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}';
  writeFileSync(f, `{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"high"}}\n${usage(100)}\n${empty}\n`);
  const one = await readCodex(f, 0);
  assert.deepEqual(one.st, { model: "gpt-6.1-sol", effort: "high", context: 100, window: 1000 });
  // A line being written: left for next time.
  const whole = one.size;
  appendFileSync(f, usage(200).slice(0, 40));
  const two = await readCodex(f, whole);
  assert.equal(two.size, whole);
  assert.deepEqual(two.st, {});
  appendFileSync(f, usage(200).slice(40) + "\n");
  const three = await readCodex(f, two.size);
  state.exec = null;
  assert.equal(three.st.context, 200);
});
