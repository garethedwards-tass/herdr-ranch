// The Commits tab of a pull request's page: its commits by day, oldest first, as GitHub lists
// them, each with its short sha, title, author, check state and age. A click opens that
// commit's diff in the Files tab's view, with Back, [ and ] for the older and newer commit.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { fs, icon, kindColor } from "./links.js";
import { ago, byDay } from "./data.js";
import { filesTab } from "./files-tab.js";

const MONO = "Menlo";
const CHECK = { pass: "check", fail: "x", pending: "pending" };
const dayLabel = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

// `c`: { list (null while loading), total, error, open (the open commit), at (its index),
// pick(sha, cx), back(cx), step(by, cx), retry(cx), copy(sha, cx), url(sha), openUrl, diff }.
export function commitsTab(t, k, c) {
  if (c.error) return [h_flex().gap(8).items_center().text_size(fs.meta).text_color(t.ansi1).child(`Commits didn't load: ${c.error}`).child(k.button("commits-retry", "Retry", (cx) => c.retry(cx)))];
  if (!c.list) return [div().text_size(fs.meta).text_color(t.dim).child("Loading the commits…")];
  if (!c.list.length) return [div().text_color(t.dim).child("No commits.")];
  return c.open ? commitPage(t, k, c) : commitList(t, k, c);
}

function commitList(t, k, c) {
  const row = (x) => h_flex().id(`commit-${x.sha}`).gap(10).items_center().px(12).py(6).text_size(fs.meta).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => c.pick(x.sha, cx))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.title || "(no message)"))
    .child(div().flex_none().text_color(t.muted).child(x.author))
    .child(div().w(16).flex_none().child(x.checks ? icon(CHECK[x.checks], kindColor(CHECK[x.checks], t), 13) : div()))
    .child(div().id(`sha-${x.sha}`).flex_none().px(5).rounded(4).font_family(MONO).text_color(t.accent).hover((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); c.copy(x.sha, cx); }).child(x.short))
    .child(div().w(34).flex_none().text_right().text_color(t.dim).child(x.at ? ago(x.at) : ""));
  return [
    ...byDay(c.list).map((d) => v_flex().gap(4)
      .child(h_flex().gap(6).items_center().text_size(fs.tiny).font_semibold().text_color(t.muted).child(div().text_color(t.dim).child("○")).child(`Commits on ${dayLabel(d.day)}`))
      .child(v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden()
        .children(d.commits.map((x, i) => row(x).when(i > 0, (e) => e.border_t_1().border_color(t.border)))))),
    c.total > c.list.length ? div().text_size(fs.meta).text_color(t.dim).child(`${c.total - c.list.length} older commits are on GitHub.`) : null,
  ].filter(Boolean);
}

function commitPage(t, k, c) {
  const x = c.open, n = c.list.length;
  const head = v_flex().gap(6).px(12).py(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(6).items_center().text_size(fs.meta)
      .child(k.button("commit-back", "← All commits", (cx) => c.back(cx), { hint: "⌫" }))
      .child(k.arrow("commit-older", "[", (cx) => c.step(-1, cx), c.at > 0))
      .child(k.arrow("commit-newer", "]", (cx) => c.step(1, cx), c.at < n - 1))
      .child(div().text_color(t.muted).child(`${c.at + 1} of ${n}`))
      .child(div().flex_1())
      .child(k.button("commit-copy", x.short, (cx) => c.copy(x.sha, cx), { icon: "copy" }))
      .child(k.button("commit-github", "Open on GitHub", () => c.openUrl(c.url(x.sha)))))
    .child(div().font_semibold().text_size(fs.body).child(x.title || "(no message)"))
    .when(Boolean(x.body), (e) => e.child(div().text_size(fs.meta).text_color(t.muted).font_family(MONO).child(x.body.length > 1500 ? `${x.body.slice(0, 1500)}…` : x.body)))
    .child(h_flex().gap(6).items_center().text_size(fs.meta).text_color(t.muted)
      .child(div().font_semibold().text_color(t.foreground).child(x.author)).child(x.at ? `committed ${ago(x.at)} ago` : "")
      .when(Boolean(x.checks), (e) => e.child(icon(CHECK[x.checks], kindColor(CHECK[x.checks], t), 13))));
  return [head, ...filesTab([], t, k, { ...c.diff, hideGithub: true }, 0)];
}
