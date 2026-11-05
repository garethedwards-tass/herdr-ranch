// The pure parts of Reviews: blocks, the feedback text, the CLI's output, the last message.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageOnly, splitBlocks, formatFeedback, outcomeText, pastePrompt, lastClaudeText, lastCodexText, quoteOf, stateOf, newId, matchBlocks, countMatches, hitsIn, docKey, newestPerDoc, carryDraft, markHits } from "../herdr-ranch-reviews/mods/herdr-ranch-reviews/reviews.js";

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
