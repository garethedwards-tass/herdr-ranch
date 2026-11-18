// Each Claude Code agent's folder now, for the Spaces list (its agent badges on checkouts):
// shared("ranch-agent-places") = { <terminal>: { cwd, home } }. The folder is the latest record's
// cwd in its session (claude.js apply: st.cwd), which follows a `cd` or a worktree; Herdr's pane
// folder doesn't. Written only when it changes.
import { shared, setShared } from "herdr";

export const PLACES = "ranch-agent-places";

export function placesOf(claude) {
  const out = {};
  for (const [address, c] of claude ?? []) {
    // home: where the session started (its sessions/<pid>.json), which places its space when
    // Herdr's folder for the terminal is out of date; cwd: where it works now.
    const cwd = c?.st?.cwd || c?.cwd;
    if (cwd) out[address] = { cwd, ...(c?.cwd ? { home: c.cwd } : {}) };
  }
  return out;
}

export function publishPlaces(v) {
  const next = placesOf(v.claude);
  const text = JSON.stringify(next);
  if (text === v.placesText) return;
  v.placesText = text;
  if (text !== JSON.stringify(shared(PLACES) ?? {})) setShared(PLACES, next);
}
