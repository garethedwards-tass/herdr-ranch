// The Usage mod's account side: one Claude Code reading per account.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerList } from "../herdr-ranch-usage/mods/herdr-ranch-usage/providers/index.js";
import { barModel, cardModel } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/view.js";
import { parseSession } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/session.js";
import { parse } from "../herdr-ranch-usage/mods/herdr-ranch-usage/providers/claude.js";
import { effectivePrefs } from "../herdr-ranch-usage/mods/herdr-ranch-usage/lib/prefs.js";
import { expand } from "../herdr-ranch-usage/mods/herdr-ranch-usage/accounts.js";

const H = "/Users/me";
const work = { id: "work-1", label: "Work", claudeDir: "~/.claude-work" };
const personal = { id: "personal-1", label: "Personal", claudeDir: "/Users/me/.claude-personal/" };

test("providerList: the usual Claude, one per account with a folder, then Codex", () => {
  const list = providerList([work, { id: "gh", label: "GitHub only", ghUser: "x" }, personal], H, expand);
  assert.deepEqual(list.map((p) => [p.id, p.name, p.configDir, p.dir]), [
    ["claude", "Claude · Default", "", "/Users/me/.claude"],
    ["claude:work-1", "Claude · Work", "/Users/me/.claude-work", "/Users/me/.claude-work"],
    ["claude:personal-1", "Claude · Personal", "/Users/me/.claude-personal", "/Users/me/.claude-personal"],
    ["codex", "Codex", undefined, undefined],
  ]);
  assert.equal(list[1].helper, "helpers/claude-usage.sh");
});

test("providerList: an account on ~/.claude replaces the default; a shared folder is read once", () => {
  const list = providerList([{ id: "a", label: "A", claudeDir: "~/.claude" }, { id: "b", label: "B", claudeDir: "~/.claude/" }], H, expand);
  assert.deepEqual(list.map((p) => [p.id, p.configDir]), [["claude:a", ""], ["codex", undefined]]);
  assert.deepEqual(providerList([], H, expand).map((p) => p.name), ["Claude", "Codex"]);
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
