// What the Spaces list hands to Herdr's own mods, and the icons it draws itself.

import { openOverlay, appHome, readTextFile, writeTextFile, exec, window as appWindow } from "herdr";

// Herdr's worktree dialog: { space, action: "new" | "open" | "remove" }, or { folder, machine }.
export function openWorktree(p) {
  openOverlay({ mod: "worktree", kind: "dialog", ...(p.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: p });
}

// svg() can't read through the linked mod folder: icons are written under the app's data folder.
export const ICONS = "data/herdr-ranch-spaces/icons";
const LUCIDE = {
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "branch-plus": '<path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 6a9 9 0 0 0-9 9"/><path d="M18 15v6"/><path d="M21 18h-6"/>',
  unplug: '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
};
let written = null;
export function writeIcons() {
  written ??= (async () => {
    const dir = `${appHome()}/${ICONS}`;
    const win = (() => { try { return appWindow().platform === "windows"; } catch { return false; } })();
    await (win ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`]) : exec("mkdir", ["-p", dir])).catch(() => null);
    for (const [name, body] of Object.entries(LUCIDE)) {
      const path = `${dir}/${name}.svg`;
      const text = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
      const now = await readTextFile(path).catch(() => null);
      if (now !== text) await writeTextFile(path, text, now).catch(() => null);
    }
  })();
  return written;
}

// Our own dialogs: the list opens itself with props.dialog.
const MOD = "herdr-ranch-spaces";
export function openNew(space, mode = "branch") {
  openOverlay({ mod: MOD, kind: "dialog", width: 600, height: 520, props: { dialog: "new", space, mode } });
}
export function openRemove(p) {
  openOverlay({ mod: MOD, kind: "dialog", width: 460, height: 240, props: { dialog: "remove", path: p.path, main: p.main, on: p.on ?? null, branch: p.branch ?? null } });
}
// A space's checkout, or `at` ({ folder, on }): a worktree no space shows.
export function openAccount(space) {
  openOverlay({ mod: MOD, kind: "dialog", width: 520, height: 560, props: { dialog: "account", space } });
}

// `action` "fetch" or "pull": run it as soon as the dialog has read the checkout.
export function openGit(space, tab = "status", at = null, action = null) {
  openOverlay({ mod: MOD, kind: "dialog", width: 620, height: at ? 640 : 600, props: { dialog: "git", space, tab, ...(at ? { folder: at.folder, on: at.on ?? null } : {}), ...(action ? { action } : {}) } });
}
