import claude from "./claude.js";
import codex from "./codex.js";

// Changed for herdr-ranch: one Claude Code entry per account.
// Every account with a Claude Code folder (the accounts the Spaces list keeps) gets its own
// reading, as `claude:<account id>`; the usual ~/.claude is "claude" unless an account uses it.
// Order here is the order in the status bar and the settings popup.
// accounts: [{ id, label, claudeDir? }]; expand: a folder with ~ as an absolute path.
export function providerList(accounts = [], home = "", expand = (p) => p) {
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
  const own = seen.has(usual) ? [] : [{ ...claude, name: mine.length ? "Claude · Default" : "Claude", account: null, configDir: "", dir: usual }];
  return [...own, ...mine, codex];
}

// Without accounts: what the original mod shows.
export const PROVIDERS = providerList();
