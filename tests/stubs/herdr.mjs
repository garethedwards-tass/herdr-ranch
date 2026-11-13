// A stand-in for Herdr's "herdr" module, so the mods' pure logic runs under node --test.
export const state = { spaces: [], shared: {}, files: {}, dirs: {}, platform: "macos", fetch: null, fetched: [], ran: [] };

// Herdr's global fetch, as strict as the app's: options are method, headers and body only, and
// anything else is refused with the app's own message (a "redirect" option once broke every
// Jira call). Tests answer through state.fetch(url, init).
const FETCH_OPTIONS = new Set(["method", "headers", "body"]);
globalThis.fetch = async (url, init = {}) => {
  for (const k of Object.keys(init)) if (!FETCH_OPTIONS.has(k)) throw new Error(`unknown option \`${k}\` for fetch(url, options); expected method, headers or body`);
  if (typeof url !== "string") throw new Error("fetch: url must be a string");
  if (init.body != null && typeof init.body !== "string") throw new Error("fetch: body must be a string");
  state.fetched.push({ url, init });
  if (!state.fetch) throw new Error(`no fake answer for ${url}`);
  return state.fetch(url, init);
};
export const spaces = () => state.spaces;
export const shared = (k) => state.shared[k];
export const setShared = (k, v) => { state.shared[k] = v; };
export const readTextFile = async (p) => state.files[p] ?? null;
export const writeTextFile = async (_path, text) => { state.lastWrite = text; return null; };
export const exec = async (cmd, args) => (state.exec?.(cmd, args)) ?? (cmd === "ls" && state.dirs[args[1]] ? { code: 0, stdout: state.dirs[args[1]].join("\n"), stderr: "" } : { code: 1, stdout: "", stderr: "" });
export const window = () => ({ platform: state.platform });
export const appHome = () => "/tmp/herdr-test";
export const home = () => "/Users/test";
export const watchFolder = () => new Promise(() => {});
const noop = () => null;
export const run = (name, args) => { state.ran.push([name, args]); return null; };
export const _unused = noop, openOverlay = noop, closeOverlay = noop, notify = noop, props = () => ({}), theme = () => ({}), settings = () => ({ ui_font_size: 13 });
export const knownAgents = async () => [], nextCommand = () => new Promise(() => {});
export const agents = () => state.agents ?? [], terminals = () => state.terminals ?? [];
export const panes = () => state.panes ?? [];
