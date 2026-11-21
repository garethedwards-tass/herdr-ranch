// Antigravity CLI (agy): its local language server's RetrieveUserQuotaSummary
// (helpers/antigravity-limits.sh). agy authenticates itself; nothing here sees a token.
// The reply: groups of models (Gemini, Claude and GPT, Argon), each with buckets
// { bucketId, window: "5h" | "weekly", remainingFraction, resetTime }.
import { makeWindow, okReport, errorReport, unavailableReport, toEpoch, jsonLines } from "../lib/report.js";

const SOURCE = "agy";
const HOUR = 3600;
const SPAN = { "5h": [5 * HOUR, "5h", "5-hour"], weekly: [7 * 24 * HOUR, "wk", "Weekly"] };
// A group's short name from its buckets' ids (gemini-5h, 3p-weekly…); else its own name.
const GROUP = { gemini: "Gemini", "3p": "Claude/GPT", "gemini-argon-wtu": "Argon" };

function groupName(g) {
  const id = String(g.buckets?.[0]?.bucketId ?? "").replace(/-(5h|weekly)$/, "");
  return GROUP[id] ?? String(g.displayName ?? "Models").replace(/ models?$/i, "");
}

function windowsOf(g) {
  const name = groupName(g);
  return (g.buckets ?? []).filter((b) => b && b.remainingFraction != null).map((b) => {
    const [durationSec, short, long] = SPAN[b.window] ?? [null, b.window ?? "limit", b.displayName ?? "Limit"];
    return makeWindow({
      id: b.bucketId ?? `${name}:${b.window}`,
      short: `${name} ${short}`,
      long: `${name} · ${long}`,
      percent: Math.max(0, Math.min(100, (1 - Number(b.remainingFraction)) * 100)),
      resetsAt: toEpoch(b.resetTime),
      durationSec,
    });
  });
}

export function parse(text, now) {
  const msg = jsonLines(text).find((m) => m.quota);
  if (!msg) return errorReport(SOURCE, "No reply from agy", now);
  const q = msg.quota;
  if (!q.response) return errorReport(SOURCE, String(q.message ?? "agy could not read quota").replace(/^internal: /, "").replace(/ \(error ID: [^)]*\)$/, ""), now);
  const windows = (q.response.groups ?? []).flatMap(windowsOf);
  if (windows.length === 0) return unavailableReport(SOURCE, "No quota limits", now);
  return okReport(SOURCE, now, windows, msg.plan || null);
}

export default {
  id: "antigravity",
  name: "Antigravity",
  icon: "icons/antigravity.svg",
  helper: "helpers/antigravity-limits.sh",
  parse,
};
