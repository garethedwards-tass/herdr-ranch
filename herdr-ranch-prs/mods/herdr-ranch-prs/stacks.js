// Stacks of dependent pull requests, found in the list itself: a pull request whose base is
// another open pull request's head sits on top of it. Works for `gh stack` stacks and for
// stacks made by hand. Worked out once per load, never in a render.

import { hash, slug } from "./data.js";

// Only open pull requests of this repository: a fork's "fix" isn't the layer below, and a
// merged layer is no longer part of what still has to merge.
const member = (pr) => pr.state === "OPEN" && !pr.fork;

// The group of the least ready layer: your review first, then yours to fix, then ready only
// when every layer is.
function groupOf(prs) {
  const gs = new Set(prs.map((p) => p.group));
  if (gs.has("review")) return "review";
  if (gs.has("fix")) return "fix";
  return prs.every((p) => p.group === "ready") ? "ready" : "open";
}

// stacks(prs) -> [{ key, name, trunk, layers: [{ number, level }], group }], layers
// bottom first (depth-first, children by number), level from 1.
export function stacks(prs) {
  const open = prs.filter(member);
  const byHead = new Map(open.map((p) => [p.headRefName, p]));
  const children = new Map();
  for (const p of open) {
    const parent = byHead.get(p.baseRefName);
    if (parent && parent !== p) children.set(parent.number, [...(children.get(parent.number) ?? []), p]);
  }
  for (const list of children.values()) list.sort((a, b) => a.number - b.number);
  // A root's base is no open head; pull requests in a base cycle have no root and stay loose.
  const roots = open.filter((p) => !byHead.has(p.baseRefName) || byHead.get(p.baseRefName) === p).sort((a, b) => a.number - b.number);
  const out = [];
  for (const root of roots) {
    const layers = [], seen = new Set();
    const walk = (p, level) => {
      if (seen.has(p.number)) return;
      seen.add(p.number); layers.push({ pr: p, level });
      for (const c of children.get(p.number) ?? []) walk(c, level + 1);
    };
    walk(root, 1);
    if (layers.length < 2) continue;
    const members = layers.map((l) => l.pr);
    out.push({
      key: `stack-${root.number}`, name: root.title, trunk: root.baseRefName,
      layers: layers.map((l) => ({ number: l.pr.number, level: l.level })),
      group: groupOf(members),
    });
  }
  return out;
}

// The stack each pull request is a layer of.
export function stackOf(list) {
  const m = new Map();
  for (const s of list) for (const l of s.layers) m.set(l.number, s);
  return m;
}

// What a layer still needs before it can merge, for the agent: "1 failing check, changes requested".
function needs(pr) {
  const out = [];
  if (pr.isDraft) out.push("draft");
  if (pr.checks.fail > 0) out.push(`${pr.checks.fail} failing check${pr.checks.fail > 1 ? "s" : ""}`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push("changes requested");
  if (pr.checks.pending > 0) out.push("checks running");
  if (!out.length && pr.reviewDecision !== "APPROVED") out.push("waits on review");
  return out;
}

// What Start agent gets for a stack (besides kind, repo, machine, icon and ghStack): the
// placeholders, a branch and a tab per mode. prs: number -> slim pull request.
export function stackAgent(stack, prs, github) {
  const layers = stack.layers.map((l) => prs.get(l.number)).filter(Boolean);
  const bottom = stack.layers[0].number, top = stack.layers[stack.layers.length - 1].number;
  const blockers = layers.map((p) => [p, needs(p)]).filter(([, n]) => n.length).map(([p, n]) => `#${p.number}: ${n.join(", ")}`);
  const tail = `${bottom}-${slug(stack.name)}-${hash(`github-stack-${github}-${bottom}`)}`;
  return {
    key: `${stack.layers.length} PRs`, title: stack.name,
    vars: {
      title: stack.name, count: stack.layers.length, trunk: stack.trunk, top, bottom, repo: github,
      layers: layers.map((p) => `#${p.number} ${p.title} (${p.headRefName} → ${p.baseRefName})`).join("\n"),
      blockers: blockers.join("\n") || "none",
    },
    branches: { "stack-review": `agent/stack-review-${tail}`, "stack-fix": `agent/stack-${tail}` },
    tabs: { "stack-review": `Review stack ${stack.name}`.slice(0, 60), "stack-fix": `Fix stack ${stack.name}`.slice(0, 60) },
  };
}

// The mode Review with agent opens on: your own work gets fixed (a stack with any layer of
// yours, or your pull request's review comments), someone else's gets reviewed. `item` is a
// stack (with `layers`, and `prs`: number -> slim pull request) or a pull request.
export function agentMode(item, login, prs = null) {
  if (item.layers) return login && item.layers.some((l) => prs?.get(l.number)?.author?.login === login) ? "stack-fix" : "stack-review";
  return login && item.author?.login === login ? "comments" : "review";
}
