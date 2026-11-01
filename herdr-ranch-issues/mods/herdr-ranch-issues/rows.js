// Grouping, nesting and search over listed issues. Pure: no herdr or network.

const GROUPS = [["high", "High"], ["medium", "Medium"], ["low", "Low"], ["none", "No priority"]];

function priority(issue) {
  const name = issue.fields.priority?.name?.toLowerCase() ?? "";
  if (name === "highest" || name === "high" || name === "blocker" || name === "critical") return "high";
  if (name === "medium" || name === "major") return "medium";
  if (name === "low" || name === "lowest" || name === "minor" || name === "trivial") return "low";
  return "none";
}

// The text search looks in, built once per load: { raw, lower }.
export function haystack(issue) {
  const f = issue.fields;
  const raw = `${issue.key} ${f.summary} ${f.status?.name ?? ""} ${f.assignee?.displayName ?? ""} ${(f.labels ?? []).join(" ")} ${f.issuetype?.name ?? ""}`;
  return { raw, lower: raw.toLowerCase() };
}

// Every typed word must match somewhere; a word with a capital matches case-sensitively.
export const words = (query) => query.split(/\s+/).filter(Boolean);
export const matches = (hay, ws) => ws.every((w) => (/[A-Z]/.test(w) ? hay.raw : hay.lower).includes(w));

// Groups by priority, or one "Backlog" group in the given order (`order` "backlog"); a child
// sits under its parent when the parent is listed in the same group.
// A match's parent stays in view so the child keeps its place.
export function rows(issues, keep, order) {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const shown = new Set(issues.filter(keep).map((i) => i.key));
  for (const key of [...shown]) {
    const parent = byKey.get(key)?.fields.parent?.key;
    if (parent && byKey.has(parent)) shown.add(parent);
  }
  return (order === "backlog" ? [["backlog", "Backlog"]] : GROUPS).map(([id, label]) => {
    const list = issues.filter((i) => shown.has(i.key) && (id === "backlog" || priority(i) === id));
    const inGroup = new Set(list.map((i) => i.key));
    const children = new Map();
    for (const i of list) {
      const parent = i.fields.parent?.key;
      if (parent && inGroup.has(parent)) children.set(parent, [...(children.get(parent) ?? []), i]);
    }
    const out = [];
    const walk = (i, depth) => { out.push({ issue: i, depth }); for (const c of children.get(i.key) ?? []) walk(c, depth + 1); };
    for (const i of list) if (!(i.fields.parent?.key && inGroup.has(i.fields.parent.key))) walk(i, 0);
    return { id, label, rows: out };
  }).filter((g) => g.rows.length);
}

export function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
}

export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

export const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
