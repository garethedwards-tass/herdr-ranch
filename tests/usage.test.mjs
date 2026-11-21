// The Usage mod's account side: one Claude Code reading per account.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerList } from "../herdr-ranch-usage/mods/herdr-ranch-usage/providers/index.js";
import { barModel, cardModel } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/view.js";
import { parseSession } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/session.js";
import { parse } from "../herdr-ranch-usage/mods/herdr-ranch-usage/providers/claude.js";
import { parse as parseAgy } from "../herdr-ranch-usage/mods/herdr-ranch-usage/providers/antigravity.js";
import { effectivePrefs } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/prefs.js";
import { expand } from "../herdr-ranch-usage/mods/herdr-ranch-usage/accounts.js";

const H = "/Users/me";
const work = { id: "work-1", label: "Work", claudeDir: "~/.claude-work" };
const personal = { id: "personal-1", label: "Personal", claudeDir: "/Users/me/.claude-personal/" };

test("providerList: the usual Claude, one per account with a folder, then Codex and Antigravity", () => {
  const list = providerList([work, { id: "gh", label: "GitHub only", ghUser: "x" }, personal], H, expand);
  assert.deepEqual(list.map((p) => [p.id, p.name, p.configDir, p.dir]), [
    ["claude", "Claude · Default", "", "/Users/me/.claude"],
    ["claude:work-1", "Claude · Work", "/Users/me/.claude-work", "/Users/me/.claude-work"],
    ["claude:personal-1", "Claude · Personal", "/Users/me/.claude-personal", "/Users/me/.claude-personal"],
    ["codex", "Codex", undefined, undefined],
    ["antigravity", "Antigravity", undefined, undefined],
  ]);
  assert.equal(list[1].helper, "helpers/claude-usage.sh");
});

test("providerList: an account on ~/.claude replaces the default; a shared folder is read once", () => {
  const list = providerList([{ id: "a", label: "A", claudeDir: "~/.claude" }, { id: "b", label: "B", claudeDir: "~/.claude/" }], H, expand);
  assert.deepEqual(list.map((p) => [p.id, p.configDir]), [["claude:a", ""], ["codex", undefined], ["antigravity", undefined]]);
  assert.deepEqual(providerList([], H, expand).map((p) => p.name), ["Claude", "Codex", "Antigravity"]);
});

const reply = (limits, plan = "pro") => JSON.stringify({ type: "control_response", response: { subtype: "success", response: { subscription_type: plan, rate_limits: { limits } } } });

test("barModel: per-account groups carry their account; one without limits stays off the bar", () => {
  const list = providerList([work, personal], H, expand);
  const now = 1000;
  const states = {
    "claude:work-1": { report: parse(reply([]), now), lastGood: null, installed: true },
    "claude:personal-1": { report: parse(reply([{ kind: "session", percent: 68, resets_at: 2000 }]), now), installed: true },
    claude: { report: null, installed: null },
    codex: { installed: false },
    antigravity: { installed: false },
  };
  states["claude:personal-1"].lastGood = states["claude:personal-1"].report;
  const bar = barModel(states, effectivePrefs(null, {}), now, list);
  assert.deepEqual(bar.groups.map((g) => [g.providerId, g.account?.label ?? null, g.mark, g.segments.length]),
    [["claude", null, "…", 0], ["claude:personal-1", "Personal", null, 1]]);
  const card = cardModel(states, now, list);
  assert.deepEqual(card.groups.map((g) => [g.name, g.status]),
    [["Claude · Default", "loading…"], ["Claude · Work", "No subscription limits"], ["Claude · Personal", "updated just now"]]);
});

test("parseSession: dir says which account's folder held the session", () => {
  assert.equal(parseSession("tokens=5000 calls=3 compactions=0 dir=2", "claude").dir, 2);
  assert.equal(parseSession("tokens=5000 window=9000 calls=1", "codex").dir, null);
});

test("providerList: the usual folder takes the name given for no account", () => {
  const list = providerList([work], H, expand, "Me");
  assert.equal(list[0].name, "Claude · Me");
});

test("antigravity: each model group's 5-hour and weekly quota as used percent; agy's errors read plainly", () => {
  const reply = { quota: { response: { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.75, resetTime: "2026-11-28T00:30:27Z" },
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.993, resetTime: "2026-11-21T05:30:27Z" }] },
    { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-21T05:37:42Z" }] },
    { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0 }] },
  ] } }, plan: "Pro" };
  const r = parseAgy(JSON.stringify(reply), 100);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, "Pro");
  assert.deepEqual(r.windows.map((w) => [w.id, w.short, w.long, w.percent, w.durationSec]), [
    ["gemini-weekly", "Gemini wk", "Gemini · Weekly", 25, 604800],
    ["gemini-5h", "Gemini 5h", "Gemini · 5-hour", 1, 18000],
    ["3p-5h", "Claude/GPT 5h", "Claude/GPT · 5-hour", 0, 18000],
    ["gemini-argon-wtu-weekly", "Argon wk", "Argon · Weekly", 100, 604800],
  ]);
  assert.equal(r.windows[0].resetsAt, Date.parse("2026-11-28T00:30:27Z") / 1000);
  const out = parseAgy(JSON.stringify({ quota: { code: "internal", message: "internal: failed: You are not logged into Antigravity. (error ID: abc)" }, plan: "" }), 100);
  assert.equal(out.status, "error");
  assert.equal(out.message, "failed: You are not logged into Antigravity.");
  assert.equal(parseAgy("", 100).status, "error");
});

test("providerList: one Codex per account with a Codex folder, after the usual one named like Claude's", () => {
  const list = providerList([{ id: "p", label: "Personal", codexHome: "~/.codex-personal" }, { id: "w", label: "Work", claudeDir: "~/.claude-work" }], H, expand, "Me");
  assert.deepEqual(list.filter((p) => p.id.startsWith("codex")).map((p) => [p.id, p.name, p.configDir, p.account?.label ?? null]),
    [["codex", "Codex · Me", undefined, null], ["codex:p", "Codex · Personal", `${H}/.codex-personal`, "Personal"]]);
  assert.deepEqual(providerList([{ id: "a", label: "A", codexHome: "~/.codex" }], H, expand).filter((p) => p.id.startsWith("codex")).map((p) => [p.id, p.configDir]), [["codex:a", ""]]);
});
