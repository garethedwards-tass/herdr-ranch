import claude from "./claude.js";
import codex from "./codex.js";
import antigravity from "./antigravity.js";

// Changed for herdr-ranch: one Claude Code entry per account.
// Every account with a Claude Code folder (the accounts the Spaces list keeps) gets its own
// reading, as `claude:<account id>`; the usual ~/.claude is "claude" unless an account uses it.
// Order here is the order in the status bar and the settings popup.
// accounts: [{ id, label, claudeDir?, codexHome? }]; expand: a folder with ~ as an absolute path; plain: the
// name for the usual folder beside accounts ("Default" unless you named it); plainBadge: what its
// letter is drawn from once named (accounts.js defaultBadge), null for none.
export function providerList(accounts = [], home = "", expand = (p) => p, plain = "Default", plainBadge = null) {
  const usual = `${home}/.claude`;
  const mine = [];
  const seen = new Set();
  for (const a of accounts) {
    if (!a?.claudeDir) continue;
    const dir = expand(a.claudeDir, home).replace(/\/+$/, "");
    if (seen.has(dir)) continue;
    seen.add(dir);
    mine.push({ ...claude, id: `claude:${a.id}`, name: `Claude · ${a.label}`, account: a, configDir: dir === usual ? "" : dir, dir });
  }
  const own = seen.has(usual) ? [] : [{ ...claude, name: mine.length ? `Claude · ${plain}` : "Claude", account: plainBadge, configDir: "", dir: usual }];
  // Codex the same way: the usual ~/.codex, then one per account with its own Codex folder
  // (configDir: the folder handed to helpers/codex-limits.sh as CODEX_HOME).
  const codexUsual = `${home}/.codex`, codexSeen = new Set(), codexes = [];
  for (const a of accounts) {
    if (!a?.codexHome) continue;
    const dir = expand(a.codexHome, home).replace(/\/+$/, "");
    if (codexSeen.has(dir)) continue;
    codexSeen.add(dir);
    codexes.push({ ...codex, id: `codex:${a.id}`, name: `Codex · ${a.label}`, account: a, configDir: dir === codexUsual ? "" : dir });
  }
  const codexOwn = codexSeen.has(codexUsual) ? [] : [{ ...codex, ...(codexes.length ? { name: `Codex · ${plain}`, account: plainBadge } : {}) }];
  return [...own, ...mine, ...codexOwn, ...codexes, antigravity];
}

// Without accounts: what the original mod shows.
export const PROVIDERS = providerList();
