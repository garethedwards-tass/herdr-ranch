// Small UI parts for the History panel: text sizes from Herdr's UI font size, a button, a
// pill, an arrow, and a segmented control. The diff view (files-tab.js, from Herdr Ranch's
// Pull requests mod) uses the same names.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings, appHome, exec, readTextFile, writeTextFile } from "herdr";

export const fs = { body: 13, meta: 12, tiny: 11 };
export function readSizes() {
  let b = 13;
  try { b = Math.round(Number(settings()?.ui_font_size)) || 13; } catch { /* the default */ }
  return Object.assign(fs, { body: b, meta: b - 1, tiny: b - 2 });
}

export function kit(t) {
  const k = {};
  k.kbd = (text) => div().px(4).rounded(4).border_1().border_b_2().border_color(t.border).text_size(fs.tiny - 1).text_color(t.muted).child(text);
  k.button = (id, label, onClick, o = {}) => h_flex().id(id).flex_none().gap(6).items_center().px(10).py(4).rounded(6).cursor_pointer().text_size(fs.meta)
    .border_1().border_color(t.border).hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClick(cx)).child(label)
    .when(Boolean(o.hint), (e) => e.child(k.kbd(o.hint)));
  k.pill = (text, fg) => div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(fs.tiny).text_color(fg ?? t.muted).child(text);
  k.arrow = (id, glyph, onClick, enabled) => div().id(id).w(22).h(20).flex_none().flex().items_center().justify_center().rounded(5)
    .border_1().border_color(t.border).text_size(fs.meta).text_color(enabled ? t.muted : t.border)
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)))
    .child(glyph);
  return k;
}

// One segmented control: one option picked at a time.
export function segmented(id, options, current, pick, t) {
  return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(fs.meta)
    .children(options.map(([value, label], n) => div().id(`${id}-${value}`).px(9).py(2).cursor_pointer()
      .when(n < options.length - 1, (e) => e.border_r_1().border_color(t.border))
      .when(current === value, (e) => e.bg(t.selected).font_semibold())
      .when(current !== value, (e) => e.text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { pick(value, cx); cx.notify(); }).child(label)));
}

// The refresh button's icon, Lucide's refresh-cw: the same file Issues and Pull requests write
// (data/herdr-ranch/icons), written here too since svg() can't read a linked mod folder.
export const REFRESH_ICON = "data/herdr-ranch/icons/refresh.svg";
let refreshWritten = null;
export function writeRefreshIcon() {
  refreshWritten ??= (async () => {
    const dir = `${appHome()}/data/herdr-ranch/icons`, path = `${dir}/refresh.svg`;
    const text = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>\n`;
    await exec("mkdir", ["-p", dir]).catch(() => null);
    const now = await readTextFile(path).catch(() => null);
    if (now !== text) await writeTextFile(path, text, now).catch(() => null);
  })();
  return refreshWritten;
}
