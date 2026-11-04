// GitHub data through the `gh` CLI, so its sign-in, hosts and machines are used as-is.

import { exec } from "herdr";

// The list's own query, not `gh pr list --json statusCheckRollup`: that returns every check
// run with its workflow, times and link (hundreds per refresh), which costs GitHub seconds,
// while the list only shows how many pass, fail and run. Counts per state answer that.
const FIELDS = `number title author { login } assignees(first: 20) { nodes { login } } headRefName baseRefName
  isDraft reviewDecision reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  additions deletions updatedAt url state isCrossRepository
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
    checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;
const LIST = (states, first) => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  pullRequests(states: ${states}, first: ${first}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${FIELDS} } } } }`;
const VIEW = "number,title,body,url,author,headRefName,baseRefName,isDraft,state,mergedAt,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,additions,deletions,changedFiles,createdAt,reviewRequests,latestReviews,assignees,labels,files,closingIssuesReferences,isCrossRepository";

// where: { cwd, on, github }; `github` ("owner/repo") picks the repository, so the
// folder only matters for which machine and sign-in runs gh.
// GitHub answers a heavy query with a 502, 503 or 504 now and then, well inside the rate
// limit; one immediate retry gets most of them, so only a second failure reaches the list.
export const TRANSIENT = /HTTP 50[234]|Gateway Time-?out|Bad Gateway|Service Unavailable/i;
async function gh(args, where) {
  let r = await exec("gh", args, { cwd: where.cwd, on: where.on });
  if (r.code !== 0 && TRANSIENT.test(r.stderr || r.stdout)) r = await exec("gh", args, { cwd: where.cwd, on: where.on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh ${args[0]} failed`);
  return r.stdout;
}

// The numbers of the open pull requests that mention the signed-in account (`mentions:@me`).
export async function mentioned(where) {
  const args = ["pr", "list", "-R", where.github, "--state", "open", "--limit", "100", "--json", "number", "--search", "mentions:@me"];
  return JSON.parse(await gh(args, where)).map((pr) => pr.number);
}

// The login gh uses on each machine, read once.
const logins = new Map();
export async function me(where) {
  const k = where.on ?? "";
  if (!logins.has(k)) logins.set(k, (await gh(["api", "user", "--jq", ".login"], where)).trim());
  return logins.get(k);
}

// Only what the list shows. The raw rollups are large (every check run with all its
// fields), and keeping them makes every render slow enough for the app to interrupt it.
function slim(pr, login) {
  const s = {
    number: pr.number, title: (pr.title ?? "").trim(), author: { login: pr.author?.login ?? null }, assignees: (pr.assignees ?? []).map((a) => a.login), headRefName: pr.headRefName, baseRefName: pr.baseRefName ?? "",
    isDraft: pr.isDraft, reviewDecision: pr.reviewDecision, reviewRequests: (pr.reviewRequests ?? []).map((r) => ({ login: r.login })),
    checks: pr.checks, additions: pr.additions, deletions: pr.deletions, updatedAt: pr.updatedAt, url: pr.url, state: pr.state,
    fork: Boolean(pr.isCrossRepository),
  };
  s.group = group(s, login);
  return s;
}

// A GraphQL pull request in the shape the rest of the list reads (that of `gh pr list --json`),
// with its checks already counted.
function fromNode(n) {
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return {
    ...n, author: n.author ?? null, assignees: n.assignees?.nodes ?? [], reviewDecision: n.reviewDecision ?? "",
    reviewRequests: (n.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer ?? {}),
    checks: countChecks(rollup),
  };
}

async function query(where, states, first) {
  const [owner, name] = where.github.split("/");
  const out = JSON.parse(await gh(["api", "graphql", "-f", `query=${LIST(states, first)}`, "-f", `owner=${owner}`, "-f", `name=${name}`], where));
  return (out.data?.repository?.pullRequests?.nodes ?? []).filter(Boolean).map(fromNode);
}

export async function list(where, login) {
  const [open, closed] = await Promise.all([query(where, "OPEN", 100), query(where, "[CLOSED, MERGED]", 10)]);
  // A pull request that closes between the two calls is in both: keep it once.
  const seen = new Set();
  return [...open, ...closed].filter((pr) => !seen.has(pr.number) && seen.add(pr.number)).map((pr) => slim(pr, login));
}

// The page, with its timeline (review requests, labels, pushes, merging) from the issues API,
// and only what the page draws: files are capped, people are logins.
export async function view(number, where) {
  const [raw, tl] = await Promise.all([
    gh(["pr", "view", "-R", where.github, String(number), "--json", VIEW], where),
    gh(["api", `repos/${where.github}/issues/${number}/timeline?per_page=100`], where).catch(() => "[]"),
  ]);
  const pr = JSON.parse(raw), timeline = JSON.parse(tl || "[]");
  pr.title = (pr.title ?? "").trim();
  pr.statusCheckRollup = (pr.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? "check", state: checkState(c), label: (c.conclusion ?? c.state ?? c.status ?? "").toLowerCase() }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  pr.files = (pr.files ?? []).slice(0, 300).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  pr.commitCount = timeline.filter((e) => e.event === "committed").length || null;
  const merged = timeline.some((e) => e.event === "merged");
  pr.events = timeline.filter((e) => EVENT[e.event] && !(merged && e.event === "closed")).map((e) => ({
    who: e.actor?.login ?? e.user?.login, at: e.created_at, text: EVENT[e.event](e),
    color: e.event === "merged" ? "ansi5" : e.event === "closed" ? "ansi1" : e.event === "ready_for_review" ? "ansi2" : null,
  })).slice(-20);
  // Reviewers: who was asked (still pending) and the latest verdict of everyone who reviewed.
  const people = new Map((pr.reviewRequests ?? []).filter((r) => r.login).map((r) => [r.login, "REQUESTED"]));
  for (const r of pr.latestReviews ?? []) if (r.author?.login) people.set(r.author.login, r.state);
  pr.reviewers = [...people].map(([login, state]) => ({ login, state }));
  pr.assignees = (pr.assignees ?? []).map((a) => a.login);
  pr.labels = (pr.labels ?? []).map((l) => l.name);
  pr.issues = (pr.closingIssuesReferences ?? []).map((i) => ({ number: i.number, url: i.url, repo: i.repository ? `${i.repository.owner?.login}/${i.repository.name}` : null }));
  delete pr.reviewRequests; delete pr.latestReviews; delete pr.closingIssuesReferences;
  return pr;
}

const ORDER = { fail: 0, pending: 1, pass: 2 };
const EVENT = {
  review_requested: (e) => `requested a review from ${e.requested_reviewer?.login ?? e.requested_team?.name ?? "someone"}`,
  labeled: (e) => `added the ${e.label?.name} label`, unlabeled: (e) => `removed the ${e.label?.name} label`,
  ready_for_review: () => "marked this ready for review", convert_to_draft: () => "turned this into a draft",
  head_ref_force_pushed: () => "force-pushed the branch", merged: () => "merged this", closed: () => "closed this", reopened: () => "reopened this",
  renamed: (e) => `changed the title from "${e.rename?.from}"`,
};

function checkState(c) {
  if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "pass" : c.state === "FAILURE" || c.state === "ERROR" ? "fail" : "pending";
  if (c.status !== "COMPLETED") return "pending";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "pass" : "fail";
}

// Check runs by conclusion when done, else by status; status contexts by state.
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "ERROR"]);
function countChecks(c) {
  const n = { pass: 0, fail: 0, pending: 0 };
  for (const { state, count } of [...(c?.checkRunCountsByState ?? []), ...(c?.statusContextCountsByState ?? [])]) {
    if (!count) continue;
    n[PASS.has(state) ? "pass" : FAIL.has(state) ? "fail" : "pending"] += count;
  }
  return n;
}

// What each pull request waits on, in the order the list shows them.
export const GROUPS = [
  ["review", "Review requested"],
  ["fix", "Yours to fix"],
  ["ready", "Ready to merge"],
  ["open", "Open"],
  ["closed", "Recently closed"],
];

function group(pr, login) {
  if (pr.state !== "OPEN") return "closed";
  const mine = pr.author?.login === login, c = pr.checks;
  if (!mine && (pr.reviewRequests ?? []).some((r) => r.login === login)) return "review";
  if (mine && (pr.reviewDecision === "CHANGES_REQUESTED" || c.fail > 0)) return "fix";
  if (!pr.isDraft && pr.reviewDecision === "APPROVED" && c.fail === 0 && c.pending === 0) return "ready";
  return "open";
}

// The text search looks in, built once per load: { raw, lower }.
export function haystack(pr) {
  const raw = `#${pr.number} ${pr.title} ${pr.author?.login ?? ""} ${pr.headRefName}`;
  return { raw, lower: raw.toLowerCase() };
}

// Every typed word must match somewhere; a word with a capital matches case-sensitively.
export const words = (query) => query.split(/\s+/).filter(Boolean);
export const matches = (hay, ws) => ws.every((w) => (/[A-Z]/.test(w) ? hay.raw : hay.lower).includes(w));

export function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
}

// A short stable hash of an item, so its agent branch is found again later.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

export const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

// Whether the gh stack extension is installed. Fix stack to merge needs it. Only a yes is kept
// (per machine): after "Needs gh stack" someone installs it, and the next refresh must see that.
const stackExt = new Set();
export async function hasGhStack(where) {
  const k = where.on ?? "";
  if (stackExt.has(k)) return true;
  const has = await gh(["extension", "list"], where).then((out) => out.includes("gh-stack"), () => false);
  if (has) stackExt.add(k);
  return has;
}
