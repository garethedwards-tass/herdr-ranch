// GitHub issues through the `gh` CLI, so its sign-in, hosts and machines are used as-is.
// Read only: nothing is written back to GitHub. Issues come out in the shape the Jira
// side uses ({ key, site, fields }), so grouping, search and rows work on both.

import { exec } from "herdr";

const CAP = 500;
const LIST = "number,title,labels,assignees,author,updatedAt,url,issueType,parent,blockedBy";
const VIEW = "number,title,body,url,state,labels,assignees,author,milestone,issueType,parent,comments,createdAt,updatedAt,blockedBy,blocking,subIssues";
export const SITE = "github.com";

// where: { cwd, on, github }; `github` ("owner/repo") picks the repository, the folder
// only which machine and sign-in runs gh.
async function gh(args, where) {
  const r = await exec("gh", args, { cwd: where.cwd, on: where.on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh ${args[0]} failed`);
  return r.stdout;
}

// The login gh uses on each machine, read once: the filters compare assignees and the author with it.
const logins = new Map();
export async function me(where) {
  const k = where.on ?? "";
  if (!logins.has(k)) logins.set(k, (await gh(["api", "user", "--jq", ".login"], where)).trim());
  return logins.get(k);
}

// Priority from a label: "P0".."P4", "priority: high", "priority-3", "critical", and the like.
function priority(labels) {
  for (const name of labels) {
    const l = name.toLowerCase().replace(/^priority[\s:/-]*(\d)$/, "p$1").replace(/^priority[\s:/-]*/, "");
    if (/^p[01]$|^(critical|urgent|highest|high|blocker)$/.test(l)) return "High";
    if (/^p2$|^(medium|normal)$/.test(l)) return "Medium";
    if (/^p[34]$|^(low|lowest|minor)$/.test(l)) return "Low";
  }
  return null;
}

// Only what the list shows, as small as the Jira rows.
function slim(i, repo) {
  const labels = (i.labels ?? []).map((l) => l.name);
  const who = i.assignees?.[0];
  return {
    key: `#${i.number}`, number: i.number, site: SITE, repo, url: i.url, provider: "github",
    // For the filters: Assigned to me (any assignee) and Created by me.
    assignees: (i.assignees ?? []).map((a) => a.login), author: i.author?.login ?? null,
    blocked: (i.blockedBy?.nodes ?? []).some((n) => n.state !== "CLOSED") || (!i.blockedBy?.nodes && i.blockedBy?.totalCount > 0),
    fields: {
      summary: (i.title ?? "").trim(), updated: i.updatedAt, labels,
      status: { name: who ? "Assigned" : "Open", statusCategory: { key: who ? "indeterminate" : "new" } },
      priority: priority(labels) && { name: priority(labels) },
      issuetype: { name: i.issueType?.name ?? "Issue" },
      assignee: who && { displayName: who.login, accountId: who.login },
      parent: i.parent?.number ? { key: `#${i.parent.number}` } : null,
    },
  };
}

// Open issues of one repository, newest first, at most CAP. `filter` is GitHub search
// syntax (`label:bug milestone:v2`) and only narrows.
export async function search(p, where) {
  const args = ["issue", "list", "-R", p.repo, "--state", "open", "--limit", String(CAP + 1), "--json", LIST];
  args.push("--search", `${p.filter ? `${p.filter} ` : ""}sort:updated-desc`);
  const raw = JSON.parse(await gh(args, where));
  return { issues: raw.slice(0, CAP).map((i) => slim(i, p.repo)), capped: raw.length > CAP };
}

// The keys of the open issues that mention the signed-in account (`mentions:@me`).
export async function mentioned(p, where) {
  const args = ["issue", "list", "-R", p.repo, "--state", "open", "--limit", String(CAP), "--json", "number", "--search", "mentions:@me"];
  return JSON.parse(await gh(args, where)).map((i) => `#${i.number}`);
}

// One issue's page, in the shape the detail view reads (Markdown instead of ADF).
// Its timeline gives the events (labels, assignees, closing) and the pull requests that mention it.
export async function issue(i, where) {
  const [raw, tl] = await Promise.all([
    gh(["issue", "view", String(i.number), "-R", i.repo, "--json", VIEW], where),
    gh(["api", `repos/${i.repo}/issues/${i.number}/timeline?per_page=100`], where).catch(() => "[]"),
  ]);
  const v = JSON.parse(raw), timeline = JSON.parse(tl || "[]");
  const labels = (v.labels ?? []).map((l) => l.name);
  return {
    fields: {
      summary: (v.title ?? "").trim(), description: v.body ?? "", labels,
      issuetype: { name: v.issueType?.name ?? "Issue" }, status: { name: v.state === "OPEN" ? "Open" : "Closed" },
      priority: priority(labels) && { name: priority(labels) },
      assignee: v.assignees?.[0] && { displayName: v.assignees.map((a) => a.login).join(", ") },
      reporter: v.author && { displayName: v.author.login },
      parent: v.parent?.number ? { key: `#${v.parent.number}` } : null,
      milestone: v.milestone?.title ?? null,
      created: v.createdAt,
      comment: { comments: (v.comments ?? []).map((c) => ({ author: { displayName: c.author?.login ?? "?" }, created: c.createdAt, body: c.body ?? "" })) },
    },
    events: events(timeline),
    prs: linkedPrs(timeline, i.repo),
    // Blocked by / blocks, and sub-issues, as the Jira side has them.
    relations: [
      ...(v.blockedBy?.nodes ?? []).map((n) => ({ label: "blocked by", key: ref(n, i.repo), summary: n.title ?? "", done: n.state === "CLOSED" })),
      ...(v.blocking?.nodes ?? []).map((n) => ({ label: "blocks", key: ref(n, i.repo), summary: n.title ?? "", done: n.state === "CLOSED" })),
    ],
    sub: (v.subIssues?.nodes ?? []).map((n) => ({ key: ref(n, i.repo), summary: n.title ?? "", done: n.state === "CLOSED" })),
  };
}

// "#12", or "owner/repo#12" for an issue in another repository (from its URL).
function ref(n, repo) {
  const other = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//.exec(n.url ?? "")?.[1];
  return other && other.toLowerCase() !== (repo ?? "").toLowerCase() ? `${other}#${n.number}` : `#${n.number}`;
}

const EVENT = {
  labeled: (e) => `added the ${e.label?.name} label`, unlabeled: (e) => `removed the ${e.label?.name} label`,
  assigned: (e) => `assigned ${e.assignee?.login}`, unassigned: (e) => `unassigned ${e.assignee?.login}`,
  closed: () => "closed this", reopened: () => "reopened this", renamed: (e) => `changed the title from "${e.rename?.from}"`,
  milestoned: (e) => `added this to ${e.milestone?.title}`,
  "cross-referenced": (e) => `mentioned this in ${e.source?.issue?.pull_request ? "pull request" : "issue"} #${e.source?.issue?.number}`,
};
function events(timeline) {
  return timeline.filter((e) => EVENT[e.event])
    .map((e) => ({ who: e.actor?.login ?? e.user?.login, at: e.created_at, text: EVENT[e.event](e), color: e.event === "closed" ? "ansi5" : e.event === "cross-referenced" ? "ansi2" : null }))
    .slice(-20);
}
// Pull requests in this repository that mention the issue, newest state.
function linkedPrs(timeline, repo) {
  const out = new Map();
  for (const e of timeline) {
    const s = e.event === "cross-referenced" && e.source?.issue;
    if (!s?.pull_request || (s.repository?.full_name && s.repository.full_name !== repo)) continue;
    out.set(s.number, { number: s.number, title: s.title, url: s.html_url, state: s.pull_request.merged_at ? "MERGED" : s.state === "closed" ? "CLOSED" : s.draft ? "DRAFT" : "OPEN" });
  }
  return [...out.values()];
}

// Pull requests naming a Jira key in their title or description (the Development section).
export async function prsFor(key, repo, where) {
  const args = ["pr", "list", "-R", repo, "--state", "all", "--limit", "5", "--search", `${key} in:title,body`, "--json", "number,title,state,isDraft,url,statusCheckRollup"];
  return JSON.parse(await gh(args, where)).map((p) => {
    const n = { pass: 0, fail: 0, pending: 0 };
    for (const c of p.statusCheckRollup ?? []) {
      const s = c.__typename === "StatusContext" ? (c.state === "SUCCESS" ? "pass" : c.state === "PENDING" ? "pending" : "fail")
        : c.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "pass" : "fail";
      n[s]++;
    }
    return { number: p.number, title: p.title, url: p.url, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, checks: n };
  });
}
