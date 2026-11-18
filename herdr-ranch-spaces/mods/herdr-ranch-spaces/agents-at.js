// Where each agent works now, and which checkout (main or worktree) that is.
// Herdr's pane folder is where the terminal's shell was when it last said; an agent that
// cd's (a Claude Code Bash `cd`, `-w`, a worktree) moves on without it. The Agents list keeps
// each Claude Code agent's folder from its session (every record carries its cwd) in
// shared("ranch-agent-places"): { <terminal>: { cwd, at } }. Other agents: the pane's folder.
// Pure: tested in tests/spaces.test.mjs.

import { checkoutAt } from "./git.js";

export const PLACES = "ranch-agent-places";
const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3 };

// ps: panes(); sp: spaces(); live: shared(PLACES). An agent is a pane Herdr reports a status for.
// Returns [{ terminal, pane, space, spaceName, cwd, status, name }].
export function agentPlaces(ps, sp, live = {}) {
  const spaceOf = new Map();
  for (const s of sp ?? []) for (const t of s.tabs ?? []) spaceOf.set(t.id, s);
  const out = [];
  for (const p of ps ?? []) {
    if (!p?.terminal || p.status == null) continue;
    const s = spaceOf.get(p.tab);
    out.push({ terminal: p.terminal, pane: p.pane, space: s?.id ?? null, spaceName: s?.name ?? "", machine: s?.machine ?? null,
      cwd: live?.[p.terminal]?.cwd || p.cwd || null, status: p.status, name: p.program?.name ?? "Agent" });
  }
  return out;
}

// The agents working in checkout `path` (the deepest checkout of `list` that holds their folder),
// leaving out those of space `except` (its own rows show them).
export function agentsIn(places, list, path, except = null, machine = null) {
  if (!path) return [];
  return (places ?? []).filter((a) => a.space !== except && (a.machine ?? null) === (machine ?? null) && checkoutAt(list, a.cwd)?.path === path)
    .sort((a, b) => (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9));
}

// A space's own agents working in another checkout than the space's (`home`), each with that
// checkout's path as `checkout`: the primary space's agent off in a worktree. Most urgent first.
export function agentsAway(places, list, space, home) {
  return (places ?? []).filter((a) => a.space === space).map((a) => ({ ...a, checkout: checkoutAt(list, a.cwd)?.path ?? null }))
    .filter((a) => a.checkout && home && a.checkout !== home)
    .sort((a, b) => (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9));
}

export const STATUS_WORD = { blocked: "needs you", done: "done", working: "working", idle: "idle" };
