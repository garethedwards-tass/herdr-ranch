// Maps Herdr's built-in module names to the stubs.
export async function resolve(spec, ctx, next) {
  if (spec === "herdr") return { url: new URL("./herdr.mjs", import.meta.url).href, shortCircuit: true };
  if (spec === "gpui-kit" || spec === "gpui-base") return { url: new URL("./gpui.mjs", import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
