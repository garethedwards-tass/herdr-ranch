// Issues to start a worktree from, through the space's link (links.js): Jira, Linear or GitHub.
// mine(): the open issues assigned to you; lookup(): one issue by its key ("TASS-12", "#12").
// Each is { key, title }.

import { exec } from "herdr";
import { call } from "./jira-client.js";
import { gql } from "./linear-client.js";

// Which tracker a link reads issues from, as the Issues list decides it.
export function source(link, github) {
  if (link?.issues === "linear" && link.linear?.teamId) return { kind: "linear", team: link.linear.teamId };
  if (link?.issues !== "github" && link?.jira?.site && link.jira.key) return { kind: "jira", site: link.jira.site, project: link.jira.key };
  const repo = link?.github || github;
  return repo ? { kind: "github", repo } : null;
}

export const looksLikeKey = (text) => /^([A-Z][A-Z0-9_]+-\d+|#\d+)$/.test((text ?? "").trim());

export async function mine(src) {
  if (src.kind === "jira") {
    const page = await call(src.site, "/rest/api/3/search/jql", { jql: `project = "${src.project}" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, fields: ["summary"], maxResults: 40 });
    return (page.issues ?? []).map((i) => ({ key: i.key, title: i.fields?.summary ?? "" }));
  }
  if (src.kind === "linear") {
    const d = await gql('query($t: ID) { issues(first: 40, orderBy: updatedAt, filter: { team: { id: { eq: $t } }, assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title } } }', { t: src.team });
    return (d.issues?.nodes ?? []).map((i) => ({ key: i.identifier, title: i.title }));
  }
  const r = await exec("gh", ["issue", "list", "-R", src.repo, "--assignee", "@me", "--state", "open", "--json", "number,title", "-L", "40"]);
  if (r.code !== 0) throw new Error((r.stderr || "gh issue list failed").trim());
  return JSON.parse(r.stdout).map((i) => ({ key: `#${i.number}`, title: i.title }));
}

export async function lookup(src, key) {
  key = key.trim();
  if (src.kind === "jira") {
    const i = await call(src.site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`);
    return { key: i.key, title: i.fields?.summary ?? "" };
  }
  if (src.kind === "linear") {
    const d = await gql("query($id: String!) { issue(id: $id) { identifier title } }", { id: key });
    return d.issue ? { key: d.issue.identifier, title: d.issue.title } : null;
  }
  const r = await exec("gh", ["issue", "view", key.replace("#", ""), "-R", src.repo, "--json", "number,title"]);
  if (r.code !== 0) return null;
  const i = JSON.parse(r.stdout);
  return { key: `#${i.number}`, title: i.title };
}
