// The Files tab of a pull request's page: each changed file as a card whose header opens its
// diff, unified (one column, old and new line numbers) or split (old left, new right). A file
// marked Viewed folds away. Only open files draw their lines, at most FIRST_LINES each until
// "Show more", so a large pull request stays inside Herdr's render time.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { fs, segmented } from "./ui.js";
import { visible, MORE_LINES } from "./diff.js";

const MONO = "Menlo";
const STATUS = { added: ["added", "ansi2"], removed: ["deleted", "ansi1"], renamed: ["renamed", "ansi4"], copied: ["copied", "ansi4"] };
// "  12" in a fixed-width column; nothing for a side the line isn't on.
const num = (n, w) => (n == null ? "" : String(n)).padStart(w);

// `files`: the list's rows (path and counts) until the diffs load. `d`: { files (prepared, or
// null while loading), error, mode, viewed (offer Viewed), hideGithub, isOpen(path), isViewed(path), limit(path), toggle(path, cx),
// view(path, cx), more(path, cx), setMode(mode, cx), all(open, cx), retry(cx), github (url of
// the pull request's files on GitHub), openUrl }.
export function filesTab(rows, t, k, d, more) {
  const loaded = d.files, list = loaded ?? rows;
  if (!list.length && !d.error) return [div().text_color(t.dim).child(loaded || !d.loading ? "No files." : "Loading the files…")];
  const tint = (c) => c + "26", strong = (c) => c + "3a";
  const viewed = loaded ? loaded.filter((f) => d.isViewed(f.path)).length : 0;
  const anyOpen = loaded?.some((f) => d.isOpen(f.path));

  const toolbar = h_flex().flex_none().flex_wrap().gap(8).items_center().text_size(fs.meta).text_color(t.muted)
    .child(segmented("diff-mode", [["unified", "Unified"], ["split", "Split"]], d.mode, (m, cx) => d.setMode(m, cx), t, false))
    .when(Boolean(loaded), (e) => e.child(k.button("diff-all", anyOpen ? "Collapse all" : "Expand all", (cx) => d.all(!anyOpen, cx), { hint: "E" })))
    .child(div().flex_1())
    .when(Boolean(loaded) && d.viewed, (e) => e.child(`${viewed} of ${loaded.length} viewed`))
    .when(!d.viewed && Boolean(loaded), (e) => e.child(`${loaded.length} file${loaded.length === 1 ? "" : "s"}`))
    .when(!d.hideGithub, (e) => e.child(k.button("diff-github", "Files on GitHub", () => d.openUrl(d.github))));

  // One line of the unified view: both numbers and the sign in one fixed-width run, then the
  // text, which wraps. Three elements a line keeps a long diff cheap to lay out.
  const unifiedLine = (l, w) => {
    const bg = l.kind === "add" ? tint(t.ansi2) : l.kind === "del" ? tint(t.ansi1) : null;
    if (l.kind === "note") return div().pl(8).py(1).text_color(t.dim).child(`\\ ${l.text}`);
    return h_flex().items_start().when(Boolean(bg), (e) => e.bg(bg))
      .child(div().flex_none().whitespace_nowrap().pl(4).text_color(bg ? t.muted : t.dim).when(Boolean(bg), (e) => e.bg(strong(l.kind === "add" ? t.ansi2 : t.ansi1)))
        .child(`${num(l.old, w)} ${num(l.new, w)} ${l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}`))
      .child(div().flex_1().min_w(0).pl(6).pr(8).child(l.text || " "));
  };
  // One side of a split row: its number and text, tinted by kind; an empty side is shaded.
  const side = (l, kind, w) => {
    if (!l) return h_flex().flex_1().min_w(0).self_stretch().bg(t.surface);
    const c = l.kind === "ctx" ? null : kind === "old" ? t.ansi1 : t.ansi2;
    return h_flex().flex_1().min_w(0).items_start().self_stretch().when(Boolean(c), (e) => e.bg(tint(c)))
      .child(div().flex_none().self_stretch().whitespace_nowrap().px(4).text_color(c ? t.muted : t.dim).when(Boolean(c), (e) => e.bg(strong(c))).child(num(kind === "old" ? l.old : l.new, w)))
      .child(div().flex_1().min_w(0).pl(6).pr(8).child(l.text || " "));
  };
  const splitRow = (r, w) => (r.note ? div().pl(8).py(1).text_color(t.dim).child(`\\ ${r.note}`)
    : h_flex().items_start().child(side(r.left, "old", w)).child(div().w(1).self_stretch().bg(t.border)).child(side(r.right, "new", w)));
  const hunkHead = (h) => h_flex().gap(8).px(8).py(3).bg(t.surface).text_color(t.dim)
    .child(div().flex_none().text_color(t.accent).child(h.header)).child(div().min_w(0).truncate().child(h.context));

  const body = (f) => {
    if (f.why) return div().px(12).py(8).text_color(t.dim).child(f.why);
    const v = visible(f, d.mode, d.limit(f.path));
    const line = d.mode === "split" ? splitRow : unifiedLine;
    return v_flex().font_family(MONO).text_size(fs.meta).line_height(1.45)
      .children(v.hunks.flatMap((h) => [hunkHead(h), ...h.items.map((x) => line(x, f.digits ?? 4))]))
      .when(v.shown < v.total, (e) => e.child(h_flex().id(`more-${f.path}`).gap(6).px(12).py(6).border_t_1().border_color(t.border).bg(t.surface)
        .text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => d.more(f.path, cx))
        .child(`Show ${Math.min(MORE_LINES, v.total - v.shown)} more lines`).child(div().text_color(t.dim).child(`(${v.total - v.shown} hidden)`))));
  };

  const card = (f, i) => {
    const open = Boolean(loaded) && d.isOpen(f.path), seen = Boolean(loaded) && d.isViewed(f.path);
    const st = STATUS[f.status];
    const head = h_flex().id(`file-${i}`).gap(8).items_center().px(10).py(5).bg(t.surface).text_size(fs.meta)
      .when(open, (e) => e.border_b_1().border_color(t.border))
      .when(Boolean(loaded), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => d.toggle(f.path, cx)))
      .child(div().w(10).flex_none().text_color(t.muted).child(loaded ? (open ? "▾" : "▸") : ""))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).when(seen, (e) => e.text_color(t.muted))
        .child(f.from ? `${f.from} → ${f.path}` : f.path))
      .when(Boolean(st), (e) => e.child(k.pill(st[0], t[st[1]])))
      .child(div().flex_none().text_color(t.ansi2).child(`+${f.additions}`))
      .child(div().flex_none().w(44).text_right().text_color(t.ansi1).child(`−${f.deletions}`))
      .when(Boolean(loaded) && d.viewed, (e) => e.child(h_flex().id(`viewed-${i}`).flex_none().gap(5).items_center().px(6).py(1).rounded(5).border_1()
        .border_color(seen ? t.accent : t.border).text_color(seen ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); d.view(f.path, cx); })
        .child(div().size(10).rounded(2).border_1().border_color(seen ? t.accent : t.input ?? t.border).when(seen, (x) => x.bg(t.accent)))
        .child("Viewed")));
    return v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().child(head).when(open, (e) => e.child(body(f)));
  };

  return [
    toolbar,
    d.error ? h_flex().gap(8).items_center().text_size(fs.meta).text_color(t.ansi1).child(`Diffs didn't load: ${d.error}`).child(k.button("diff-retry", "Retry", (cx) => d.retry(cx)))
      : !loaded ? div().text_size(fs.meta).text_color(t.dim).child("Loading the diffs…") : null,
    ...list.map(card),
    more > 0 ? div().text_size(fs.meta).text_color(t.dim).child(`${more} more files are on GitHub.`) : null,
  ].filter(Boolean);
}
