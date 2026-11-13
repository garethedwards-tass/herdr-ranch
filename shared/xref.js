// Links between History, Pull requests and Issues: what a commit, a pull request or an issue
// names (ticket keys, pull request numbers), and one mod asking another to open something.
// The source is shared/xref.js; herdr-ranch-history, herdr-ranch-prs and herdr-ranch-issues keep
// identical copies (a mod cannot import outside its folder). install.sh and CI check they match.
//
// A request is shared state `ranch-open`: { to: <mod>, what, seq, at }. The asking mod writes it
// and shows the other mod (its side panel, else its tab, else a new tab); every copy of that mod
// sees the change on its next render and opens `what` once (`seq`). A request older than FRESH
// is ignored, so a copy that starts later doesn't act on an old click.
//   history: { sha } or { search }, with { cwd, on } (the repository: a folder and its machine)
//   prs:     { number, github }
//   issues:  { key, site?, github?, url? } (a Jira or Linear key, or "#12" for a GitHub issue)

import { shared, setShared, run, layout, panes, spaces, exec } from "herdr";

export const MODS = { history: "herdr-ranch-history", prs: "herdr-ranch-prs", issues: "herdr-ranch-issues" };
const LABEL = { "herdr-ranch-history": "History", "herdr-ranch-prs": "PRs", "herdr-ranch-issues": "Issues" };
const OPEN = "ranch-open", FRESH = 15000;

export function openIn(mod, what) {
  setShared(OPEN, { to: mod, what, seq: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() });
  reveal(mod);
}

// The request for `mod` that this copy hasn't handled yet (`seen`: the last seq it handled), or null.
export function takeOpen(mod, seen) {
  const r = shared(OPEN);
  return r && r.to === mod && r.seq !== seen && Date.now() - (r.at ?? 0) < FRESH ? r : null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// Shows `mod` as the mod-buttons bar would: in the side panel (a child of `panel-body`), or its
// tab in the shown space, whichever its "Opens in" setting picks first; else a new tab of it.
export function reveal(mod) {
  const body = find(layout(), "panel-body");
  const slot = (body?.children ?? []).find((c) => c.content?.mod === mod);
  const space = spaces().find((s) => s.active);
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const pane = panes().find((p) => p.mod === mod && tabs.has(p.tab));
  const toPanel = () => { run("layout.select", { stack: "panel-body", child: slot.id }); run("layout.show", { id: "panel" }); };
  const toTab = () => run("tab.select", { id: pane.tab });
  const asTab = shared("mod-settings")?.[mod]?.opens === "tab";
  if (asTab && pane) toTab();
  else if (slot) toPanel();
  else if (pane) toTab();
  else run("tab.new", { name: LABEL[mod] ?? mod, mod, props: { space: space?.id } });
}

// ---- What a text names ------------------------------------------------------------------

// Words shaped like a key that aren't tickets: UTF-8, SHA-256, ISO-8601, RFC-2119...
const NOT_TICKETS = new Set(["UTF", "UCS", "SHA", "MD", "ISO", "RFC", "CVE", "CWE", "TLS", "SSL", "HTTP", "AES", "RSA", "ECMA", "ES", "IEEE", "ANSI", "ASCII", "PEP", "GPL", "LGPL", "AGPL", "CC", "WIN", "X", "TS", "JS", "IE", "V"]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The ticket keys in a text, in order, each once. With `prefixes` (the linked project keys,
// such as ["TASS"]) only those, in any case ("tass-12" is TASS-12); without, any KEY-123 that
// isn't a known non-ticket word.
export function ticketKeys(text, prefixes = null) {
  const out = new Set(), list = (prefixes ?? []).filter(Boolean);
  const re = list.length
    ? new RegExp(`(?<![A-Za-z0-9_])(${list.map(escape).join("|")})-(\\d+)(?![A-Za-z0-9])`, "gi")
    : /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,19})-(\d+)(?![A-Za-z0-9])/g;
  for (const m of (text ?? "").matchAll(re)) {
    const prefix = m[1].toUpperCase();
    if (!list.length && NOT_TICKETS.has(prefix)) continue;
    out.add(`${prefix}-${m[2]}`);
  }
  return [...out];
}

// The pull request a commit title names: GitHub's merge commit ("Merge pull request #12 from …")
// or a squash merge ("Fix login (#12)").
export function prRefs(title) {
  const out = new Set();
  const merge = /^Merge pull request #(\d+)\b/.exec(title ?? "");
  const squash = /\(#(\d+)\)\s*$/.exec(title ?? "");
  if (merge) out.add(Number(merge[1]));
  if (squash) out.add(Number(squash[1]));
  return [...out];
}

// The GitHub issues a message closes ("fixes #4", "Closes: #12"): only these are surely issues,
// a bare #12 may be a pull request.
export function closingRefs(text) {
  const out = new Set();
  for (const m of (text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)) out.add(Number(m[1]));
  return [...out];
}

// "owner/repo" from a GitHub remote URL (https or ssh), or null.
export function githubFromRemote(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The Link space entry of a repository (its main checkout and machine), or null.
export function linkFor(main, on) {
  return Object.values(shared("space-links") ?? {}).find((l) => l?.main === main && (l.on ?? null) === (on ?? null)) ?? null;
}

// The ticket prefixes a repository's link names (its Jira project, its Linear team), or null.
export function prefixesFor(link) {
  const list = [link?.jira?.key, link?.linear?.key].filter(Boolean);
  return list.length ? list : null;
}

// "owner/repo" from a GitHub pull request or issue URL, or null.
export const repoOfUrl = (url) => /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(url ?? "")?.[1] ?? null;
export const sameRepo = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

// ---- Commits that mention a key -----------------------------------------------------------

const US = "\x1f", RS = "\x1e";
// git's extended regex for a key as a whole word: TASS-12 but not TASS-123 or XTASS-12.
export function mentionPattern(key) {
  const k = escape(key);
  return key.startsWith("#") ? `${k}([^0-9]|$)` : `(^|[^A-Za-z0-9_])${k}([^0-9]|$)`;
}
export const MENTIONS = 20;
export function mentionArgs(key, max = MENTIONS) {
  return ["log", "--all", `--max-count=${max}`, "-i", "-E", `--grep=${mentionPattern(key)}`, "--date=iso-strict", "--no-color", `--format=%H${US}%h${US}%an${US}%ad${US}%s${RS}`];
}
// The newest commits on any branch of the repository ({ main, on }) whose message names `key`.
export async function commitsMentioning(key, repo, max = MENTIONS) {
  if (!repo?.main || !key) return [];
  const r = await exec("git", mentionArgs(key, max), { cwd: repo.main, on: repo.on ?? undefined, timeout: 20000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  return r.stdout.split(RS).map((x) => x.replace(/^\n/, "")).filter((x) => x.trim()).map((x) => {
    const [sha, short, author, at, title] = x.split(US);
    return { sha, short, author, at, title: (title ?? "").trim() };
  });
}
