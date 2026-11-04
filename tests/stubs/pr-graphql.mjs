// The PR list comes from one GraphQL query per state (open, closed). Tests describe pull
// requests in the `gh pr list --json` shape they always used, with a `statusCheckRollup` of
// check runs; this turns them into what GitHub answers to that query: check counts per state.

function counts(rollup) {
  const runs = new Map(), contexts = new Map();
  for (const c of rollup ?? []) {
    if (c.__typename === "StatusContext") contexts.set(c.state, (contexts.get(c.state) ?? 0) + 1);
    else { const s = c.status === "COMPLETED" ? c.conclusion : c.status; runs.set(s, (runs.get(s) ?? 0) + 1); }
  }
  const list = (m) => [...m].map(([state, count]) => ({ state, count }));
  return { checkRunCountsByState: list(runs), statusContextCountsByState: list(contexts) };
}

export function node(pr) {
  const { statusCheckRollup, assignees, reviewRequests, ...rest } = pr;
  return {
    ...rest,
    assignees: { nodes: (assignees ?? []).map((a) => ({ login: a.login })) },
    reviewRequests: { nodes: (reviewRequests ?? []).map((r) => ({ requestedReviewer: r.login ? { login: r.login } : { name: r.name } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: statusCheckRollup?.length ? { contexts: counts(statusCheckRollup) } : null } }] },
  };
}

// The state a list query asks for: "open" or "closed".
export const which = (args) => (args.find((a) => a.startsWith("query=")) ?? "").includes("states: OPEN") ? "open" : "closed";

export const answer = (prs) => JSON.stringify({ data: { repository: { pullRequests: { nodes: prs.map(node) } } } });

// An exec stub for `list`: answers each state's query with its pull requests.
export const listExec = (open, closed = []) => (cmd, args) => ({ code: 0, stdout: answer(which(args) === "open" ? open : closed), stderr: "" });
