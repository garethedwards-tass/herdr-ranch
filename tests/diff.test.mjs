// The Files tab's diffs: parsing GitHub's per-file patches, pairing lines for the split view,
// cutting a long diff, and loading the files through gh. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { parsePatch, splitRows, prepareFile, visible, fileKey, MAX_CHARS } from "../herdr-ranch-prs/mods/herdr-ranch-prs/diff.js";
import { files as loadFiles } from "../herdr-ranch-prs/mods/herdr-ranch-prs/data.js";

const PATCH = [
  "@@ -40,5 +40,7 @@ export function refresh(token) {",
  "   const now = Date.now();",
  "-  if (token.exp < now) return null;",
  "+  if (!token || token.exp < now) {",
  "+    log.warn(\"expired\");",
  "+    return null;",
  "+  }",
  "   return token;",
  "\tdone();",
  "@@ -90,2 +92,1 @@",
  "-old();",
  "-older();",
  "+new();",
  "\\ No newline at end of file",
].join("\n");

test("parsePatch: hunks, numbers on each side, notes and tabs", () => {
  const hunks = parsePatch(`${PATCH}\n`);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, "@@ -40,5 +40,7 @@");
  assert.equal(hunks[0].context, "export function refresh(token) {");
  assert.deepEqual(hunks[0].lines.map((l) => [l.kind, l.old, l.new]), [
    ["ctx", 40, 40], ["del", 41, null], ["add", null, 41], ["add", null, 42], ["add", null, 43], ["add", null, 44], ["ctx", 42, 45],
  ]);
  // "\tdone();" isn't a diff line (no leading +, -, space or \): it's skipped.
  assert.deepEqual(hunks[1].lines.map((l) => [l.kind, l.old, l.new, l.text]), [
    ["del", 90, null, "old();"], ["del", 91, null, "older();"], ["add", null, 92, "new();"], ["note", null, null, "No newline at end of file"],
  ]);
});

test("parsePatch: a trailing newline adds no line, tabs become spaces, empty or missing patches give nothing", () => {
  const one = parsePatch("@@ -1 +1 @@\n-a\n+\tb\n");
  assert.deepEqual(one[0].lines.map((l) => [l.kind, l.text]), [["del", "a"], ["add", "    b"]]);
  assert.deepEqual(parsePatch(""), []);
  assert.deepEqual(parsePatch(null), []);
  assert.deepEqual(parsePatch("Binary files differ"), []);
});

test("splitRows: deletions beside the additions that follow, context on both sides", () => {
  const [a, b] = parsePatch(PATCH);
  const rows = splitRows(a);
  assert.deepEqual(rows.map((r) => [r.left?.old ?? null, r.left?.kind ?? null, r.right?.new ?? null, r.right?.kind ?? null]), [
    [40, "ctx", 40, "ctx"], [41, "del", 41, "add"], [null, null, 42, "add"], [null, null, 43, "add"], [null, null, 44, "add"], [42, "ctx", 45, "ctx"],
  ]);
  const rows2 = splitRows(b);
  assert.deepEqual(rows2.map((r) => (r.note ? "note" : [r.left?.old ?? null, r.right?.new ?? null])), [[90, 92], [91, null], "note"]);
});

test("prepareFile: renames, binaries and empty files say why there's no diff", () => {
  const f = prepareFile({ filename: "src/a.ts", status: "modified", additions: 4, deletions: 1, changes: 5, patch: PATCH });
  assert.equal(f.path, "src/a.ts");
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].rows.length, 6);
  assert.equal(f.why, null);
  assert.equal(prepareFile({ filename: "b.ts", previous_filename: "a.ts", status: "renamed", changes: 0 }).why, "Renamed without changes.");
  assert.equal(prepareFile({ filename: "b.ts", previous_filename: "a.ts", status: "renamed", changes: 0 }).from, "a.ts");
  assert.match(prepareFile({ filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 }).why, /Empty file added/);
  assert.match(prepareFile({ filename: "big.json", status: "modified", additions: 9000, deletions: 10, changes: 9010 }).why, /binary file, or too large/);
});

test("visible: a long diff is cut, counting each hunk header as a line", () => {
  const f = prepareFile({ filename: "a", status: "modified", patch: PATCH });
  const all = visible(f, "unified", 1000);
  assert.equal(all.total, 7 + 1 + 4 + 1);
  assert.equal(all.shown, all.total);
  const cut = visible(f, "unified", 5);
  assert.deepEqual(cut.hunks.map((h) => h.items.length), [4]);
  assert.equal(cut.shown, 5);
  const split = visible(f, "split", 1000);
  assert.equal(split.total, 6 + 1 + 3 + 1);
  assert.deepEqual(split.hunks.map((h) => h.items.length), [6, 3]);
});

test("fileKey: per pull request, head commit and path", () => {
  assert.equal(fileKey("o/r", 7, "abc", "src/a.ts"), "o/r#7@abc:src/a.ts");
  assert.notEqual(fileKey("o/r", 7, "abc", "a"), fileKey("o/r", 7, "def", "a"));
});

test("files: every page from gh api, one JSON object per line, prepared and capped", async () => {
  const ran = [];
  const page = (from, to) => Array.from({ length: to - from }, (_, i) => JSON.stringify({ filename: `f${from + i}.js`, status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1 +1 @@\n+x" })).join("\n");
  state.exec = (cmd, args) => { ran.push([cmd, ...args]); return { code: 0, stdout: `${page(0, 3)}\n`, stderr: "" }; };
  const got = await loadFiles(12, { github: "o/r", cwd: "/repo", on: null });
  assert.equal(got.length, 3);
  assert.equal(got[0].path, "f0.js");
  assert.equal(got[0].hunks[0].lines[0].kind, "add");
  assert.deepEqual(ran[0].slice(0, 3), ["gh", "api", "--paginate"]);
  assert.ok(ran[0].includes("repos/o/r/pulls/12/files?per_page=100"));
  state.exec = () => ({ code: 0, stdout: page(0, 350), stderr: "" });
  assert.equal((await loadFiles(1, { github: "o/r", cwd: "/repo", on: null })).length, 300);
  state.exec = null;
});

test("parsePatch: a very long line is cut and says how much is left", () => {
  const [h] = parsePatch(`@@ -0,0 +1 @@\n+${"x".repeat(MAX_CHARS + 25)}`);
  assert.equal(h.lines[0].text, `${"x".repeat(MAX_CHARS)} … 25 more characters`);
});
