// herdr-ranch: docker where Herdr's PATH doesn't reach it. Herdr's processes get a login shell's PATH,
// which misses folders added in ~/.zshrc (Rancher Desktop's ~/.rd/bin, OrbStack's ~/.orbstack/bin).
// Sets $D to the first docker found: on the PATH, then the usual install folders (macOS: Rancher Desktop,
// OrbStack, Docker Desktop, Homebrew; Linux; Windows under Git for Windows' sh: Docker Desktop, Rancher
// Desktop, Podman); empty when none.
export const FIND_DOCKER = `D=$(command -v docker 2>/dev/null); if [ -z "$D" ]; then for p in "$HOME/.rd/bin/docker" "$HOME/.orbstack/bin/docker" "$HOME/.docker/bin/docker" /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker" /usr/bin/docker /snap/bin/docker "$HOME/.rd/bin/docker.exe" "/c/Program Files/Docker/Docker/resources/bin/docker.exe" "/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe" "$LOCALAPPDATA/Programs/Rancher Desktop/resources/resources/win32/bin/docker.exe" "/c/Program Files/RedHat/Podman/podman.exe"; do if [ -x "$p" ]; then D=$p; break; fi; done; fi`;

// One shell script per machine per refresh: load, memory, disk, uptime and docker containers,
// as key=value lines (c= lines are tab-separated containers). Linux and macOS.
export const PROBE = `
${FIND_DOCKER}
echo "os=$(uname -s)"
if [ -r /proc/loadavg ]; then echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"; else echo "load=$(sysctl -n vm.loadavg | tr -d '{}')"; fi
echo "cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
if command -v free >/dev/null 2>&1; then free -b | awk '/^Mem:/{print "mem="$2" "$7}'
elif command -v vm_stat >/dev/null 2>&1; then echo "mem=$(sysctl -n hw.memsize) $(vm_stat | awk '/page size of/{ps=$8} /Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} END{print (f+i+s)*ps}')"; fi
df -Pk / | awk 'NR==2{print "disk="$2" "$3" "$4}'
if [ -r /proc/uptime ]; then echo "uptime=$(cut -d' ' -f1 /proc/uptime)"; else echo "uptime=$(( $(date +%s) - $(sysctl -n kern.boottime | awk -F'[ ,]+' '{print $4}') ))"; fi
if [ -n "$D" ]; then
  if out=$("$D" ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Label "com.docker.compose.service"}}\\t{{.Label "lane"}}\\t{{.Label "lane.url"}}\\t{{.Label "lane.database"}}\\t{{.Label "lane.owner"}}\\t{{.Label "lane.branch"}}\\t{{.Label "lane.serves"}}' 2>&1); then
    printf '%s\\n' "$out" | sed '/^$/d; s/^/c=/'
    "$D" stats --no-stream --format '{{.Name}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.CPUPerc}}' 2>/dev/null | sed '/^$/d; s/^/s=/'
  else echo "docker_err=$(printf '%s' "$out" | head -1)"; fi
else echo "docker_err=not installed"; fi
`;

const number = (text) => Number(String(text).trim().replace(",", "."));

function parseContainer(line) {
  const [id, name, state, status, image, project, dir, service, lane, url, database, owner, branch, serves] = line.split("\t");
  // herdr-ranch: the compose folder and service, and the lane.* labels (lanes.js).
  const labels = { lane: lane || "", url: url || "", database: database || "", owner: owner || "", branch: branch || "", serves: serves || "" };
  return { id, name, state, status, image, project: project || "", dir: dir || "", service: service || "", labels };
}

// { load: [1m, 5m, 15m], cpus, mem: { total, available } | null, disk: { total, used, free } (bytes),
//   uptime (s), docker: { error } | { containers } }.
export function parseProbe(out) {
  const result = { load: null, cpus: null, mem: null, disk: null, uptime: null, docker: { containers: [] } };
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1);
    const parts = value.trim().split(/\s+/).map(number);
    if (key === "load") result.load = parts.slice(0, 3);
    if (key === "cpus") result.cpus = parts[0];
    if (key === "mem" && parts.length === 2) result.mem = { total: parts[0], available: parts[1] };
    if (key === "disk") result.disk = { total: parts[0] * 1024, used: parts[1] * 1024, free: parts[2] * 1024 };
    if (key === "uptime") result.uptime = parts[0];
    if (key === "c") result.docker.containers.push(parseContainer(value));
    if (key === "s") { const [name, mem, memPct, cpuPct] = value.split("\t"); (result.stats ??= {})[name] = { mem: (mem ?? "").trim(), memPct: parseFloat(memPct) || 0, cpuPct: parseFloat(cpuPct) || 0 }; }
    if (key === "docker_err") result.docker = { error: /permission denied/i.test(value) ? "no permission" : value.trim() };
  }
  // herdr-ranch: each running container's memory and CPU (docker stats), on the container.
  if (result.docker.containers) for (const c of result.docker.containers) if (result.stats?.[c.name]) c.usage = result.stats[c.name];
  delete result.stats;
  return result;
}

// herdr-ranch: "2.853GiB / 3GiB" -> "2.9 GB"; "9.367MiB / 128MiB" -> "9 MB".
export function memShort(mem) {
  const m = /^([\d.]+)\s*([KMGT]i?B)/i.exec(mem ?? "");
  if (!m) return null;
  const n = Number(m[1]), unit = m[2][0].toUpperCase();
  if (unit === "K") return `${Math.max(1, Math.round(n / 1024))} MB`;
  if (unit === "M") return n >= 1000 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ${unit}B`;
}

// ok | starting | stopped (exited 0) | unhealthy | restarting | down | the docker state.
export function containerHealth(c) {
  if (c.state === "running") {
    if (/\(unhealthy\)/.test(c.status)) return "unhealthy";
    return /health: starting/.test(c.status) ? "starting" : "ok";
  }
  if (c.state === "restarting") return "restarting";
  if (c.state === "exited" || c.state === "dead") return /^Exited \(0\)/.test(c.status) ? "stopped" : "down";
  return c.state;
}

export const needsAttention = (c) => ["unhealthy", "restarting", "down"].includes(containerHealth(c));

// Percentages for the three meters; null when the machine didn't say.
export function usage(stats) {
  const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : null);
  return {
    cpu: stats.load && stats.cpus ? pct(stats.load[0], stats.cpus) : null,
    mem: stats.mem ? pct(stats.mem.total - stats.mem.available, stats.mem.total) : null,
    disk: stats.disk ? pct(stats.disk.used, stats.disk.used + stats.disk.free) : null,
  };
}

// Containers that went bad, or came back, between two looks at one machine. The first look says nothing.
export function containerAlerts(before, after) {
  if (!before?.docker?.containers || !after?.docker?.containers) return [];
  const was = new Map(before.docker.containers.map((c) => [c.name, needsAttention(c)]));
  return after.docker.containers.flatMap((c) => {
    if (!was.has(c.name) || was.get(c.name) === needsAttention(c)) return [];
    return [{ name: c.name, health: containerHealth(c), down: needsAttention(c) }];
  });
}

// herdr-ranch: a container's status in a few characters, for its pill: what's wrong ("unhealthy",
// "restarting", "exit 137"), "stopped", or for a fine one its memory ("2.9 GB · 95%" of its limit),
// else how long it's been up ("up 2h").
export function shortStatus(c) {
  const h = containerHealth(c);
  if (h === "unhealthy" || h === "restarting" || h === "starting") return h;
  if (h === "stopped") return "stopped";
  if (h === "down") { const code = /Exited \((\d+)\)/.exec(c.status ?? "")?.[1]; return code ? `exit ${code}` : c.state || "down"; }
  if (c.usage && memShort(c.usage.mem)) return `${memShort(c.usage.mem)} · ${Math.round(c.usage.memPct)}%`;
  return upFor(c);
}

// herdr-ranch: how long a running container has been up: "up 2h", "up 5m", "up <1m".
export function upFor(c) {
  const m = /^Up (?:(About an?|Less than an?|\d+) )?(second|minute|hour|day|week|month|year)/i.exec(c.status ?? "");
  if (!m) return c.state || "?";
  if (/less/i.test(m[1] ?? "") || /second/i.test(m[2])) return "up <1m";
  const n = /^\d+$/.test(m[1] ?? "") ? m[1] : "1";
  return `up ${n}${{ minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" }[m[2].toLowerCase()]}`;
}

// herdr-ranch: a machine's state for its pill: { tone: ok | warn | bad | dim, text }.
// bad: offline, an error, containers that need you, or memory at 90%; warn: memory at 75% or more; dim: not read
// yet or no docker; ok: every container fine. Text: running/total and memory ("6/6 · 77%").
export function machineState(entry) {
  if (!entry) return { tone: "dim", text: "…" };
  if (entry.offline) return { tone: "bad", text: "offline" };
  if (entry.error) return { tone: "bad", text: "error" };
  const d = entry.data, all = d.docker.containers ?? [], bad = all.filter(needsAttention).length;
  if (bad) return { tone: "bad", text: `${bad} need you` };
  const top = usage(d).mem ?? 0; // memory decides: CPU and disk are in the menu
  // Its memory goes on the pill too ("6/6 · 77%"): the line of meters under it is gone.
  const mem = usage(d).mem, m = mem == null ? "" : ` · ${mem}%`;
  const text = (d.docker.error ? "no docker" : all.length ? `${all.filter((c) => c.state === "running").length}/${all.length}` : "none") + m;
  return { tone: top >= 90 ? "bad" : top >= 75 ? "warn" : d.docker.error ? "dim" : "ok", text };
}
