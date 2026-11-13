// A read-only code view colored by ranch-highlight (Herdr Ranch's tree-sitter helper): CFML with
// cfscript and <cfquery> SQL, JS, TS, HTML, CSS, SQL, Python, Java, C#, Go, Rust, PHP, Ruby, YAML,
// Bash, Markdown and more. Lines are drawn as colored pieces in a `list`, so only the rows on
// screen are built, and long lines wrap. Without the helper, or for a language it lacks, the
// caller keeps Herdr's own editor.

import { div, list } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, appHome, home, writeTextFile } from "herdr";

const DIR = "data/herdr-ranch/highlight", TAB = 4;
let helperBin = null, exts = null, seq = 0;

// The helper and the file extensions it knows, asked once per session.
async function helper() {
  helperBin ??= (async () => {
    for (const bin of [`${home()}/.local/bin/ranch-highlight`, "ranch-highlight"]) {
      const r = await exec(bin, ["--languages"], { timeout: 5000 }).catch(() => null);
      if (r?.code !== 0) continue;
      try { exts = new Set(JSON.parse(r.stdout).flatMap((l) => l.extensions ?? [])); } catch { exts = new Set(); }
      return bin;
    }
    return null;
  })();
  return helperBin;
}

// Whether the helper colors this path (by extension, or the few names it knows).
export async function supports(path) {
  if (!(await helper())) return false;
  const name = path.split("/").pop() ?? "";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(name)) return true;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return Boolean(ext && exts?.has(ext));
}

// Tabs as TAB spaces, as the helper counts them.
export const expand = (line) => (line.includes("\t") ? line.replace(/\t/g, " ".repeat(TAB)) : line);

// The spans of every line ([[start, end, class], ...] per line), or null. The text goes in the
// request (the file may be on another machine); Herdr's exec has no stdin, so through a file.
export async function highlight(path, text) {
  const bin = await helper();
  if (!bin) return null;
  const dir = `${appHome()}/${DIR}`, file = `${dir}/file-${Date.now().toString(36)}-${(seq++).toString(36)}.jsonl`;
  await exec("mkdir", ["-p", dir]).catch(() => null);
  try {
    await writeTextFile(file, `${JSON.stringify({ id: 0, path, text, tab: TAB })}\n`, null);
    const r = await exec(bin, ["--requests", file], { timeout: 30000 });
    const a = JSON.parse((r.stdout ?? "").split("\n").find((l) => l.trim()) ?? "null");
    return a?.lines?.length ? a.lines : null;
  } catch { return null; }
  finally { exec("rm", ["-f", file]).catch(() => null); }
}

// Highlight classes to theme colors, as the Herdr Ranch diff views use them.
const CLASS = {
  keyword: "ansi5", "punctuation.special": "ansi5", string: "ansi2", "text.literal": "ansi2", comment: "dim",
  function: "ansi4", "function.method": "ansi4", property: "ansi4", "text.title": "ansi4", "text.uri": "ansi4", "markup.heading": "ansi4", "markup.link": "ansi4",
  type: "ansi3", "type.builtin": "ansi3", constructor: "ansi3", attribute: "ansi3", label: "ansi3", module: "ansi3", "text.emphasis": "ansi3", "text.strong": "ansi3",
  number: "ansi6", boolean: "ansi6", constant: "ansi6", "constant.builtin": "ansi6", escape: "ansi6", "string.escape": "ansi6", "string.special": "ansi6", "string.regex": "ansi6",
  tag: "ansi1", "tag.error": "ansi1", "variable.builtin": "ansi1",
};
const colorOf = (c, t) => { const k = CLASS[c] ?? CLASS[c.split(".")[0]]; return k ? t[k] : null; };

// One line as colored pieces; plain when it has no spans.
function code(text, spans, t) {
  if (!spans?.length || !text) return text || " ";
  const parts = [];
  let at = 0;
  const add = (to, color) => {
    if (to <= at) return;
    const last = parts[parts.length - 1];
    if (last && last.color === color) last.end = to; else parts.push({ start: at, end: to, color });
    at = to;
  };
  for (const [s0, e0, c] of spans) {
    const s = Math.min(s0, text.length), e = Math.min(e0, text.length);
    if (s > at) add(s, null);
    add(e, colorOf(c, t));
  }
  add(text.length, null);
  if (parts.length === 1 && !parts[0].color) return text;
  return h_flex().flex_wrap().items_start().children(parts.map((p) => div().whitespace_nowrap().when(Boolean(p.color), (e) => e.text_color(p.color)).child(text.slice(p.start, p.end))));
}

// The view: `lines` (tabs expanded), `spans` (per line, or null while they load).
export function codeView(id, lines, spans, t, font, size = 12) {
  const w = String(lines.length).length;
  return list(id, lines.length, (i) => `l${i}`, (i) => h_flex().w_full().items_start().gap(10).px(10).font_family(font).text_size(size).text_color(t.foreground)
    .child(div().flex_none().text_right().text_color(t.dim).child(String(i + 1).padStart(w)))
    .child(div().flex_1().min_w(0).child(code(lines[i], spans?.[i], t))));
}
