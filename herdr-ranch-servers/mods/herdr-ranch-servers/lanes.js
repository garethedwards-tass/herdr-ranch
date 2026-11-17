// herdr-ranch: lanes, read from the containers' own configuration (their labels), no CLI.
// A lane is one copy of a stack's app containers, with its own site and database, that a branch or
// worktree is served on. Whatever maintains the lanes writes these labels on each lane container
// (compose `labels:`); the panel only reads them:
//   lane           the lane's number ("1", "2", …)
//   lane.url       its site ("https://app-2.example.test/")
//   lane.database  its database
//   lane.owner     who or what it's held for ("PROJ-123"); empty or missing: free
//   lane.branch    the branch it serves for that owner
//   lane.serves    what it serves: "repo=path" pairs joined by ";"
// Containers of the same compose project without a lane label are the stack's shared ones.
// Pure; tested in tests/servers.test.mjs.

const laneOf = (c) => (/^\d+$/.test(c.labels?.lane ?? "") ? Number(c.labels.lane) : null);

const parseServes = (text) => String(text ?? "").split(";").map((p) => p.trim()).filter(Boolean)
  .map((p) => { const at = p.indexOf("="); return at > 0 ? { repo: p.slice(0, at), path: p.slice(at + 1) } : { repo: p, path: "" }; });

// [{ dir, lanes: [{ n, containers: [names], state, url, database, owner, branch, served }] }]
// for every compose project with lanes.
export function stacksOf(containers) {
  const byDir = new Map();
  for (const c of containers ?? []) {
    const n = c.dir ? laneOf(c) : null;
    if (n == null) continue;
    const lanes = byDir.get(c.dir) ?? new Map();
    byDir.set(c.dir, lanes);
    const l = lanes.get(n) ?? { n, containers: [], running: 0, url: "", database: "", owner: "", branch: "", served: [] };
    lanes.set(n, l);
    l.containers.push(c.name);
    if (c.state === "running") l.running++;
    const lb = c.labels;
    l.url ||= lb.url; l.database ||= lb.database; l.owner ||= lb.owner; l.branch ||= lb.branch;
    if (!l.served.length) l.served = parseServes(lb.serves);
  }
  return [...byDir].map(([dir, lanes]) => ({
    dir,
    lanes: [...lanes.values()].sort((a, b) => a.n - b.n).map(({ running, ...l }) => ({
      ...l, state: running === 0 ? "stopped" : running < l.containers.length ? "partly running" : "running",
    })),
  }));
}

// The containers by lane, then the stack's shared ones (nginx, SQL Server, ...), then everything else.
// [{ kind: "lane", lane, dir, containers } | { kind: "shared", dir, containers } | { kind: "other", containers }]
export function groupByLane(containers, stacks) {
  const used = new Set(), out = [];
  for (const st of stacks ?? []) {
    for (const lane of st.lanes) {
      const mine = containers.filter((c) => lane.containers.includes(c.name));
      mine.forEach((c) => used.add(c.name));
      out.push({ kind: "lane", lane, dir: st.dir, containers: mine });
    }
    const shared = containers.filter((c) => !used.has(c.name) && c.dir === st.dir);
    shared.forEach((c) => used.add(c.name));
    if (shared.length) out.push({ kind: "shared", dir: st.dir, containers: shared });
  }
  const rest = containers.filter((c) => !used.has(c.name));
  if (rest.length) out.push({ kind: "other", containers: rest });
  return out;
}

// A lane's pill: who holds it (the owner, else its branch), "stopped", or "free".
export function laneState(lane) {
  if (lane.state === "stopped") return { tone: "dim", text: "stopped" };
  if (lane.owner || lane.branch) return { tone: "held", text: lane.owner || lane.branch };
  return { tone: "ok", text: "free" };
}

export const hostOf = (url) => String(url ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
