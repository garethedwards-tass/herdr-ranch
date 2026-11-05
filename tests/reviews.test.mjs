// The pure parts of Reviews: blocks, the feedback text, the CLI's output, the last message.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageOnly, splitBlocks, formatFeedback, outcomeText, pastePrompt, lastClaudeText, lastCodexText, quoteOf, stateOf, newId, matchBlocks, countMatches, hitsIn, docKey, newestPerDoc, carryDraft, markHits, abandon, orphaned, openFor, changedBlocks, foldRuns } from "../herdr-ranch-reviews/mods/herdr-ranch-reviews/reviews.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kinds = (md) => splitBlocks(md).map((b) => `${b.kind}:${b.start}-${b.end}`);

test("splitBlocks: headings, paragraphs, code, quotes, tables, rules, frontmatter", () => {
  const md = ["---", "title: x", "---", "# Title", "", "Para one", "goes on.", "", "```js", "a", "", "b", "```", "> quote", "> more", "", "| a | b |", "|---|---|", "", "***"].join("\n");
  assert.deepEqual(kinds(md), ["frontmatter:1-3", "heading:4-4", "paragraph:6-7", "code:9-13", "quote:14-15", "table:17-18", "rule:20-20"]);
});

test("splitBlocks: one block per top-level list item, nested lines and loose items included", () => {
  const md = ["- one", "  - nested", "- two", "", "- three", "  more of three", "", "Para", "1. first", "2. second"].join("\n");
  assert.deepEqual(kinds(md), ["item:1-2", "item:3-3", "item:5-6", "paragraph:8-8", "item:9-9", "item:10-10"]);
});

test("splitBlocks: an unclosed fence runs to the end; CRLF is read as LF", () => {
  assert.deepEqual(kinds("text\r\n\r\n```\r\ncode\r\nstill code"), ["paragraph:1-1", "code:3-5"]);
});

test("formatFeedback: Plannotator's format, block comments by line, general ones last", () => {
  const out = formatFeedback("file", [
    { text: "overall" },
    { start: 5, end: 7, quote: "B", text: "second\nline", images: ["/img/a.png"] },
    { start: 2, end: 2, quote: "A", text: "first" },
    { text: "  " },
  ]);
  assert.equal(out, [
    "# File Feedback", "", "I've reviewed this file and have 3 pieces of feedback:", "",
    '## 1. (line 2) Feedback on: "A"', "> first", "",
    '## 2. (lines 5-7) Feedback on: "B"', "> second", "> line", "> Screenshot: /img/a.png", "",
    "## 3. General feedback about the file", "> overall", "", "---",
  ].join("\n"));
  assert.match(formatFeedback("message", [{ text: "x" }]), /^# Message Feedback\n\nI've reviewed this message and have 1 piece of feedback:/);
  assert.equal(formatFeedback("file", [{ text: "" }]), "");
});

test("outcomeText: approved, feedback, dismissed, and --json", () => {
  const sent = { result: { decision: "annotated", feedback: "# File Feedback", comments: [{ text: "a" }, { text: "" }] } };
  assert.equal(outcomeText({ result: { decision: "approved" } }), "The user approved.");
  assert.equal(outcomeText(sent), "# File Feedback");
  assert.equal(outcomeText({ result: { decision: "dismissed" } }), "");
  assert.equal(outcomeText(null), "");
  assert.deepEqual(JSON.parse(outcomeText(sent, true)), { decision: "annotated", feedback: "# File Feedback", annotationCount: 1 });
});

test("pastePrompt: names the file or the message", () => {
  assert.equal(pastePrompt({ kind: "file", path: "docs/a.md", result: { decision: "approved" } }), "I reviewed `docs/a.md` in Herdr and approved it.");
  assert.equal(pastePrompt({ kind: "last", result: { decision: "annotated", feedback: "F" } }), "I reviewed your last message in Herdr.\n\nF");
});

test("lastClaudeText: the last assistant message with text, all its blocks, no sidechains", () => {
  const line = (o) => JSON.stringify(o);
  const lines = [
    line({ type: "user", message: { content: "question" } }),
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "old answer" }] } }),
    line({ type: "user", message: { content: "next" } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "part one" }] } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "part two" }] } }),
    line({ type: "user", toolUseResult: {}, message: { content: [{ type: "tool_result" }] } }),
    line({ type: "assistant", isSidechain: true, message: { id: "s", content: [{ type: "text", text: "subagent" }] } }),
    "not json",
  ];
  assert.equal(lastClaudeText(lines), "part one\n\npart two");
  assert.equal(lastClaudeText([line({ type: "user", message: { content: "hi" } })]), null);
});

test("lastCodexText: the folder from session_meta, the last assistant text", () => {
  const line = (o) => JSON.stringify(o);
  const lines = [
    line({ type: "session_meta", payload: { cwd: "/repo" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier" }] } }),
    line({ type: "event_msg", payload: { type: "agent_message", message: "the answer" } }),
    line({ type: "event_msg", payload: { type: "token_count" } }),
  ];
  assert.deepEqual(lastCodexText(lines), { cwd: "/repo", text: "the answer" });
  assert.deepEqual(lastCodexText(["{}"]), { cwd: null, text: null });
});

test("helpers: quoteOf trims and cuts, stateOf, newId sorts by time", () => {
  assert.equal(quoteOf("  abcdef  ", 3), "abc…");
  assert.equal(stateOf({ status: "sent", delivery: "kept" }), "undelivered");
  assert.equal(stateOf({ status: "approved", delivery: "kept" }), "undelivered");
  assert.equal(stateOf({ status: "dismissed", delivery: "kept" }), "dismissed");
  assert.equal(stateOf({ status: "open" }), "waiting");
  assert.equal(stateOf(null), "dismissed");
  assert.ok(newId(1.7e12, () => 0.99) < newId(1.7e12 + 1, () => 0));
});


test("imageOnly: a block of only images, linked or titled; anything else is null", () => {
  assert.deepEqual(imageOnly("![Issues: the list](herdr-ranch-issues/preview.png)"), [{ alt: "Issues: the list", src: "herdr-ranch-issues/preview.png" }]);
  assert.deepEqual(imageOnly('[![a](x.png "t")](https://e.x)\n![b](y.png)'), [{ alt: "a", src: "x.png" }, { alt: "b", src: "y.png" }]);
  assert.equal(imageOnly("Text with ![a](x.png) inside"), null);
  assert.equal(imageOnly(""), null);
});

test("matchBlocks: the visible text when rendered, the Markdown in Source; empty is null", () => {
  const blocks = splitBlocks(["# Title", "", "See [the guide](https://example.com/Guide).", "", "**Bold** words"].join("\n"));
  assert.equal(matchBlocks(blocks, "  "), null);
  assert.deepEqual(matchBlocks(blocks, "GUIDE"), [1]);
  assert.deepEqual(matchBlocks(blocks, "example.com"), []);
  assert.deepEqual(matchBlocks(blocks, "example.com", true), [1]);
  assert.deepEqual(matchBlocks(blocks, "bold words"), [2]);
  assert.deepEqual(matchBlocks(blocks, "**bold", true), [2]);
});

test("countMatches: every occurrence, in the visible text or the Markdown", () => {
  const blocks = splitBlocks(["Fox and fox", "", "[a fox](https://fox.dev)"].join("\n"));
  assert.equal(countMatches(blocks, "fox"), 3);
  assert.equal(countMatches(blocks, "fox", true), 4);
  assert.equal(countMatches(blocks, " "), 0);
});

test("hitsIn: cuts a line around every match, case-insensitive", () => {
  assert.deepEqual(hitsIn("a Foo b foo", "foo"), [["a ", false], ["Foo", true], [" b ", false], ["foo", true]]);
  assert.deepEqual(hitsIn("nothing", "x"), [["nothing", false]]);
  assert.deepEqual(hitsIn("abc", ""), [["abc", false]]);
});

test("docKey and newestPerDoc: one review per file, per agent's last message", () => {
  const a = { id: "m1", kind: "file", path: "/r/a.md" }, a2 = { id: "m3", kind: "file", path: "/r/a.md" };
  const l = { id: "m2", kind: "last", agent: { terminal: "t1" } }, odd = { id: "m4", kind: "last" };
  assert.equal(docKey(a), "file:/r/a.md");
  assert.equal(docKey(l), "last:t1");
  assert.equal(docKey(odd), "id:m4");
  assert.deepEqual(newestPerDoc([a, l, a2, odd]).map((r) => r.id).sort(), ["m2", "m3", "m4"]);
});

test("carryDraft: block comments follow their block, lost ones turn general", () => {
  const blocks = splitBlocks(["# New title", "", "Kept paragraph here.", "", "Other"].join("\n"));
  const draft = [
    { key: "a", block: 0, start: 1, end: 1, quote: "Kept paragraph", text: "keep" },
    { key: "b", block: 2, start: 5, end: 5, quote: "Gone text", text: "lost" },
    { key: "c", text: "general" },
  ];
  const out = carryDraft(draft, blocks);
  assert.deepEqual(out[0], { key: "a", block: 1, start: 3, end: 3, quote: "Kept paragraph", text: "keep" });
  assert.equal(out[1].block, undefined);
  assert.equal(out[1].text, '(line 5 before the update: "Gone text") lost');
  assert.deepEqual(out[2], { key: "c", text: "general" });
});

test("markHits: marks matches, not code spans, link targets or tags", () => {
  assert.equal(markHits("The Fox and the fox", "fox"), "The <mark>Fox</mark> and the <mark>fox</mark>");
  assert.equal(markHits("`fox` and [fox](https://fox.dev) <b>fox</b>", "fox"), "`fox` and [<mark>fox</mark>](https://fox.dev) <b><mark>fox</mark></b>");
  assert.equal(markHits("text", ""), "text");
});

test("abandon: an open review closes as abandoned; a finished one is left alone", () => {
  const open = { id: "a", status: "open", waiting: { pid: 42 }, draft: [{ key: "k", text: "x" }] };
  const out = abandon(open, Date.UTC(2026, 10, 5, 12));
  assert.equal(out.status, "dismissed");
  assert.equal(out.waiting, null);
  assert.equal(out.finishedAt, "2026-11-05T12:00:00.000Z");
  assert.deepEqual(out.result, { decision: "abandoned", comments: [] });
  assert.equal(abandon({ ...open, status: "sent" }), null);
  assert.equal(abandon(null), null);
});

test("ranch-review: SIGTERM marks its review abandoned and exits 130", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ranch-review-"));
  const bin = path.join(home, "bin"), dir = path.join(home, "app", "data", "herdr-ranch-reviews");
  fs.mkdirSync(bin); fs.mkdirSync(dir, { recursive: true });
  // A stand-in Herdr: `ls` knows no panes, `status` no window, `do` does nothing; no `hc`.
  fs.writeFileSync(path.join(bin, "herdr-app"), '#!/bin/sh\ncase "$1" in ls) echo \'{"spaces":[]}\';; status) echo "{}";; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".watcher"), ""); // a fresh heartbeat: no launcher pane
  const cli = fileURLToPath(new URL("../herdr-ranch-reviews/bin/ranch-review.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "last", "--stdin"], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HERDR_APP_HOME: path.join(home, "app"), HC_TERMINAL_ID: "t-test" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin.end("Please review this.");
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let file = null;
  for (let i = 0; i < 100 && !file; i++) {
    await new Promise((r) => setTimeout(r, 50));
    file = fs.readdirSync(dir).find((f) => f.endsWith(".json")) ?? null;
  }
  assert.ok(file, "the CLI wrote a review");
  const before = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  assert.equal(before.status, "open");
  assert.equal(before.waiting.pid, child.pid);
  child.kill("SIGTERM");
  assert.equal(await exited, 130);
  const after = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  assert.equal(after.status, "dismissed");
  assert.equal(after.result.decision, "abandoned");
  assert.equal(after.waiting, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("orphaned and stateOf: a dead waiting pid shows as abandoned; no pid is not", () => {
  const dead = () => false, live = () => true;
  const r = { status: "open", waiting: { pid: 58985 } };
  assert.equal(orphaned(r, dead), true);
  assert.equal(orphaned(r, live), false);
  assert.equal(orphaned({ status: "open", waiting: null }, dead), false); // stopped by an older CLI: pasted later
  assert.equal(orphaned({ ...r, status: "sent" }, dead), false);
  assert.equal(stateOf({ ...r, orphan: true }), "abandoned");
  assert.equal(stateOf(r), "waiting");
});

test("openFor: minutes, hours and minutes, days and hours", () => {
  const at = Date.UTC(2026, 10, 5, 12);
  const iso = (min) => new Date(at - min * 60000).toISOString();
  assert.equal(openFor(iso(0.5), at), "under a minute");
  assert.equal(openFor(iso(12), at), "12 min");
  assert.equal(openFor(iso(3 * 60 + 47), at), "3 h 47 min");
  assert.equal(openFor(iso(120), at), "2 h");
  assert.equal(openFor(iso(52 * 60 + 5), at), "2 d 4 h");
});

test("changedBlocks and foldRuns: new and changed blocks show, unchanged runs fold", () => {
  const sent = ["# Plan", "", "Step one.", "", "Step two.", "", "Step three.", "", "Old ending."].join("\n");
  const now = ["# Plan", "", "Step one.", "", "Step two.", "", "Step three.", "", "New ending.", "", "Step one."].join("\n");
  const blocks = splitBlocks(now);
  const changed = changedBlocks(blocks, sent);
  // The repeated "Step one." matches the earlier block only once: the second is new.
  assert.deepEqual(changed, [false, false, false, false, true, true]);
  assert.deepEqual(foldRuns(changed), [{ fold: [0, 3] }, { block: 4 }, { block: 5 }]);
  // A commented block stays; a single unchanged block between shown ones doesn't fold.
  assert.deepEqual(foldRuns(changed, new Set([2])), [{ fold: [0, 1] }, { block: 2 }, { block: 3 }, { block: 4 }, { block: 5 }]);
  // A clicked fold opens.
  assert.deepEqual(foldRuns(changed, new Set(), new Set([0])), [0, 1, 2, 3, 4, 5].map((block) => ({ block })));
  // No earlier text: everything is new.
  assert.deepEqual(changedBlocks(blocks, ""), blocks.map(() => true));
});

test("carryDraft with a diff: comments land on the right blocks of the grown file", () => {
  const sent = ["# Plan", "", "Step one.", "", "Step two."].join("\n");
  const grown = ["# Plan", "", "Intro added.", "", "Step one.", "", "Step two.", "", "Step three."].join("\n");
  const blocks = splitBlocks(grown);
  const draft = carryDraft([{ key: "a", block: 2, start: 5, end: 5, quote: "Step two.", text: "why?" }], blocks);
  assert.deepEqual(draft[0], { key: "a", block: 3, start: 7, end: 7, quote: "Step two.", text: "why?" });
  const changed = changedBlocks(blocks, sent);
  assert.deepEqual(changed, [false, true, false, false, true]);
  // The commented block is unchanged but stays visible; the rest of the unchanged run folds.
  assert.deepEqual(foldRuns(changed, new Set([draft[0].block])), [{ block: 0 }, { block: 1 }, { block: 2 }, { block: 3 }, { block: 4 }]);
  assert.deepEqual(foldRuns(changed), [{ block: 0 }, { block: 1 }, { fold: [2, 3] }, { block: 4 }]);
});
