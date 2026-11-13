// A stand-in for "gpui-kit" and "gpui-base": every element builder returns a chainable no-op.
const el = () => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : () => el()), apply: () => el() });
export const div = el, svg = el, image = el, v_flex = el, h_flex = el, v_resizable = el, resizable_panel = el;
export class View {}
export const InputState = { new: () => el() }, Input = { new: el }, TextareaState = { new: () => el() }, Textarea = { new: el }, TextView = { markdown: el };
export const Avatar = { new: el }, AvatarImage = { new: el }, AvatarFallback = { new: el };
export const list = el;
