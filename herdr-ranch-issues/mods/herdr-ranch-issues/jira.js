// Jira Cloud: projects named in a repository, the sign-in, and the REST calls.
// Read only: nothing is written back to Jira.

import { exec, readTextFile } from "herdr";
import { call, cleanSite, validSite } from "./jira-client.js";

const CAP = 500;
const FIELDS = ["summary", "status", "priority", "issuetype", "assignee", "reporter", "labels", "parent", "updated", "issuelinks"];

// ---- Projects named in a repository ------------------------------------------

// `.herdr/jira.toml` in the main checkout: one or more
//   [[project]]
//   site = "example.atlassian.net"
//   key = "PROJ"
//   filter = "sprint in openSprints()"   # optional JQL, only narrows
function parseToml(text) {
  const projects = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[project]]") { current = {}; projects.push(current); continue; }
    const m = /^([A-Za-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && current) current[m[1]] = m[2].replace(/\\(.)/g, "$1");
  }
  // A repository can name any host here; the client only sends a sign-in to Atlassian hosts or ones the person typed in Link space.
  return projects.filter((p) => p.site && p.key).map((p) => ({ ...p, site: cleanSite(p.site) })).filter((p) => validSite(p.site) && /^[A-Z][A-Z0-9_]+$/.test(p.key));
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return r.code === 0 ? r.stdout.trim() : null;
}

// A committed `.herdr/jira.toml` names the projects for everyone who clones the repository.
export async function fileLinks(repo) {
  const text = await readTextFile(`${repo.main}/.herdr/jira.toml`, { on: repo.on }).catch(() => null);
  return text ? parseToml(text) : [];
}

// The key found most often in recent branch names and commit subjects (PROJ-123).
export async function suggestKey(repo) {
  const text = [
    await git(repo.main, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], repo.on),
    await git(repo.main, ["log", "-300", "--format=%s"], repo.on),
  ].join("\n");
  const counts = new Map();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ---- REST (sign-in and the client: jira-client.js) ----------------------------

export { myself } from "./jira-client.js";
// With its sub-tasks and history (status, assignee and priority changes become timeline events).
export async function issue(site, key) {
  const page = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,issuetype,assignee,reporter,labels,parent,comment,created,updated,subtasks,issuelinks&expand=changelog`);
  const events = [];
  for (const h of page.changelog?.histories ?? []) for (const it of h.items ?? []) {
    const who = h.author?.displayName, at = h.created;
    if (it.field === "status") events.push({ who, at, text: `moved this from ${it.fromString} to ${it.toString}`, color: "accent" });
    else if (it.field === "assignee") events.push({ who, at, text: it.toString ? `assigned ${it.toString}` : "removed the assignee" });
    else if (it.field === "priority") events.push({ who, at, text: `set the priority to ${it.toString}` });
  }
  page.events = events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-20);
  page.sub = (page.fields.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields?.summary ?? "", done: s.fields?.status?.statusCategory?.key === "done" }));
  // Issue links: "blocks", "is blocked by", "relates to", … with the other issue's state.
  page.relations = (page.fields.issuelinks ?? []).map((l) => {
    const other = l.outwardIssue ?? l.inwardIssue, label = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return other ? { label: label ?? "relates to", key: other.key, summary: other.fields?.summary ?? "", done: other.fields?.status?.statusCategory?.key === "done" } : null;
  }).filter(Boolean);
  delete page.changelog; delete page.fields.subtasks; delete page.fields.issuelinks;
  return page;
}

// Only what the list shows: raw issues (links with their whole target issues) make
// every render slow enough for the app to interrupt it.
function slim(i, site) {
  const f = i.fields;
  return {
    key: i.key, site,
    // For the filters: Assigned to me and Created by me.
    assignees: f.assignee ? [f.assignee.accountId] : [], author: f.reporter?.accountId ?? null,
    blocked: (f.issuelinks ?? []).some((l) => l.type?.inward === "is blocked by" && l.inwardIssue
      && l.inwardIssue.fields?.status?.statusCategory?.key !== "done"),
    fields: {
      summary: f.summary, updated: f.updated, labels: f.labels ?? [],
      status: f.status && { name: f.status.name, statusCategory: { key: f.status.statusCategory?.key } },
      priority: f.priority && { name: f.priority.name },
      issuetype: f.issuetype && { name: f.issuetype.name },
      assignee: f.assignee && { displayName: f.assignee.displayName, accountId: f.assignee.accountId },
      parent: f.parent && { key: f.parent.key },
    },
  };
}

// Open issues of one linked project, at most CAP: newest first, or in backlog order (Rank).
export async function search(p, order) {
  const jql = `project = "${p.key}" AND statusCategory != Done${p.filter ? ` AND (${p.filter})` : ""} ORDER BY ${order === "backlog" ? "Rank ASC" : "updated DESC"}`;
  const issues = [];
  let nextPageToken;
  do {
    const page = await call(p.site, "/rest/api/3/search/jql", { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    issues.push(...(page.issues ?? []).map((i) => slim(i, p.site)));
    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken && issues.length < CAP);
  return { issues: issues.slice(0, CAP), capped: Boolean(nextPageToken) };
}

// The keys of the open issues the signed-in account watches. Jira can't search for
// mentions, so its third filter is Watching (`watcher = currentUser()`).
export async function watched(p) {
  const jql = `project = "${p.key}" AND statusCategory != Done AND watcher = currentUser()${p.filter ? ` AND (${p.filter})` : ""}`;
  const keys = [];
  let nextPageToken;
  do {
    const page = await call(p.site, "/rest/api/3/search/jql", { jql, fields: ["summary"], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    keys.push(...(page.issues ?? []).map((i) => i.key));
    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken && keys.length < CAP);
  return keys;
}
