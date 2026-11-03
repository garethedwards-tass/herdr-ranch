// Updates for the whole Herdr Ranch suite. The Issues list checks once a day whether a newer
// release of jslowack/herdr-ranch exists and keeps the answer in shared("ranch-update"); every
// cog shows it, with Update for a git install (the mods are linked into a clone: a fast-forward to the release tag,
// the layout copied again, panels reloaded) and the line for your agent for a copied install.
// Source: the repository's shared/, copied into each mod.

import { exec, appHome, shared, setShared, run, notify, window as appWindow } from "herdr";

export const VERSION = "0.2.0";
export const REPO = "jslowack/herdr-ranch";
const KEY = "ranch-update", DAY = 24 * 3600 * 1000;
const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };

// "0.10.2" > "0.9.9": compares numbers, not text. Leading "v" ignored. A pre-release is older
// than its release ("1.0.0-beta.2" < "1.0.0"); two pre-releases compare part by part, numbers
// as numbers and below words ("beta.2" < "beta.10" < "rc.1").
export function newer(a, b) {
  const p = (v) => {
    const [core, ...pre] = String(v ?? "").trim().replace(/^v/, "").split("-");
    return { core: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre.length ? pre.join("-").split(".") : [] };
  };
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
  }
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [s, t] = [x.pre[i], y.pre[i]];
    if (s === t) continue;
    if (s === undefined || t === undefined) return t === undefined;
    const [m, n] = [/^\d+$/.test(s), /^\d+$/.test(t)];
    if (m && n) return Number(s) > Number(t);
    if (m !== n) return n;
    return s > t;
  }
  return false;
}

// A release tag: v1.2.3 or 1.2.3, nothing after it (pre-releases aren't offered).
const RELEASE = /^v?\d+(\.\d+)*$/;

// The latest release tag: GitHub's API through gh (its latest release is never a pre-release),
// else the repository's release tags through git.
async function latest() {
  const gh = await exec("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]).catch(() => null);
  if (gh?.code === 0 && gh.stdout.trim()) return gh.stdout.trim();
  const git = await exec("git", ["ls-remote", "--tags", "--refs", `https://github.com/${REPO}`]).catch(() => null);
  const tags = (git?.stdout ?? "").split("\n").map((l) => /refs\/tags\/(\S+)$/.exec(l.trim())?.[1]).filter((t) => t && RELEASE.test(t));
  return tags.reduce((best, t) => (!best || newer(t, best) ? t : best), null);
}

// Where the suite is installed from: { kind: "git", root } when the mods are links into a
// clone of the repository, else { kind: "copy" }.
export async function installKind(mod = "herdr-ranch-issues") {
  if (platform() === "windows") return { kind: "copy" };
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && pwd -P', "sh", `${appHome()}/mods/${mod}`]).catch(() => null);
  const real = r?.code === 0 ? r.stdout.trim() : "";
  const root = real.replace(/\/[^/]+\/mods\/[^/]+$/, "");
  if (!root || root === real) return { kind: "copy" };
  const g = await exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return g?.code === 0 ? { kind: "git", root } : { kind: "copy" };
}

// Checks at most once a day (or when `force`); one toast per new version.
export async function checkForUpdate(force = false) {
  const now = shared(KEY) ?? {};
  if (!force && now.checkedAt && Date.now() - now.checkedAt < DAY) return now;
  const tag = await latest().catch(() => null);
  const next = { latest: tag ?? now.latest ?? null, checkedAt: Date.now(), toasted: now.toasted ?? null };
  if (tag && newer(tag, VERSION) && next.toasted !== tag) {
    notify({ title: `Herdr Ranch ${tag} is available`, body: "Open the cog in Issues, Pull requests or Reviews to update.", level: "info", timeout: 8000 });
    next.toasted = tag;
  }
  setShared(KEY, next);
  return next;
}

// What the cog shows: { current, latest, available }.
export function updateState() {
  const s = shared(KEY) ?? {};
  return { current: VERSION, latest: s.latest ?? null, available: Boolean(s.latest && newer(s.latest, VERSION)) };
}

// The line for an agent when the mods were copied rather than cloned.
export const AGENT_LINE = `Update the Herdr Ranch mods (herdr-ranch-issues, herdr-ranch-prs, herdr-ranch-reviews and the mod-buttons layout) from github.com/${REPO} to the latest release.`;

// Update a git install: fetch the tags, fast-forward to the latest release tag (the one the cog
// announced, not whatever main is at), copy the layout again when it's installed, reload the
// panels. Returns null, or what went wrong.
export async function updateNow() {
  const where = await installKind();
  if (where.kind !== "git") return "These mods were copied, not cloned: ask your agent to update them.";
  const git = (...args) => exec("git", ["-C", where.root, ...args]).catch(() => null);
  const fetched = await git("fetch", "--tags", "origin");
  if (fetched?.code !== 0) return (fetched?.stderr || fetched?.stdout || "git fetch failed.").trim();
  const tag = (await latest().catch(() => null)) ?? (shared(KEY) ?? {}).latest ?? null;
  if (!tag || !RELEASE.test(tag)) return "No release to update to was found.";
  const known = await git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`);
  if (known?.code !== 0) return `The release tag ${tag} isn't in this clone after fetching from origin.`;
  const ahead = await git("merge-base", "--is-ancestor", "HEAD", `refs/tags/${tag}`);
  if (ahead?.code === 1) {
    const back = await git("merge-base", "--is-ancestor", `refs/tags/${tag}`, "HEAD");
    if (back?.code === 0) return `This clone is already at or past ${tag}.`;
    return `Can't fast-forward to ${tag}: this clone has commits that aren't in the release (another branch, or local commits). Update it by hand in ${where.root}.`;
  }
  const merge = await git("merge", "--ff-only", `refs/tags/${tag}`);
  if (merge?.code !== 0) return `Can't fast-forward to ${tag}: ${(merge?.stderr || merge?.stdout || "git merge failed.").trim()}`;
  const layout = await exec("sh", ["-c", '[ -d "$1/mod-buttons-bar" ] && "$2/install.sh" --layout || "$2/install.sh"', "sh", `${appHome()}/mods`, where.root]).catch(() => null);
  if (layout?.code !== 0) return (layout?.stderr || "install.sh failed.").trim();
  // Panel mods load new code on a layout switch: away and back.
  const current = shared("layout") ?? "mod-buttons";
  run("layout.switch", { name: current === "main" ? "mod-buttons" : "main" });
  await exec("sleep", ["1.5"]).catch(() => null);
  run("layout.switch", { name: current });
  setShared(KEY, { ...(shared(KEY) ?? {}), checkedAt: 0 });
  return null;
}
