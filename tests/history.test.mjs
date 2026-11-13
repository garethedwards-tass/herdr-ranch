// The History panel's git parsing: the log, one commit's files from `git show`, and the
// search query's git arguments. Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { parseLog, searchArgs, search } from "../herdr-ranch-history/mods/herdr-ranch-history/git.js";
import { parseShow } from "../herdr-ranch-history/mods/herdr-ranch-history/diff.js";

const US = "\x1f", RS = "\x1e";
const rec = (sha, parents, refs, title, at = "2026-11-12T10:00:00+10:00", author = "Ann") => [sha, sha.slice(0, 7), author, at, parents, refs, title].join(US) + RS;

test("parseLog: fields, merges, refs without HEAD", () => {
  const out = rec("a".repeat(40), "p1", "HEAD -> main, origin/main, tag: v1", "Fix it") + "\n" + rec("b".repeat(40), "p1 p2", "", "Merge pull request #2");
  const got = parseLog(out);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].refs, ["main", "origin/main", "tag: v1"]);
  assert.equal(got[0].merge, false);
  assert.equal(got[1].merge, true);
  assert.equal(got[1].title, "Merge pull request #2");
});

test("parseShow: modified, added, renamed and binary files, with patches from the first @@", () => {
  const text = [
    "diff --git a/src/a.js b/src/a.js", "index 1..2 100644", "--- a/src/a.js", "+++ b/src/a.js", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
    "diff --git a/new.txt b/new.txt", "new file mode 100644", "index 0..1", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hello",
    "diff --git a/old.cfc b/moved.cfc", "similarity index 100%", "rename from old.cfc", "rename to moved.cfc",
    "diff --git a/logo.png b/logo.png", "index 1..2 100644", "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");
  const got = parseShow(text);
  assert.deepEqual(got.map((f) => [f.filename, f.status, f.additions, f.deletions, f.previous_filename]), [
    ["src/a.js", "modified", 1, 1, null], ["new.txt", "added", 1, 0, null], ["moved.cfc", "renamed", 0, 0, "old.cfc"], ["logo.png", "modified", 0, 0, null],
  ]);
  assert.equal(got[0].patch, "@@ -1,2 +1,2 @@\n keep\n-old\n+new");
  assert.equal(got[2].patch, null);
  assert.equal(got[3].patch, null);
});

test("searchArgs: words, prefixes, quotes and a sha", () => {
  assert.deepEqual(searchArgs("payment schedules"), { args: ["-i", "-F"], words: "payment schedules", paths: [], sha: null });
  const a = searchArgs('author:ann path:finance.cfc code:getUser since:2.weeks message:"roll call"');
  assert.deepEqual(a.args, ["-i", "-F", "--author=ann", "-SgetUser", "--since=2.weeks", "--grep=roll call"]);
  assert.deepEqual(a.paths, [":(icase,glob)**/*finance.cfc*", ":(icase,glob)**/*finance.cfc*/**"]);
  assert.equal(searchArgs("0ac5875a9").sha, "0ac5875a9");
  assert.equal(searchArgs("0ac5875a9").words, "");
});

test("search: plain words search the message and the author, merged newest first; a sha finds that commit first", async () => {
  const ran = [];
  state.exec = (cmd, args) => {
    ran.push(args);
    if (args.some((a) => a.startsWith("--grep="))) return { code: 0, stdout: rec("1".repeat(40), "p", "", "Fix roll call", "2026-11-10T00:00:00Z"), stderr: "" };
    if (args.some((a) => a.startsWith("--author="))) return { code: 0, stdout: rec("2".repeat(40), "p", "", "Other", "2026-11-11T00:00:00Z", "Roll Call Bot"), stderr: "" };
    if (args.includes("-1")) return { code: 0, stdout: rec("abcdef0".padEnd(40, "0"), "p", "", "That one"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const repo = { top: "/repo", on: null };
  const got = await search(repo, "roll call", true);
  assert.deepEqual(got.map((c) => c.title), ["Other", "Fix roll call"]);
  assert.ok(ran.every((a) => a.includes("--all")));
  const bySha = await search(repo, "abcdef0", false);
  assert.deepEqual(bySha.map((c) => c.title), ["That one"]);
  state.exec = null;
});
