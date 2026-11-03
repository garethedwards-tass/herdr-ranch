// Jira Cloud sign-in and REST, for the Link space dialog and the issues list.
// The source is shared/jira-client.js; herdr-ranch-prs and herdr-ranch-issues keep identical copies
// (a mod cannot import outside its folder). install.sh checks they match.
// Read only towards Jira. The sign-in lives in the system's credential store (the macOS
// Keychain, the Secret Service on Linux, the Windows Credential Manager) or in environment
// variables; never in Herdr's shared state or settings.

import { exec, appHome, writeTextFile, window as appWindow, shared, setShared } from "herdr";

export const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
// One item per service and site: herdr-jira:<site>, herdr-linear:linear.app.
const service = (site, kind = "jira") => `herdr-${kind}:${site}`;
const KIND = { jira: "Jira", linear: "Linear" };
export const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };
// What the store is called where the person is: shown in the dialog and the docs.
export const STORE = { macos: "the macOS Keychain", linux: "the Secret Service (GNOME Keyring, KWallet)", windows: "the Windows Credential Manager" };
const STORE_SHORT = { macos: "Keychain", linux: "Secret Service", windows: "Credential Manager" };

// Values that go into a command are checked first: a site is a host name, an email has no
// quotes, a classic token is base64-like. Anything else is refused, not escaped.
const SITE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, TOKEN = /^[A-Za-z0-9_=+/.-]{20,512}$/;

// Where a sign-in may be sent. Atlassian Cloud hosts always; any other host only after the
// person typed it in Link space (kept in Herdr's shared state, never in a repository), so a
// committed .herdr/jira.toml can't send a token to a host of its choosing.
const ATLASSIAN = /\.(atlassian\.net|jira\.com)$/;
const TRUSTED = "jira-sites", LINKS = "space-links";
export const validSite = (site) => SITE.test(site ?? "");
// Sites the person typed (shared("jira-sites"), Atlassian ones included) or linked a space to
// (shared("space-links")). A site named only by a repository's file is not one of them.
export const personSite = (site) => validSite(site)
  && ((shared(TRUSTED) ?? []).includes(site) || Object.values(shared(LINKS) ?? {}).some((l) => l?.jira?.site === site));
export const trustedSite = (site) => validSite(site) && (ATLASSIAN.test(site) || personSite(site));
export function trustSite(site) {
  if (validSite(site) && !(shared(TRUSTED) ?? []).includes(site)) setShared(TRUSTED, [...(shared(TRUSTED) ?? []), site]);
}
const ps = (script) => exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
const VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault";

export async function readStore(site, kind = "jira") {
  if (!SITE.test(site)) return null;
  const os = platform();
  if (os === "macos") {
    const item = await exec("security", ["find-generic-password", "-s", service(site, kind), "-g"]).catch(() => null);
    const out = `${item?.stdout ?? ""}\n${item?.stderr ?? ""}`;
    const email = /"acct"<blob>="([^"]*)"/.exec(out)?.[1], token = /^password: "(.*)"$/m.exec(out)?.[1];
    return email && token ? { email, token } : null;
  }
  if (os === "linux") {
    const r = await exec("secret-tool", ["search", "service", `herdr-${kind}`, "site", site]).catch(() => null);
    const out = `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
    const email = /^attribute\.account = (.*)$/m.exec(out)?.[1]?.trim(), token = /^secret = (.*)$/m.exec(out)?.[1]?.trim();
    return email && token ? { email, token } : null;
  }
  const r = await ps(`${VAULT}; try { $c = $v.FindAllByResource('${service(site, kind)}')[0]; $c.RetrievePassword(); Write-Output $c.UserName; Write-Output $c.Password } catch {}`).catch(() => null);
  const [email, token] = (r?.stdout ?? "").split(/\r?\n/).map((x) => x.trim());
  return email && token ? { email, token } : null;
}

// Environment variables by name, from one place: "app" is the app's own environment, "login" a
// login shell (the person's $SHELL, else zsh on macOS and sh on Linux). One `printenv` per
// variable, so it reads the same in bash, zsh and fish. Unset ones are left out.
const VAR = /^[A-Z_][A-Z0-9_]*$/;
export async function readEnv(names, from) {
  const fallback = platform() === "macos" ? "/bin/zsh" : "/bin/sh";
  const values = await Promise.all(names.map(async (name) => {
    if (!VAR.test(name)) return "";
    const r = await (from === "app"
      ? exec("printenv", [name])
      : exec("sh", ["-c", `exec "\${SHELL:-${fallback}}" -lc "$1"`, "sh", `printenv ${name}`])).catch(() => null);
    return r?.code === 0 ? (r.stdout ?? "").trim() : "";
  }));
  return Object.fromEntries(names.map((n, i) => [n, values[i]]).filter(([, v]) => v));
}

// Tried in order, per site (example.atlassian.net reads JIRA_EXAMPLE_*):
//   the credential store item `herdr-jira:<site>` (account = email, secret = token),
//   then JIRA_<SITE>_EMAIL / JIRA_<SITE>_API_TOKEN,
//   JIRA_EMAIL / JIRA_API_TOKEN, ATLASSIAN_USERNAME / ATLASSIAN_API_KEY.
// Variables come from the app's environment, then a login shell (macOS and Linux).
// Cached per site for 10 minutes: each list and dialog is a copy of its own, so a sign-in
// removed in one is noticed by the others within that time (or on Jira's next 401).
const signIns = new Map(), FRESH = 10 * 60 * 1000;
export async function credentials(site) {
  const hit = signIns.get(site);
  if (hit && Date.now() - hit.at < FRESH) return hit.c;
  const stored = await readStore(site);
  if (stored) return remember(site, { ...stored, from: STORE_SHORT[platform()] });
  if (!trustedSite(site)) return null;
  const prefix = site.split(".")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_");
  // The generic variables aren't tied to a site: only an Atlassian host the person typed or
  // linked gets them, not one a repository's .herdr/jira.toml names.
  const generic = ATLASSIAN.test(site) && personSite(site);
  const os = platform();
  if (os === "windows") {
    const r = await ps(generic
      ? `$e = @($env:JIRA_${prefix}_EMAIL, $env:JIRA_EMAIL, $env:ATLASSIAN_USERNAME) | Where-Object { $_ } | Select-Object -First 1; $t = @($env:JIRA_${prefix}_API_TOKEN, $env:JIRA_API_TOKEN, $env:ATLASSIAN_API_KEY) | Where-Object { $_ } | Select-Object -First 1; Write-Output $e; Write-Output $t`
      : `Write-Output $env:JIRA_${prefix}_EMAIL; Write-Output $env:JIRA_${prefix}_API_TOKEN`).catch(() => null);
    const [e, t] = (r?.stdout ?? "").split(/\r?\n/).map((x) => x.trim());
    return e && t ? remember(site, { email: e, token: t, from: "environment" }) : null;
  }
  const emails = [`JIRA_${prefix}_EMAIL`, ...(generic ? ["JIRA_EMAIL", "ATLASSIAN_USERNAME"] : [])];
  const tokens = [`JIRA_${prefix}_API_TOKEN`, ...(generic ? ["JIRA_API_TOKEN", "ATLASSIAN_API_KEY"] : [])];
  for (const from of ["app", "login"]) {
    const v = await readEnv([...emails, ...tokens], from);
    const e = emails.map((n) => v[n]).find(Boolean), t = tokens.map((n) => v[n]).find(Boolean);
    if (e && t) return remember(site, { email: e, token: t, from: "environment" });
  }
  return null;
}
const remember = (site, c) => { signIns.set(site, { c, at: Date.now() }); return c; };
// Read the sign-in again next time (after a 401, or a new token).
export const forget = (site) => signIns.delete(site);

// Stores a sign-in that was tested (see `myself`). The token never goes on a command line:
// it is written to a file in a folder only this user can open, the store's own command reads
// it from there, and the same command deletes the file. Returns null, or what went wrong.
// `kind` "linear": the account is "linear" and the token a personal API key (lin_api_…).
export async function storeSignIn(site, email, token, kind = "jira") {
  if (!SITE.test(site)) return "That isn't a site name.";
  if (kind === "linear") {
    if (!/^[a-z]+$/.test(email)) return "That isn't an account name.";
    if (!/^lin_api_[A-Za-z0-9]{20,100}$/.test(token)) return "That doesn't look like a Linear personal API key (lin_api_…).";
  } else {
    if (!EMAIL.test(email)) return "That doesn't look like an email address.";
    if (!TOKEN.test(token)) return "That doesn't look like a classic API token.";
  }
  const os = platform();
  const dir = `${appHome()}/data/herdr-ranch/private`, file = `${dir}/t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const scrub = (text) => String(text ?? "").split(token).join("***").trim();
  // The folder must exist and be private before the token goes near it.
  const made = os !== "windows"
    ? await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1" && [ "$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")" = 700 ] && rm -f "$1"/t-*', "sh", dir]).catch(() => null)
    : await ps(`New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null; Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Filter 't-*' | Remove-Item -Force`).catch(() => null);
  if (made?.code !== 0) return "Can't make a private folder for the token; use environment variables instead.";
  let r;
  try {
    // An item stored under another email would stay next to the new one (the store replaces
    // only the same account) and could be the one read back: every old one goes first.
    await clearStore(site, kind);
    if (os === "macos") {
      await writeTextFile(file, `add-generic-password -U -s "${service(site, kind)}" -a "${email}" -l "Herdr ${KIND[kind]} ${site}" -w "${token}"\n`, null);
      // Opened, then deleted, then read: the file is gone before security runs.
      r = await exec("sh", ["-c", 'exec 3<"$1" && rm -f "$1" && security -i <&3', "sh", file]);
    } else if (os === "linux") {
      await writeTextFile(file, token, null);
      r = await exec("sh", ["-c", 'exec 3<"$1" && rm -f "$1" && secret-tool store --label="Herdr $4 $2" service "herdr-$5" site "$2" account "$3" <&3', "sh", file, site, email, KIND[kind], kind]);
      if (r.code === 127) return "secret-tool isn't installed (package libsecret-tools or libsecret): install it, or use environment variables.";
    } else {
      await writeTextFile(file, token, null);
      const f = file.replace(/'/g, "''");
      r = await ps(`${VAULT}; try { $t = (Get-Content -Raw -LiteralPath '${f}').Trim(); Remove-Item -LiteralPath '${f}' -Force; try { $v.FindAllByResource('${service(site, kind)}') | ForEach-Object { $v.Remove($_) } } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${service(site, kind)}', '${email}', $t))) } finally { Remove-Item -LiteralPath '${f}' -Force -ErrorAction SilentlyContinue }`);
    }
  } catch (e) {
    return scrub(e?.message ?? e) || "The credential store refused it.";
  } finally {
    // Gone already on success; this catches a failed start.
    await (os === "windows" ? ps(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`) : exec("rm", ["-f", file])).catch(() => null);
  }
  if (r?.code !== 0) return scrub(r?.stderr || r?.stdout) || "The credential store refused it.";
  // `security -i` can exit 0 when its command failed: read it back to be sure.
  forget(site);
  const back = await readStore(site, kind);
  if (back?.token !== token || back?.email !== email) return "The credential store didn't keep it. Try again, or use environment variables.";
  return null;
}

// Removes every stored item for a site and kind, whatever account each was stored under.
async function clearStore(site, kind) {
  const os = platform();
  if (os === "macos") {
    // delete-generic-password removes one item per call, and fails once none is left.
    for (let i = 0; i < 10; i++) {
      const r = await exec("security", ["delete-generic-password", "-s", service(site, kind)]).catch(() => null);
      if (r?.code !== 0) break;
    }
  } else if (os === "linux") await exec("secret-tool", ["clear", "service", `herdr-${kind}`, "site", site]).catch(() => null);
  else await ps(`${VAULT}; try { $v.FindAllByResource('${service(site, kind)}') | ForEach-Object { $v.Remove($_) } } catch {}`).catch(() => null);
}

// Removes the stored sign-in for a site (environment variables stay as they are).
export async function removeSignIn(site, kind = "jira") {
  if (!SITE.test(site)) return;
  await clearStore(site, kind);
  forget(site);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3), n = (a << 16) | (b << 8) | c;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

export class JiraError extends Error {
  constructor(status, message, site) { super(message); this.status = status; this.site = site; }
}

// `as`: explicit { email, token }; otherwise the stored sign-in.
export async function call(site, path, body, as) {
  if (!trustedSite(site)) throw new JiraError(0, `${site} isn't an Atlassian Cloud site: type it in Link space to use it.`, site);
  const c = as ?? await credentials(site);
  if (!c) throw new JiraError(401, `No Jira sign-in for ${site}.`, site);
  const r = await fetch(`https://${site}${path}`, {
    // Herdr's fetch takes method, headers and body only (no redirect option): a redirect is
    // caught below, by the answer's status or by the host of the URL it came from.
    method: body ? "POST" : "GET",
    headers: { Authorization: `Basic ${base64(`${c.email}:${c.token}`)}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if ((r.status >= 300 && r.status < 400) || !sameHost(r.url, site)) throw new JiraError(r.status, `${site} redirects elsewhere: check the site name in Link space.`, site);
  if (!r.ok) {
    if (r.status === 401 && !as) forget(site);
    const text = await r.text().catch(() => "");
    let message = text.slice(0, 300);
    try { const j = JSON.parse(text); message = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join(" ") || message; } catch { /* not JSON */ }
    throw new JiraError(r.status, `Jira ${r.status} (${site}): ${message}`, site);
  }
  // Parsed here, not with r.json(): that one's result lives in the app, and every read of it
  // crosses over (converting one issue page took 2 s instead of 80 ms).
  return JSON.parse(await r.text());
}

// Whether the URL an answer came from (after any redirect Herdr followed) is on `site`. An
// answer without a URL passes: the status check above still applies.
function sameHost(url, site) {
  if (typeof url !== "string" || !url) return true;
  const host = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1]?.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  return host === site;
}

export const myself = (site, as) => call(site, "/rest/api/3/myself", undefined, as);

// Up to 20 projects whose key or name matches `query`, as { key, name }.
export async function findProjects(site, query) {
  const page = await call(site, `/rest/api/3/project/search?maxResults=20&orderBy=name&query=${encodeURIComponent(query)}`);
  return (page.values ?? []).map((p) => ({ key: p.key, name: p.name }));
}

// The host from what was typed or pasted (a URL works); check it with validSite.
export const cleanSite = (text) => (text ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
