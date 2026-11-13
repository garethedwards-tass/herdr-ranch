// Accounts per space: which Claude Code login (its config folder, CLAUDE_CONFIG_DIR) and which
// GitHub account (GH_TOKEN from `gh auth token --user`) a space's terminals use.
// Stored in shared("ranch-accounts"):
//   { accounts: [{ id, label, claudeDir?: "~/.claude-work", ghUser?: "octocat" }],
//     spaces: { <space id>: { account, main, on } } }
// A space without its own uses its repository's (worktree spaces follow the repository's space).
// Herdr can't give a space environment variables, so a terminal "as" an account is started with a
// small sh script that sets them and then runs your shell or Claude Code. The token is fetched
// inside that script: it never sits on a command line or in Herdr's settings.

import { shared, setShared } from "herdr";

const KEY = "ranch-accounts";
const read = () => shared(KEY) ?? { accounts: [], spaces: {} };

export const accounts = () => read().accounts ?? [];

export function accountOf(space, repo) {
  const all = read(), list = all.accounts ?? [];
  const mine = all.spaces?.[space?.id];
  const pick = mine ?? (repo ? Object.values(all.spaces ?? {}).find((s) => s.main === repo.main && (s.on ?? null) === (repo.on ?? null)) : null);
  return pick?.account ? list.find((a) => a.id === pick.account) ?? null : null;
}

// `account` null: the space goes back to the default (and stops overriding its repository's).
export function setAccount(space, repo, account) {
  const all = read(), spaces = { ...(all.spaces ?? {}) };
  if (account) spaces[space.id] = { account: account.id, main: repo?.main ?? null, on: repo?.on ?? null };
  else delete spaces[space.id];
  setShared(KEY, { ...all, spaces });
}

export function addAccount(a) {
  const all = read();
  const id = `${a.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
  const account = { id, label: a.label, ...(a.claudeDir ? { claudeDir: a.claudeDir } : {}), ...(a.ghUser ? { ghUser: a.ghUser } : {}) };
  setShared(KEY, { ...all, accounts: [...(all.accounts ?? []), account] });
  return account;
}

export function removeAccount(id) {
  const all = read();
  const spaces = Object.fromEntries(Object.entries(all.spaces ?? {}).filter(([, s]) => s.account !== id));
  setShared(KEY, { accounts: (all.accounts ?? []).filter((a) => a.id !== id), spaces });
}

// What a new account may hold: a label, a folder (~ or absolute, no quotes), a GitHub login.
export function checkAccount(a) {
  if (!/^[\w .-]{1,40}$/.test(a.label ?? "")) return "Label: letters, digits, spaces, . _ -";
  if (a.claudeDir && !/^(~|\/)[\w./ -]*$/.test(a.claudeDir)) return "Claude Code folder: a path starting with ~ or /.";
  if (a.ghUser && !/^[A-Za-z0-9-]{1,39}$/.test(a.ghUser)) return "GitHub user: a login name.";
  if (!a.claudeDir && !a.ghUser) return "Give it a Claude Code folder, a GitHub user, or both.";
  return "";
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// A folder for sh: ~ becomes "$HOME".
const dir = (p) => (p.startsWith("~") ? `"$HOME"${q(p.slice(1))}` : q(p));

// The exports for an account, as sh.
export function envScript(a) {
  return [
    a.claudeDir ? `export CLAUDE_CONFIG_DIR=${dir(a.claudeDir)}` : "",
    a.ghUser ? `GH_TOKEN=$(gh auth token --user ${q(a.ghUser)} 2>/dev/null) && export GH_TOKEN || echo ${q(`herdr-ranch: no gh token for ${a.ghUser} (gh auth login)`)} >&2` : "",
  ].filter(Boolean).join("; ");
}

// argv for a terminal as `a`: your login shell, or Claude Code (then a shell when it ends).
export function argvAs(a, program = "shell") {
  const run = program === "claude" ? 'claude; exec "${SHELL:-/bin/sh}" -l' : 'exec "${SHELL:-/bin/sh}" -l';
  return ["sh", "-c", `${envScript(a)}; ${run}`];
}

// The GitHub accounts gh knows (`gh auth status`), for the picker.
export function parseGhAccounts(text) {
  return [...new Set([...(text ?? "").matchAll(/account ([A-Za-z0-9-]+)/g)].map((m) => m[1]))];
}

// A Claude Code config folder as an absolute path (for reading its sessions).
export const expand = (p, home) => (p?.startsWith("~") ? home + p.slice(1) : p);
