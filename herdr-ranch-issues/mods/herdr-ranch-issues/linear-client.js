// Linear for Issues and the Link space dialog: the personal API key and GraphQL calls to
// api.linear.app. Read only. The key lives in the system's credential store (item
// herdr-linear:linear.app, account "linear") or in LINEAR_API_KEY; never in Herdr's settings.
// Source: the repository's shared/, copied into each mod.

import { exec, window as appWindow } from "herdr";
import { readStore, storeSignIn, removeSignIn, readEnv } from "./jira-client.js";

export const KEY_PAGE = "https://linear.app/settings/account/security";
const SITE = "linear.app", API = "https://api.linear.app/graphql";
const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };

let cached = null, at = 0;
// { token, from } or null: the credential store, then LINEAR_API_KEY (the app's environment,
// then a login shell on macOS and Linux). Cached for 10 minutes.
export async function linearKey() {
  if (cached && Date.now() - at < 10 * 60 * 1000) return cached;
  const stored = await readStore(SITE, "linear");
  if (stored?.token) return remember({ token: stored.token, from: { macos: "Keychain", linux: "Secret Service", windows: "Credential Manager" }[platform()] });
  if (platform() === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output $env:LINEAR_API_KEY"]).catch(() => null);
    const t = (r?.stdout ?? "").trim();
    return t ? remember({ token: t, from: "environment" }) : null;
  }
  // The app's environment, then a login shell (the person's $SHELL; see readEnv).
  for (const from of ["app", "login"]) {
    const t = (await readEnv(["LINEAR_API_KEY"], from)).LINEAR_API_KEY;
    if (t) return remember({ token: t, from: "environment" });
  }
  return null;
}
const remember = (c) => { cached = c; at = Date.now(); return c; };
export const forgetKey = () => { cached = null; };

export class LinearError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// One GraphQL request. `as`: a key to try instead of the stored one (Connect).
export async function gql(query, variables = {}, as) {
  const key = as ?? (await linearKey())?.token;
  if (!key) throw new LinearError(401, "No Linear API key.");
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text().catch(() => "");
  if (r.status === 401 || r.status === 400 && /authenticat/i.test(text)) { if (!as) forgetKey(); throw new LinearError(401, "Linear doesn't accept this API key."); }
  if (!r.ok) throw new LinearError(r.status, `Linear ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.errors?.length) {
    const auth = j.errors.some((e) => e.extensions?.type === "authentication error" || /authenticat/i.test(e.message ?? ""));
    if (auth && !as) forgetKey();
    throw new LinearError(auth ? 401 : 400, j.errors.map((e) => e.message).join(" "));
  }
  return j.data;
}

export const viewer = (as) => gql("query { viewer { id name email } }", {}, as).then((d) => d.viewer);

// Teams whose name or key matches `query` (up to 20), as { id, key, name }.
export async function findTeams(query) {
  const d = await gql("query($q: String) { teams(first: 20, filter: { or: [{ name: { containsIgnoreCase: $q } }, { key: { containsIgnoreCase: $q } }] }) { nodes { id key name } } }", { q: query ?? "" });
  return d.teams?.nodes ?? [];
}

// Connect: test the key, then store it like the Jira token (never on a command line).
export async function connectLinear(token) {
  const me = await viewer(token);
  const failed = await storeSignIn(SITE, "linear", token, "linear");
  if (failed) throw new Error(failed);
  forgetKey();
  return me;
}
export const disconnectLinear = async () => { await removeSignIn(SITE, "linear"); forgetKey(); };
