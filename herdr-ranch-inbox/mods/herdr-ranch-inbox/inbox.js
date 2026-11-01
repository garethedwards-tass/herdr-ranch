// Plannotator for the Ranch mods, through its documented CLI only: the open sessions
// (`plannotator sessions`: the plan, document and code review pages agents opened for you) and
// `plannotator review <PR URL>`. Pages open in the default browser. Read only.
// Source: the repository's shared/, copied into each mod.

import { exec, home, window as appWindow } from "herdr";
import { openUrl } from "./links.js";

const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };
// A login shell: the person's own ($SHELL, so bash, zsh and fish all work), else zsh on macOS
// and sh elsewhere. `cmd` must read the same in each of them.
const shell = (cmd) => (platform() === "windows"
  ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd])
  : exec("sh", ["-c", `exec "\${SHELL:-${platform() === "macos" ? "/bin/zsh" : "/bin/sh"}}" -lc "$1"`, "sh", cmd]));

// A program's full path from a login shell (Herdr's own PATH may lack ~/.local/bin). A path
// found is kept; a miss is asked again next time (it may have been installed since).
const found = new Map();
export function which(name) {
  if (!found.has(name)) {
    const ask = (async () => {
      const r = await (platform() === "windows" ? shell(`(Get-Command ${name} -ErrorAction SilentlyContinue).Source`) : shell(`command -v ${name}`)).catch(() => null);
      const path = r?.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
      return path || null;
    })().catch(() => null);
    found.set(name, ask);
    ask.then((path) => { if (!path && found.get(name) === ask) found.delete(name); });
  }
  return found.get(name);
}

// `plannotator sessions` as text (the documented output), one session per line:
//   #2   annotate   -   agent-rkt-1438-checkout-fails-w   http://localhost:52544   17h 52m ago   /path/to/file.md
export function parseSessions(text) {
  const out = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*#(\d+)\s+(\S+)\s+\S+\s+(.+?)\s+(https?:\/\/\S+)\s+(.+?\bago)\s*(.*)$/.exec(line);
    if (!m) continue;
    const label = m[6].trim();
    out.push({ index: Number(m[1]), mode: m[2], project: m[3].trim(), url: m[4], age: m[5], label: label && label !== "-" ? label : null, startedAt: null, pid: null, folder: null });
  }
  return out;
}

// The open sessions: [{ index, mode, url, project, label, startedAt, age, pid, folder }].
// `--json` when it answers (it gives the start time and the process), else the text. `folder`
// is the session's working folder, from its process (lsof on macOS, /proc on Linux), else the
// folder of an absolute file it reviews; null when neither is known.
export async function readSessions() {
  const p = await which("plannotator");
  if (!p) return null;
  let list = null;
  const j = await exec(p, ["sessions", "--json"]).catch(() => null);
  if (j?.code === 0) { try { const v = JSON.parse(j.stdout); if (Array.isArray(v)) list = v; } catch { /* the text below */ } }
  if (!list) {
    const t = await exec(p, ["sessions"]).catch(() => null);
    list = parseSessions(t?.stdout ?? "");
  }
  const os = platform();
  await Promise.all(list.map(async (x) => {
    x.folder = null;
    if (Number.isInteger(x.pid) && os === "macos") {
      const c = await exec("lsof", ["-b", "-w", "-a", "-p", String(x.pid), "-d", "cwd", "-Fn"]).catch(() => null);
      x.folder = /^n(.+)$/m.exec(c?.stdout ?? "")?.[1] ?? null;
    } else if (Number.isInteger(x.pid) && os === "linux") {
      const c = await exec("readlink", [`/proc/${x.pid}/cwd`]).catch(() => null);
      x.folder = c?.code === 0 ? c.stdout.trim() : null;
    }
    if (!x.folder && x.label && /^(\/|[A-Za-z]:[\\/])/.test(x.label)) x.folder = x.label.replace(/[\\/][^\\/]*$/, "");
    // Whether its server still listens on its port (Herdr's fetch can't reach local pages, so the
    // system is asked): a session whose server is gone is only a stale record. Unknown: null.
    const port = Number(x.port ?? /:(\d+)/.exec(x.url ?? "")?.[1]);
    if (port) {
      const r = await (os === "windows"
        ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`])
        : exec("lsof", ["-b", "-w", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).catch(() => null);
      x.alive = !r ? null : os === "windows" ? /yes/.test(r.stdout ?? "") : Boolean((r.stdout ?? "").trim());
    } else x.alive = null;
  }));
  return list;
}

// Removes the records of sessions whose server is gone (`plannotator sessions --clean`).
export async function cleanSessions() {
  const p = await which("plannotator");
  if (p) await exec(p, ["sessions", "--clean"]).catch(() => null);
}

// × on a session: a running one is stopped (stopSession), a stopped one's record removed. The
// CLI's --clean comes first; when Plannotator keeps the record anyway (its old process id now
// belongs to another program), the record file itself goes, but only while nothing listens on
// the session's port. Returns null, or why not.
export async function closeSession(x) {
  if (x.alive) { const failed = await stopSession(x); if (failed) return failed; }
  await cleanSessions();
  const still = ((await readSessions()) ?? []).find((y) => y.url === x.url);
  if (!still) return null;
  if (still.alive) return x.alive ? "It's still running." : null;
  if (!Number.isInteger(still.pid)) return "Plannotator keeps this record; its process isn't known.";
  const file = `${home()}/.plannotator/sessions/${still.pid}.json`;
  const r = await (platform() === "windows"
    ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force`])
    : exec("rm", ["-f", file])).catch(() => null);
  return r?.code === 0 ? null : "The record couldn't be removed.";
}

// Stops a running session's server (its page closes; the agent waiting on it gets no
// feedback). Only a process that really is Plannotator's is stopped, so a reused process id
// can't be hit. Returns null, or why not.
export async function stopSession(x) {
  if (!Number.isInteger(x?.pid) || x.pid <= 1) return "This session's process isn't known.";
  const os = platform();
  if (os === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${x.pid} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'plannotator|bun|node') { Stop-Process -Id ${x.pid}; 'ok' }`]).catch(() => null);
    return /ok/.test(r?.stdout ?? "") ? null : "That process isn't Plannotator's.";
  }
  const ps = await exec("ps", ["-p", String(x.pid), "-o", "command="]).catch(() => null);
  if (!/plannotator/i.test(ps?.stdout ?? "")) return "That process isn't Plannotator's anymore.";
  const r = await exec("kill", [String(x.pid)]).catch(() => null);
  return r?.code === 0 ? null : (r?.stderr || "It couldn't be stopped.").trim();
}

// Whether a session belongs to a space: by its folder, else by its project name (the folder's
// name, cut to 30 characters) against the space's folder, repository and worktrees.
export function sessionInSpace(x, space, main) {
  if (x.folder) return inSpace(x.folder, space, main);
  const names = [space?.folder, main].filter(Boolean).map((f) => f.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop());
  return Boolean(x.project) && names.some((n) => n === x.project || (x.project.length >= 30 && n.startsWith(x.project)));
}

// Whether a folder belongs to a space: the space's folder, its repository's main checkout, or
// one of that repository's worktrees (~/.herdr/worktrees/<repo>/…).
const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export function inSpace(root, space, main) {
  const r = norm(root);
  if (!r) return false;
  const folders = [norm(space?.folder), norm(main)].filter(Boolean);
  if (folders.some((f) => r === f || r.startsWith(`${f}/`))) return true;
  const name = norm(main || space?.folder).split("/").pop();
  return Boolean(name) && /\/\.herdr\/worktrees\//.test(r) && r.split("/.herdr/worktrees/")[1]?.split("/")[0] === name;
}

// A session's page, in the default browser.
export const openPage = (url) => openUrl(url);
