// The diff list as a retained child view: it redraws only when its owner asks (`cx.notify(it)`),
// not on every live change that redraws the panel (an agent's status, focus), so a large open
// diff isn't rebuilt every few seconds. NOTES.md: "Split a big view into retained child views".
// Props: { owner, id, scroll? }: the owner's diffProps(owner.diffKey?.()) and diffFooter(t) draw it;
// `scroll: false` when the owner's page scrolls around it.

import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import { filesTab } from "./files-tab.js";
import { kit } from "./ui.js";

export class DiffList extends View {
  init(p) { this.p = p; }

  render() {
    const t = theme(), o = this.p.owner, key = o.diffKey?.();
    const list = v_flex().id(this.p.id).gap(12)
      .children(filesTab([], t, kit(t), o.diffProps(key), 0))
      .children(o.diffFooter?.(t, key) ?? []);
    return this.p.scroll === false ? list : list.size_full().min_h(0).overflow_y_scrollbar().px(12).py(10);
  }
}
