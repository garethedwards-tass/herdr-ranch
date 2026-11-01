// Linear issues for Issues, through Linear's GraphQL API (linear-client.js). Read only.
// Issues come out in the shape the Jira side uses ({ key, site, fields }), so grouping, search,
// rows, pages and Start agent work the same.

import { gql } from "./linear-client.js";

export const SITE = "linear.app";
const CAP = 500;
// Linear's state types to Jira's status categories (what the rows and badges color by).
const CATEGORY = { triage: "new", backlog: "new", unstarted: "new", started: "indeterminate", completed: "done", canceled: "done" };
// Linear's 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none, to the list's High / Medium / Low groups.
const PRIORITY = { 1: "High", 2: "High", 3: "Medium", 4: "Low" };
const kindFrom = (labels) => (labels.some((l) => /bug/i.test(l)) ? "Bug" : labels.some((l) => /feature|enhancement/i.test(l)) ? "Feature" : "Issue");

const FIELDS = "id identifier title url priority state { name type } assignee { id name } creator { id name } labels { nodes { name } } parent { identifier } updatedAt createdAt";

function slim(n) {
  const labels = (n.labels?.nodes ?? []).map((l) => l.name);
  return {
    key: n.identifier, id: n.id, site: SITE, url: n.url, provider: "linear",
    assignees: n.assignee ? [n.assignee.id] : [], author: n.creator?.id ?? null, blocked: false,
    fields: {
      summary: (n.title ?? "").trim(), updated: n.updatedAt, labels,
      status: { name: n.state?.name ?? "", statusCategory: { key: CATEGORY[n.state?.type] ?? "new" } },
      priority: PRIORITY[n.priority] ? { name: PRIORITY[n.priority] } : null,
      issuetype: { name: kindFrom(labels) },
      assignee: n.assignee ? { displayName: n.assignee.name, accountId: n.assignee.id } : null,
      parent: n.parent ? { key: n.parent.identifier } : null,
    },
  };
}

// Open issues of a team (p.teamId), newest first or in Linear's manual order, narrowed by the
// link's preset: "cycle" (the active cycle), "mine" (assigned to me), or all open.
export async function search(p, order) {
  const filter = { team: { id: { eq: p.teamId } }, state: { type: { nin: ["completed", "canceled"] } } };
  if (p.filter === "cycle") filter.cycle = { isActive: { eq: true } };
  if (p.filter === "mine") filter.assignee = { isMe: { eq: true } };
  const issues = [];
  let after = null;
  do {
    const d = await gql(`query($f: IssueFilter, $after: String, $order: PaginationOrderBy) { issues(first: 100, after: $after, filter: $f, orderBy: $order) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { f: filter, after, order: order === "backlog" ? "createdAt" : "updatedAt" });
    issues.push(...(d.issues?.nodes ?? []).map(slim));
    after = d.issues?.pageInfo?.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after && issues.length < CAP);
  return { issues: issues.slice(0, CAP), capped: issues.length >= CAP };
}

export const me = async () => (await gql("query { viewer { id } }")).viewer?.id ?? null;

// Issues the person is subscribed to (Linear has no mention search): the Watching filter.
export async function watched(p) {
  const d = await gql("query($t: ID) { issues(first: 250, filter: { team: { id: { eq: $t } }, subscribers: { some: { isMe: { eq: true } } } }) { nodes { identifier } } }", { t: p.teamId });
  return (d.issues?.nodes ?? []).map((n) => n.identifier);
}

// One issue's page in the Jira shape, plus events (state, assignee and priority changes),
// sub-issues, relations and linked pull requests (GitHub attachments).
export async function issue(i) {
  const d = await gql(`query($id: String!) { issue(id: $id) {
    ${FIELDS} description branchName
    comments(first: 50) { nodes { body createdAt user { name } } }
    history(first: 50) { nodes { createdAt actor { name } fromState { name } toState { name } fromAssignee { name } toAssignee { name } fromPriority toPriority } }
    children(first: 50) { nodes { identifier title state { type } } }
    relations(first: 50) { nodes { type relatedIssue { identifier title state { type } } } }
    inverseRelations(first: 50) { nodes { type issue { identifier title state { type } } } }
    attachments(first: 50) { nodes { url title sourceType metadata } }
  } }`, { id: i.id ?? i.key });
  const n = d.issue;
  if (!n) throw new Error(`Linear has no issue ${i.key}.`);
  const page = slim(n);
  page.fields.description = n.description ?? "";
  page.fields.created = n.createdAt;
  page.fields.reporter = n.creator ? { displayName: n.creator.name } : null;
  page.fields.comment = { comments: (n.comments?.nodes ?? []).map((c) => ({ author: { displayName: c.user?.name ?? "?" }, created: c.createdAt, body: c.body ?? "" })) };
  page.branchName = n.branchName ?? null;
  const events = [];
  for (const h of n.history?.nodes ?? []) {
    const who = h.actor?.name, at = h.createdAt;
    if (h.toState) events.push({ who, at, text: `moved this from ${h.fromState?.name ?? "?"} to ${h.toState.name}`, color: "accent" });
    if (h.toAssignee || h.fromAssignee) events.push({ who, at, text: h.toAssignee ? `assigned ${h.toAssignee.name}` : "removed the assignee" });
    if (h.toPriority != null && h.toPriority !== h.fromPriority) events.push({ who, at, text: `set the priority to ${PRIORITY[h.toPriority] ?? "none"}` });
  }
  page.events = events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-20);
  page.sub = (n.children?.nodes ?? []).map((c) => ({ key: c.identifier, summary: c.title ?? "", done: CATEGORY[c.state?.type] === "done" }));
  const done = (x) => CATEGORY[x?.state?.type] === "done";
  page.relations = [
    ...(n.relations?.nodes ?? []).map((r) => ({ label: r.type === "blocks" ? "blocks" : r.type === "duplicate" ? "duplicates" : "relates to", key: r.relatedIssue?.identifier, summary: r.relatedIssue?.title ?? "", done: done(r.relatedIssue) })),
    ...(n.inverseRelations?.nodes ?? []).filter((r) => r.type === "blocks").map((r) => ({ label: "blocked by", key: r.issue?.identifier, summary: r.issue?.title ?? "", done: done(r.issue) })),
  ].filter((r) => r.key);
  page.prs = (n.attachments?.nodes ?? []).filter((a) => a.sourceType === "github" || /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(a.url ?? "")).map((a) => {
    const num = Number(/\/pull\/(\d+)/.exec(a.url ?? "")?.[1] ?? 0);
    const st = a.metadata?.status ?? a.metadata?.state ?? "";
    return { number: num, title: a.title ?? a.url, url: a.url, state: /merged/i.test(st) ? "MERGED" : /closed/i.test(st) ? "CLOSED" : /draft/i.test(st) ? "DRAFT" : "OPEN" };
  }).filter((x) => x.number);
  return page;
}
