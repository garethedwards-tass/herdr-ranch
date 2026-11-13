// The Changes panel's git side: status entries, new files as additions, and the changes
// against HEAD in the diff view's shape. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { parseStatus, addedPatch, changes } from "../herdr-ranch-changes/mods/herdr-ranch-changes/git.js";

test("parseStatus: staged, unstaged, new and conflicted files", () => {
  const got = parseStatus("M  staged.js\0 M work.js\0MM both.js\0?? new.txt\0UU clash.cfc\0");
  assert.deepEqual(got.map((s) => [s.path, s.staged, s.unstaged, s.fresh, s.conflict]), [
    ["staged.js", true, false, false, false], ["work.js", false, true, false, false], ["both.js", true, true, false, false],
    ["new.txt", false, false, true, false], ["clash.cfc", true, true, false, true],
  ]);
});

test("addedPatch: a new file is all additions", () => {
  assert.deepEqual(addedPatch("a\nb\n"), { patch: "@@ -0,0 +1,2 @@\n+a\n+b", additions: 2 });
});

test("changes: the diff against HEAD, new files read from disk, binaries without a patch", async () => {
  const ran = [];
  state.files["/repo/new.txt"] = "hello\n";
  state.files["/repo/logo.png"] = "PNG\0data";
  state.exec = (cmd, args) => {
    ran.push(args);
    if (args.includes("status")) return { code: 0, stdout: " M a.js\0?? new.txt\0?? logo.png\0", stderr: "" };
    if (args.includes("rev-parse")) return { code: 0, stdout: "abc\n", stderr: "" };
    if (args.includes("diff")) return { code: 0, stdout: "diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const got = await changes({ root: "/repo", on: null });
  assert.equal(got.head, true);
  assert.deepEqual(got.files.map((f) => [f.path, f.status, f.additions, f.deletions, Boolean(f.why), f.unstaged, f.fresh]), [
    ["a.js", "modified", 1, 1, false, true, false], ["new.txt", "added", 1, 0, false, false, true], ["logo.png", "added", 0, 0, true, false, true],
  ]);
  // Reads only: no index refresh or lock.
  assert.ok(ran.every((a) => a[0] === "--no-optional-locks"));
  assert.ok(ran.some((a) => a.includes("diff") && a.includes("HEAD")));
  state.exec = null; delete state.files["/repo/new.txt"]; delete state.files["/repo/logo.png"];
});
