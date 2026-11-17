import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { Logs } from "./logs.js";
import { Menu } from "./menu.js";

// The servers panel, { view: "logs", machine, container } for a container's logs dialog, or
// { menu: "container" | "machine", … } for a row's menu (herdr-ranch).
export default class Servers extends View {
  init(_props, cx) {
    this.view = props()?.view === "logs" ? new Logs() : props()?.menu ? new Menu() : new Panel();
    this.view.init(props(), cx);
  }

  render(cx) {
    return this.view.render(cx);
  }
}
