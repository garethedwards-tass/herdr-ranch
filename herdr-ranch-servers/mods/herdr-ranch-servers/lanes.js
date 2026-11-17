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
// Labels change only when a container is recreated, and a change may recreate only some of a lane's
// containers: who holds it (lane.owner, lane.branch, lane.serves) comes from its newest container.
// Shared: Servers lists the lanes, Spaces badges the worktrees they serve (shared/lanes.js, copied
// into both). Tested in tests/servers.test.mjs.

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
    const l = lanes.get(n) ?? { n, containers: [], running: 0, url: "", database: "", owner: "", branch: "", served: [], newest: null };
    lanes.set(n, l);
    l.containers.push(c.name);
    if (c.state === "running") l.running++;
    const lb = c.labels;
    l.url ||= lb.url; l.database ||= lb.database;
    // docker's CreatedAt ("2026-11-17 02:49:34 +1000 AEST") sorts as text on one machine.
    if (l.newest == null || (c.created ?? "") > l.newest) {
      l.newest = c.created ?? "";
      l.owner = lb.owner; l.branch = lb.branch; l.served = parseServes(lb.serves);
    }
  }
  return [...byDir].map(([dir, lanes]) => ({
    dir,
    lanes: [...lanes.values()].sort((a, b) => a.n - b.n).map(({ running, newest, ...l }) => ({
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

// Docker where Herdr's PATH doesn't reach it. Herdr's processes get a login shell's PATH, which misses
// folders added in ~/.zshrc (Rancher Desktop's ~/.rd/bin, OrbStack's ~/.orbstack/bin). Sets $D to the
// first docker found: on the PATH, then the usual install folders (macOS: Rancher Desktop, OrbStack,
// Docker Desktop, Homebrew; Linux; Windows under Git for Windows' sh: Docker Desktop, Rancher Desktop,
// Podman); empty when none.
export const FIND_DOCKER = `D=$(command -v docker 2>/dev/null); if [ -z "$D" ]; then for p in "$HOME/.rd/bin/docker" "$HOME/.orbstack/bin/docker" "$HOME/.docker/bin/docker" /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker" /usr/bin/docker /snap/bin/docker "$HOME/.rd/bin/docker.exe" "/c/Program Files/Docker/Docker/resources/bin/docker.exe" "/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe" "$LOCALAPPDATA/Programs/Rancher Desktop/resources/resources/win32/bin/docker.exe" "/c/Program Files/RedHat/Podman/podman.exe"; do if [ -x "$p" ]; then D=$p; break; fi; done; fi`;

// The lane labels as `docker ps --format` fields (tab-separated, for a shell's single quotes), and
// those fields back as labels. Servers' probe and LANES_READ both use them.
const LABELS = ["lane", "url", "database", "owner", "branch", "serves"];
export const LANE_FORMAT = LABELS.map((k) => `{{.Label "${k === "lane" ? "lane" : `lane.${k}`}"}}`).join("\\t");
export const labelsOf = (fields) => Object.fromEntries(LABELS.map((k, i) => [k, fields[i] || ""]));

// Only the lane containers, one tab-separated line each: what Spaces needs for its badges.
export const LANES_READ = `${FIND_DOCKER}; [ -n "$D" ] || exit 0; "$D" ps -a --filter label=lane --format '{{.Names}}\\t{{.State}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t${LANE_FORMAT}\\t{{.CreatedAt}}'`;

// LANES_READ's output as containers for stacksOf.
export function parseLaneRead(text) {
  return String(text ?? "").split("\n").filter((l) => l.includes("\t")).map((line) => {
    const f = line.split("\t");
    return { name: f[0], state: f[1], dir: f[2] || "", labels: labelsOf(f.slice(3, 3 + LABELS.length)), created: f[3 + LABELS.length] || "" };
  });
}

// The lane serving the checkout at `path` (a worktree's folder), or null.
export function laneAt(stacks, path) {
  if (!path) return null;
  const clean = (p) => String(p).replace(/\/+$/, "");
  for (const st of stacks ?? []) for (const l of st.lanes) if (l.served.some((w) => clean(w.path) === clean(path))) return l;
  return null;
}
