// The diff views' highlighting glue: requests to ranch-highlight, whole files from git when the
// commits are local, the hunks' own lines otherwise, and spans back on the diff's lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { prepareFile } from "../herdr-ranch-prs/mods/herdr-ranch-prs/diff.js";
import { highlightFiles, spansOf } from "../herdr-ranch-prs/mods/herdr-ranch-prs/highlight.js";

const file = () => prepareFile({ filename: "a.js", status: "modified", patch: "@@ -10,2 +10,2 @@\n keep()\n-old()\n+new()" });

// A fake helper: answers each request with one span per line (the line's number as its class,
// so the tests can see which line a span came from), or an error for git requests when told.
function helper({ gitFails = false } = {}) {
  const asked = [];
  state.exec = (cmd, args) => {
    if (args[0] === "--languages") return { code: 0, stdout: "[]", stderr: "" };
    if (cmd === "mkdir" || cmd === "rm") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "--requests") {
      const reqs = state.lastWrite.trim().split("\n").map((l) => JSON.parse(l));
      asked.push(reqs);
      const out = reqs.map((r) => {
        if (r.git && gitFails) return { id: r.id, lang: "javascript", lines: [], error: "bad revision" };
        const n = r.git || r.file ? 20 : r.text.split("\n").length;
        return { id: r.id, lang: "javascript", lines: Array.from({ length: n }, (_, i) => [[0, 3, `${r.git ? "git" : "frag"}${i + 1}`]]) };
      });
      return { code: 0, stdout: out.map((o) => JSON.stringify(o)).join("\n"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return asked;
}

test("highlightFiles: whole files from git, each diff line gets its file line's spans", async () => {
  const asked = helper();
  const f = file();
  assert.equal(await highlightFiles([f], { cwd: "/repo", oldRev: "base", newRev: "head" }), true);
  assert.deepEqual(asked[0].map((r) => [r.id, r.git.rev, r.tab]), [["0:old", "base", 4], ["0:new", "head", 4]]);
  const [keep, del, add] = f.hunks[0].lines;
  assert.equal(spansOf(f, keep)[0][2], "git10");
  assert.equal(spansOf(f, del)[0][2], "git11");
  assert.equal(spansOf(f, add)[0][2], "git11");
  state.exec = null;
});

test("highlightFiles: without the commits, the hunk lines are highlighted instead", async () => {
  const asked = helper({ gitFails: true });
  const f = file();
  await highlightFiles([f], { cwd: "/repo", oldRev: "base", newRev: "head" });
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1].map((r) => [r.id, r.text]), [["0:old", "keep()\nold()"], ["0:new", "keep()\nnew()"]]);
  const [keep, del, add] = f.hunks[0].lines;
  assert.equal(spansOf(f, keep)[0][2], "frag1");
  assert.equal(spansOf(f, del)[0][2], "frag2");
  assert.equal(spansOf(f, add)[0][2], "frag2");
  state.exec = null;
});

test("highlightFiles: added files have no old side, and no helper leaves the diff plain", async () => {
  const asked = helper();
  const added = prepareFile({ filename: "n.js", status: "added", patch: "@@ -0,0 +1 @@\n+x" });
  await highlightFiles([added], null);
  assert.deepEqual(asked[0].map((r) => r.id), ["0:new"]);
  state.exec = () => ({ code: 127, stdout: "", stderr: "not found" });
  const plain = file();
  // The helper was found once this session; a missing one is covered by run() returning null.
  assert.equal(spansOf(plain, plain.hunks[0].lines[0]), null);
  state.exec = null;
});

test("highlightFiles: the working tree's side is read from the file on disk", async () => {
  const asked = helper();
  await highlightFiles([file()], { cwd: "/repo", oldRev: "HEAD", newRev: "" });
  assert.deepEqual(asked[0].map((r) => [r.id, r.git?.rev ?? null, r.file ?? null]), [["0:old", "HEAD", null], ["0:new", null, "/repo/a.js"]]);
  state.exec = null;
});

test("the diff view's files are the same in every mod that carries them", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (m, f) => readFileSync(new URL(`../${m}/mods/${m}/${f}`, import.meta.url), "utf8");
  for (const f of ["diff.js", "highlight.js"]) {
    for (const m of ["herdr-ranch-history", "herdr-ranch-changes"]) assert.equal(read(m, f), read("herdr-ranch-prs", f), `${m}/${f} differs from herdr-ranch-prs's: copy it over`);
  }
  // files-tab.js: the same, except where it imports its helpers from.
  const prs = read("herdr-ranch-prs", "files-tab.js").replace('from "./links.js"', 'from "./ui.js"');
  for (const m of ["herdr-ranch-history", "herdr-ranch-changes"]) assert.equal(read(m, "files-tab.js"), prs, `${m}/files-tab.js differs from herdr-ranch-prs's`);
});
