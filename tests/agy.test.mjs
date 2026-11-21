import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgyRows, addAgyRows } from "../herdr-ranch-agents/mods/herdr-ranch-agents/antigravity.js";
import { parseRead, parseEtime } from "../herdr-ranch-agents/mods/herdr-ranch-agents/codex.js";
import { parseAgyConversations, pickAgy, parseAgyTurn, parseAgyFooter, agyShort, agyResumeArgs, agyPrompt, resumedAgyId, heldAgyId, isAgy } from "../herdr-ranch-agents/mods/herdr-ranch-agents/antigravity.js";
import { parseSession, sessionView } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/session.js";

// A protobuf message, for the fixtures: [field, number | bytes] pairs.
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const msg = (pairs) => pairs.flatMap(([f, v]) => (typeof v === "number" ? [...varint(f * 8), ...varint(v)] : [...varint(f * 8 + 2), ...varint(v.length), ...v]));
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
// A turn row as agy writes it: 1 { 3: model, 4: usage, 9 { 10 { 1: in context, 4: limit } } }.
const turn = (context, window) => hex(msg([[1, msg([[3, 1532], [4, msg([[2, 4560], [3, 326], [5, 367584]])], [9, msg([[2, 7], [10, msg([[1, context], [4, window]])]])]])]]));

test("parseAgyTurn: tokens in context and the limit from a turn row; anything else is null", () => {
  assert.deepEqual(parseAgyTurn(turn(359539, 512000)), { context: 359539, window: 512000, input: 4560, output: 326, cacheRead: 367584 });
  assert.equal(parseAgyTurn(hex(msg([[3, msg([[1, 1532], [6, 262144]])]]))), null); // a prompt record
  assert.equal(parseAgyTurn("zz"), null);
  assert.equal(parseAgyTurn(""), null);
  assert.equal(parseAgyTurn("FFFF"), null); // not a message
});

test("parseSession: Antigravity's rows give context and its limit; calls aren't known", () => {
  const s = parseSession(`rows=${hex(msg([[3, 1]]))},${turn(256000, 512000)}, id=x`, "antigravity");
  assert.deepEqual([s.tokens, s.window, s.calls], [256000, 512000, null]);
  const v = sessionView(s, "clif");
  assert.equal(v.context.text, "50%");
  assert.equal(v.calls, null);
  assert.equal(parseSession("rows=,", "antigravity"), null);
});

test("Antigravity conversations: by folder, the one agy names newest there; sure only alone", () => {
  const meta = JSON.stringify({ conversations: {
    "ca20ae9b-7e5e-498d-9834-3587de7bbeef": { summary: { ID: "ca20ae9b-7e5e-498d-9834-3587de7bbeef", Title: "Progress", NumSteps: 16, UpdatedAt: "2026-11-21T00:30:59Z", WorkspaceURIs: ["file:///src/clif"] } },
    "11111111-1bb1-4a89-be62-edbede73eda5": { summary: { ID: "11111111-1bb1-4a89-be62-edbede73eda5", Title: "Newer", NumSteps: 2, UpdatedAt: "2026-11-21T01:00:00Z", WorkspaceURIs: ["file:///src/clif"] } },
    bad: { summary: { ID: "../x" } },
  } });
  const all = parseAgyConversations(meta, JSON.stringify({ "/src/clif": "ca20ae9b-7e5e-498d-9834-3587de7bbeef" }));
  assert.equal(all.list.length, 2);
  assert.deepEqual([pickAgy(all, "/src/clif").title, pickAgy(all, "/src/clif").sure], ["Progress", true]);
  assert.equal(pickAgy(all, "/src/clif", 2).sure, false);
  assert.equal(pickAgy(parseAgyConversations(meta, "{}"), "/src/clif").title, "Newer");
  assert.equal(pickAgy(all, "/elsewhere"), null);
  assert.deepEqual(parseAgyConversations("not json", null), { list: [], last: {} });
});

test("agy's footer: model and effort; the pill's short model name", () => {
  assert.deepEqual(parseAgyFooter("x\n? for shortcuts                      auto · Gemini 4 Neon · high · 1 task(s) · /tasks"), { model: "Gemini 4 Neon", effort: "high" });
  assert.deepEqual(parseAgyFooter("? for shortcuts          Claude Opus 5.5 · /tasks"), { model: "Claude Opus 5.5", effort: null });
  assert.deepEqual(parseAgyFooter("? for shortcuts"), { model: null, effort: null });
  assert.deepEqual(["Gemini 4 Neon", "Claude Opus 5.5", "Gemini 3.8 Flash", "GPT-OSS 120B", null].map(agyShort), ["Neon", "Opus", "Flash", "GPT-OSS", "Antigravity"]);
});

test("agy Restart: options kept, a prompt or session choice dropped, the conversation named", () => {
  const id = "ca20ae9b-7e5e-498d-9834-3587de7bbeef";
  assert.deepEqual(agyResumeArgs([], id), ["--conversation", id]);
  assert.deepEqual(agyResumeArgs(["--model", "gemini-4-neon-high", "--effort=max", "-c", "--dangerously-skip-permissions"], id),
    ["--model", "gemini-4-neon-high", "--effort=max", "--dangerously-skip-permissions", "--conversation", id]);
  assert.deepEqual(agyResumeArgs(["--conversation", "old", "-i", "hello there"], id), ["--conversation", id]);
  assert.throws(() => agyResumeArgs(["--weird"], id), /Unknown agy option/);
  assert.throws(() => agyResumeArgs(["acp"], id), /subcommand/);
  assert.throws(() => agyResumeArgs(["--remote-agent"], id), /remote-agent/);
  assert.equal(agyPrompt("───\n> x\n───\n? for shortcuts"), "x");
  assert.equal(agyPrompt("───\n>\n───"), "");
  assert.equal(resumedAgyId(`Resume with -c (or command below):\nagy --conversation=${id}\n➜ x`), id);
  assert.equal(heldAgyId(`/Users/me/.gemini/antigravity-cli/log/x.log\n/Users/me/.gemini/antigravity-cli/brain/${id}`), id);
  assert.equal(isAgy({ app: "antigravity", address: "t3b" }), true);
  assert.equal(isAgy({ app: "antigravity", address: "vps/t3b" }), false);
});

test("Antigravity totals: each new turn row adds its tokens; the newest gives the context", () => {
  const rows = parseAgyRows(`7|${turn(1000, 512000)}\n8|${hex(msg([[3, 1]]))}\n9|${turn(2000, 512000)}\n`);
  assert.deepEqual(rows.map((r) => r.idx), [7, 9]);
  const st = addAgyRows({}, rows);
  assert.deepEqual(st, { context: 2000, window: 512000, calls: 2, totals: { input: 9120, output: 652, cacheRead: 735168 }, since: 9 });
  addAgyRows(st, parseAgyRows(`10|${turn(3000, 512000)}`));
  assert.deepEqual([st.calls, st.context, st.since, st.totals.output], [3, 3000, 10, 978]);
});

test("Codex details: totals without the cached part in input, turns started, the start time", () => {
  const tc = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 }, last_token_usage: { total_tokens: 900 }, model_context_window: 475000 } } });
  const r = parseRead(`${tc}\nTURNS 3\nSIZE 99`);
  assert.deepEqual([r.turns, r.size, r.st.context], [3, 99, 900]);
  assert.deepEqual(r.st.totals, { input: 200, cacheRead: 800, output: 50, reasoning: 20 });
  assert.equal(parseEtime(" 05:07\n", 1_000_000), 1_000_000 - 307_000);
  assert.equal(parseEtime("1-02:03:04", 1e9), 1e9 - (((24 + 2) * 60 + 3) * 60 + 4) * 1000);
  assert.equal(parseEtime("", 1), null);
});
