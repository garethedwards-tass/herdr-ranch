// Accounts per space (shared: the spaces list starts terminals as one; every Link space dialog sets it):
// one sign-in per provider that a space's terminals use. Claude Code: its config folder
// (CLAUDE_CONFIG_DIR). GitHub: a gh login (GH_TOKEN from `gh auth token --user`). Codex: its home
// (CODEX_HOME). Antigravity has one sign-in per computer, so it's always the usual one.
// Stored in shared("ranch-accounts"):
//   { accounts: [{ id, label, claudeDir?: "~/.claude-work", ghUser?: "octocat", codexHome?: "~/.codex-work" }],
//     defaultLabel?: "Me",  (the name for no account: your usual login; "Default" when unset)
//     defaultGhUser?: "octocat",  (the GitHub account no account's terminals use; gh's active one when unset)
//     spaces: { <space id>: { account, main, on } } }  (account null: Default chosen for that space)
// A space without its own uses its repository's (worktree spaces follow the repository's space);
// one that chose Default keeps it, and only for itself: others don't inherit a Default.
// Herdr can't give a space environment variables, so a terminal "as" an account is started with a
// small sh script that sets them and then runs your shell or Claude Code. The token is fetched
// inside that script: it never sits on a command line or in Herdr's settings.

import { shared, setShared, exec } from "herdr";

const KEY = "ranch-accounts";
const read = () => shared(KEY) ?? { accounts: [], spaces: {} };

export const accounts = () => read().accounts ?? [];

// An account's color (a theme key's value), by its place in the list, and its letter.
const COLORS = ["ansi5", "ansi4", "ansi6", "ansi3", "ansi2", "ansi1"];
export function accountColor(a, t) {
  if (a?.isDefault) return t.muted;
  const i = Math.max(0, accounts().findIndex((x) => x.id === a?.id));
  return t[COLORS[i % COLORS.length]] ?? t.accent;
}
export const accountLetter = (a) => a?.label?.trim().charAt(0).toUpperCase() || "?";

// No account (your usual ~/.claude login and gh account): "Default" unless you named it.
export const defaultLabel = () => String(read().defaultLabel ?? "").trim() || "Default";
export const defaultLetter = () => defaultLabel().charAt(0).toUpperCase();
// No account drawn like an account once you've named it (its letter on a neutral square), for
// accountColor and accountLetter; null while it's still "Default". For showing only, never launchAs.
export const defaultBadge = () => (defaultLabel() === "Default" ? null : { id: null, label: defaultLabel(), isDefault: true });
// "" (or "Default") goes back to "Default".
export function setDefaultLabel(label) {
  const all = read(), l = String(label ?? "").trim();
  const { defaultLabel: _, ...rest } = all;
  setShared(KEY, l && l !== "Default" ? { ...rest, defaultLabel: l } : rest);
}

// No account's GitHub login: "" uses whichever account gh has active.
export const defaultGhUser = () => String(read().defaultGhUser ?? "").trim();
export function setDefaultGhUser(user) {
  const all = read(), u = String(user ?? "").trim();
  const { defaultGhUser: _, ...rest } = all;
  setShared(KEY, u ? { ...rest, defaultGhUser: u } : rest);
}

// What a terminal is started as: the account, or for no account its GitHub login when it has one
// (no id: it isn't an account the Agents list can name). null: start it plainly.
export function launchAs(a) {
  if (a) return a;
  const ghUser = defaultGhUser();
  return ghUser ? { ghUser } : null;
}

export function accountOf(space, repo, all = read()) {
  const list = all.accounts ?? [];
  const mine = all.spaces?.[space?.id];
  const pick = mine ?? (repo ? Object.values(all.spaces ?? {}).find((s) => s.account && s.main === repo.main && (s.on ?? null) === (repo.on ?? null)) : null);
  return pick?.account ? list.find((a) => a.id === pick.account) ?? null : null;
}

// `account` null: the space uses the default. Kept as its own choice when its repository has an
// account it would otherwise inherit (a worktree of a Personal repository picking Default), else
// its entry goes.
export function setAccount(space, repo, account) {
  const all = read(), spaces = { ...(all.spaces ?? {}) };
  delete spaces[space.id];
  const entry = (id) => ({ account: id, main: repo?.main ?? null, on: repo?.on ?? null });
  if (account) spaces[space.id] = entry(account.id);
  else if (accountOf(space, repo, { ...all, spaces })) spaces[space.id] = entry(null);
  setShared(KEY, { ...all, spaces });
}

// What an account keeps: its label and each provider's sign-in it has (empty ones left out).
const fields = (a) => ({
  label: a.label,
  ...(a.claudeDir ? { claudeDir: a.claudeDir } : {}),
  ...(a.ghUser ? { ghUser: a.ghUser } : {}),
  ...(a.codexHome ? { codexHome: a.codexHome } : {}),
});

export function addAccount(a) {
  const all = read();
  const id = `${a.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
  const account = { id, ...fields(a) };
  setShared(KEY, { ...all, accounts: [...(all.accounts ?? []), account] });
  return account;
}

// Changes an account's label, Claude Code folder and GitHub login; its id (and so its spaces) stays.
// Empty folder or login: it has none.
export function updateAccount(id, a) {
  const all = read();
  const list = (all.accounts ?? []).map((x) => (x.id !== id ? x : { id, ...fields(a) }));
  setShared(KEY, { ...all, accounts: list });
  return list.find((x) => x.id === id) ?? null;
}

export function removeAccount(id) {
  const all = read();
  const spaces = Object.fromEntries(Object.entries(all.spaces ?? {}).filter(([, s]) => s.account !== id));
  setShared(KEY, { ...all, accounts: (all.accounts ?? []).filter((a) => a.id !== id), spaces });
}

// What an account may hold: a label, folders (~ or absolute, no quotes), a GitHub login.
const FOLDER = /^(~|\/)[\w./ -]*$/;
export function checkAccount(a) {
  if (!/^[\w .-]{1,40}$/.test(a.label ?? "")) return "Label: letters, digits, spaces, . _ -";
  if (a.claudeDir && !FOLDER.test(a.claudeDir)) return "Claude Code folder: a path starting with ~ or /.";
  if (a.codexHome && !FOLDER.test(a.codexHome)) return "Codex folder: a path starting with ~ or /.";
  if (a.ghUser && !/^[A-Za-z0-9-]{1,39}$/.test(a.ghUser)) return "GitHub user: a login name.";
  if (!a.claudeDir && !a.ghUser && !a.codexHome) return "Give it at least one: a Claude Code folder, a GitHub user or a Codex folder.";
  return "";
}

// An account's sign-ins, one line per provider it sets ([provider, value]); the rest use the usual one.
export const accountParts = (a) => [
  a?.claudeDir && ["Claude Code", a.claudeDir],
  a?.ghUser && ["GitHub", a.ghUser],
  a?.codexHome && ["Codex", a.codexHome],
].filter(Boolean);

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// A folder for sh: ~ becomes "$HOME".
const dir = (p) => (p.startsWith("~") ? `"$HOME"${q(p.slice(1))}` : q(p));

// The exports for an account, as sh.
// HERDR_RANCH_ACCOUNT names the account (no secret): the Agents list reads it from a running
// Claude Code to start it again as the same account (revive.js).
export function envScript(a) {
  return [
    a.id && /^[\w-]+$/.test(a.id) ? `export HERDR_RANCH_ACCOUNT=${a.id}` : "",
    a.claudeDir ? `export CLAUDE_CONFIG_DIR=${dir(a.claudeDir)}` : "",
    a.codexHome ? `export CODEX_HOME=${dir(a.codexHome)}` : "",
    a.ghUser ? `GH_TOKEN=$(gh auth token --user ${q(a.ghUser)} 2>/dev/null) && export GH_TOKEN || echo ${q(`herdr-ranch: no gh token for ${a.ghUser} (gh auth login)`)} >&2` : "",
  ].filter(Boolean).join("; ");
}

// gh as a GitHub login, its token fetched for this one command; "" runs gh as its active account.
export function ghAs(user, args, opts = {}) {
  if (!user) return exec("gh", args, opts);
  return exec("sh", ["-c", `GH_TOKEN=$(gh auth token --user ${q(user)}) && export GH_TOKEN && exec gh "$@"`, "sh", ...args], opts);
}

// The GitHub login an account's terminals use: its own, or for no account (null) defaultGhUser;
// "" when gh's active account (an account with only a Claude Code folder sets none).
export const ghUserOf = (a) => (a ? a.ghUser ?? "" : defaultGhUser());

// argv for a terminal as `a`: your login shell, or Claude Code (then a shell when it ends).
export function argvAs(a, program = "shell") {
  const run = program === "claude" ? 'claude; exec "${SHELL:-/bin/sh}" -l' : 'exec "${SHELL:-/bin/sh}" -l';
  return ["sh", "-c", `${envScript(a)}; ${run}`];
}

// argv running `run` (e.g. an agent's command from Herdr's program table) as `a`.
export function runAs(a, run) {
  return ["sh", "-c", `${envScript(a)}; exec "$@"`, "sh", ...run];
}

// The GitHub accounts gh knows (`gh auth status`), for the picker.
export function parseGhAccounts(text) {
  return [...new Set([...(text ?? "").matchAll(/account ([A-Za-z0-9-]+)/g)].map((m) => m[1]))];
}

// A Claude Code config folder as an absolute path (for reading its sessions).
export const expand = (p, home) => (p?.startsWith("~") ? home + p.slice(1) : p);
