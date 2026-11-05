// Pure logic for Reviews, shared by the mod and the `ranch-review` CLI (which imports this file
// from the mod folder): split Markdown into blocks with their source lines, and write the
// feedback in Plannotator's format, so skills written for `plannotator annotate` and
// `plannotator last` read ours the same way. No Herdr imports here.

export const MOD = "herdr-ranch-reviews";
export const MAX_TEXT = 512 * 1024; // a review's text, in characters
export const MAX_BYTES = 600 * 1024; // a new review file, in bytes: the mod reads files up to 1 MiB, and comments come on top
export const KEEP_DAYS = 7; // finished reviews older than this are removed by the CLI

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/;
const QUOTE = /^\s{0,3}>/;
const TABLE = /^\s{0,3}\|/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HTML = /^\s{0,3}<\/?[a-zA-Z!]/;

// Blocks of a Markdown text: { kind, start, end, text } with 1-based, inclusive line numbers.
// Kinds: heading, paragraph, item (one list item), code, quote, table, rule, html, frontmatter. Blank lines
// separate blocks; a fence runs to its closing fence (or the end).
export function splitBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const push = (kind, from, to) => blocks.push({ kind, start: from + 1, end: to + 1, text: lines.slice(from, to + 1).join("\n") });
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) { push("frontmatter", 0, close); i = close + 1; }
  }
  const blank = (l) => l === undefined || l.trim() === "";
  // A list becomes one block per top-level item (with its nested lines), so each item can get
  // its own comment. Blank lines between items stay with the item above.
  const pushItems = (from, to) => {
    const indent = (l) => l.match(/^\s*/)[0].length;
    const top = indent(lines[from]);
    let start = from;
    for (let k = from + 1; k <= to + 1; k++) {
      const l = lines[k];
      if (k > to || (LIST.test(l) && indent(l) <= top)) {
        let end = k - 1;
        while (end > start && blank(lines[end])) end--;
        push("item", start, end);
        start = k;
      }
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const mark = fence[1][0], len = fence[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const m = lines[j].match(FENCE);
        if (m && m[1][0] === mark && m[1].length >= len && lines[j].trim().replace(/[`~]/g, "") === "") break;
        j++;
      }
      push("code", i, Math.min(j, lines.length - 1)); i = j + 1; continue;
    }
    if (HEADING.test(line)) { push("heading", i, i); i++; continue; }
    if (RULE.test(line)) { push("rule", i, i); i++; continue; }
    const kind = LIST.test(line) ? "list" : QUOTE.test(line) ? "quote" : TABLE.test(line) ? "table" : HTML.test(line) ? "html" : "paragraph";
    let j = i;
    for (;;) {
      const next = lines[j + 1];
      if (next === undefined) break;
      if (blank(next)) {
        // A list goes on after a blank line when the next line is another item or indented.
        const after = lines[j + 2];
        if (kind === "list" && after !== undefined && (LIST.test(after) || /^\s{2,}\S/.test(after))) { j += 2; continue; }
        break;
      }
      if (FENCE.test(next) && kind !== "list") break;
      if (HEADING.test(next) || (RULE.test(next) && kind !== "paragraph")) break;
      if (kind === "paragraph" && (LIST.test(next) || QUOTE.test(next) || TABLE.test(next))) break;
      if (kind === "table" && !TABLE.test(next)) break;
      if (kind === "quote" && !QUOTE.test(next)) break;
      j++;
    }
    if (kind === "list") pushItems(i, j); else push(kind, i, j);
    i = j + 1;
  }
  return blocks;
}

export const lineLabel = (start, end) => (start === end ? `line ${start}` : `lines ${start}-${end}`);

// The first words of a block, for a comment's "Feedback on" quote.
export function quoteOf(text, max = 300) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

const quoted = (text) => String(text).trim().split("\n").map((l) => `> ${l}`).join("\n");

// The feedback text, as Plannotator writes it:
//   # File Feedback
//   I've reviewed this file and have 2 pieces of feedback:
//   ## 1. (lines 3-4) Feedback on: "..."
//   > comment
//   ## 2. General feedback about the file
//   > comment
//   ---
// `subject` is "file" or "message". Comments: { start?, end?, quote?, text }; one without a
// line range is general feedback. `images`: absolute paths of screenshots, listed under the
// comment for the agent to open. Comments without text or images are skipped.
export function formatFeedback(subject, comments) {
  const list = (comments ?? []).filter((c) => String(c?.text ?? "").trim() || c?.images?.length);
  if (!list.length) return "";
  const head = `# ${subject === "message" ? "Message" : "File"} Feedback`;
  const n = list.length;
  const parts = [head, "", `I've reviewed this ${subject} and have ${n} ${n === 1 ? "piece" : "pieces"} of feedback:`, ""];
  // Block comments in document order first, then general ones.
  const ordered = [...list.filter((c) => c.start).sort((a, b) => a.start - b.start), ...list.filter((c) => !c.start)];
  ordered.forEach((c, i) => {
    parts.push(c.start
      ? `## ${i + 1}. (${lineLabel(c.start, c.end ?? c.start)}) Feedback on: "${quoteOf(c.quote)}"`
      : `## ${i + 1}. General feedback about the ${subject}`);
    parts.push(quoted(c.text));
    for (const img of c.images ?? []) parts.push(`> Screenshot: ${img}`);
    parts.push("");
  });
  parts.push("---");
  return parts.join("\n");
}

// What the CLI prints for a finished review: the feedback, "The user approved.", or nothing when
// the review was discarded. `json`: one
// object with `decision`, `feedback` and `annotationCount`.
export function outcomeText(review, json = false) {
  const r = review?.result ?? { decision: "dismissed" };
  const count = (r.comments ?? []).filter((c) => String(c?.text ?? "").trim() || c?.images?.length).length;
  if (json) {
    const o = { decision: r.decision };
    if (r.feedback) { o.feedback = r.feedback; o.annotationCount = count; }
    return JSON.stringify(o);
  }
  if (r.decision === "approved") return "The user approved.";
  if (r.decision === "annotated") return r.feedback ?? "";
  return "";
}

// The prompt pasted into an agent that isn't waiting on the CLI any more.
export function pastePrompt(review) {
  const r = review?.result ?? {};
  const what = review?.kind === "last" ? "your last message" : `\`${review?.path ?? review?.title ?? "the file"}\``;
  if (r.decision === "approved" && !r.feedback) return `I reviewed ${what} in Herdr and approved it.`;
  return `I reviewed ${what} in Herdr.\n\n${outcomeText(review)}`;
}

// The last assistant message with text: from the end, the last message id that carried text,
// all its text blocks joined (Claude Code writes one line per content block).
export function lastClaudeText(lines) {
  let id = null; const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== "assistant" || o.isSidechain) { if (id && o.type === "user" && !o.isSidechain && !o.toolUseResult && typeof o.message?.content === "string") break; continue; }
    const m = o.message ?? {}, content = Array.isArray(m.content) ? m.content : [];
    const text = content.filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text).join("\n\n");
    if (!text) continue;
    if (id === null) id = m.id ?? `line-${i}`;
    if ((m.id ?? `line-${i}`) !== id) break;
    parts.unshift(text);
  }
  return parts.join("\n\n").trim() || null;
}

// A Codex rollout log (~/.codex/sessions/.../rollout-*.jsonl): the folder it ran in (from its
// session_meta header) and its last assistant message, from a `response_item` message or an
// `agent_message` event, whichever comes last.
export function lastCodexText(lines) {
  let meta = null; try { meta = JSON.parse(lines[0]); } catch { /* no header */ }
  const cwd = meta?.payload?.cwd ?? meta?.cwd ?? null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const p = o.payload ?? o;
    if (p.type === "message" && p.role === "assistant") {
      const text = (p.content ?? []).filter((c) => c.type === "output_text" || c.type === "text").map((c) => c.text).join("\n\n").trim();
      if (text) return { cwd, text };
    }
    if (p.type === "agent_message" && p.message?.trim()) return { cwd, text: p.message.trim() };
  }
  return { cwd, text: null };
}

// The images of a block that holds nothing else (`![alt](src)` lines, maybe wrapped in a link):
// [{ alt, src }], or null. Herdr's Markdown view draws nothing for images, so the review shows them
// itself.
export function imageOnly(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim());
  const out = [];
  for (const l of lines) {
    const m = l.trim().match(/^\[?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(?:\]\([^)]*\))?$/);
    if (!m) return null;
    out.push({ alt: m[1], src: m[2] });
  }
  return out.length ? out : null;
}

// A review id: sortable by time, unique enough for one machine.
export function newId(now = Date.now(), rand = Math.random) {
  return `${now.toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

// Where a review stands, for the list: "waiting" (open, an agent or the CLI waits), "abandoned"
// (open, but the mod found its `ranch-review` gone: `orphan` set), "sent",
// "approved", "dismissed", or "undelivered" (sent, but neither the CLI nor a paste took it).
export function stateOf(review) {
  if (!review) return "dismissed";
  if (review.status === "open") return review.orphan ? "abandoned" : "waiting";
  if (review.delivery === "kept" && review.status !== "dismissed") return "undelivered";
  return review.status;
}

// "3m", "2h", "4d" since an ISO time.
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// Search in a review. Rendered, a block matches on the text you see (no link targets, no `*_#>`
// markers); in Source, on its Markdown. Case-insensitive; an empty query matches nothing (null).
const visible = (text) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "");
export function matchBlocks(blocks, query, source = false) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  return blocks.flatMap((b, i) => ((source ? b.text : visible(b.text)).toLowerCase().includes(q) ? [i] : []));
}

// How many times `query` occurs in the blocks, counted as matchBlocks matches (0 when empty).
export function countMatches(blocks, query, source = false) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  return blocks.reduce((n, b) => n + (source ? b.text : visible(b.text)).toLowerCase().split(q).length - 1, 0);
}

// A line cut into [text, hit] pieces around each match of `query`, for highlighting.
export function hitsIn(line, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [[line, false]];
  const out = [], low = line.toLowerCase();
  let at = 0;
  for (let k = low.indexOf(q); k >= 0; k = low.indexOf(q, at)) {
    if (k > at) out.push([line.slice(at, k), false]);
    out.push([line.slice(k, k + q.length), true]);
    at = k + q.length;
  }
  if (at < line.length || !out.length) out.push([line.slice(at), false]);
  return out;
}

// One review per document: a file by its absolute path, a last message by its agent's terminal.
// A newer review of the same document replaces an older open one (`superseded`).
export function docKey(r) {
  if (r?.kind === "file" && r.path) return `file:${r.path}`;
  if (r?.kind === "last" && r.agent?.terminal) return `last:${r.agent.terminal}`;
  return `id:${r?.id}`;
}
// Ids sort by time (newId), so the largest id is the newest.
export function newestPerDoc(reviews) {
  const best = new Map();
  for (const r of reviews) { const k = docKey(r), b = best.get(k); if (!b || String(r.id) > String(b.id)) best.set(k, r); }
  return [...best.values()];
}

// Unsent comments of a replaced review, moved onto the new text: a block comment goes to the
// first block that still starts with its quote (lines updated), else it becomes a general
// comment that says where it was. General comments move as they are.
export function carryDraft(draft, blocks) {
  const head = (s) => String(s ?? "").replace(/…$/, "").trim();
  return (draft ?? []).map((c) => {
    if (c.block == null) return c;
    const q = head(c.quote), i = q ? blocks.findIndex((b) => b.text.trim().startsWith(q)) : -1;
    if (i >= 0) return { ...c, block: i, start: blocks[i].start, end: blocks[i].end };
    const { block: _b, start: _s, end: _e, ...rest } = c;
    return { ...rest, text: `(${lineLabel(c.start, c.end)} before the update: "${quoteOf(c.quote, 60)}") ${c.text}` };
  });
}

// A block's Markdown with each match of `query` wrapped in <mark> (Herdr's TextView shows it
// highlighted). Code spans, link targets and HTML tags are left alone; a match that crosses
// Markdown markers (`**Bold** words`) isn't marked, though the block still matches.
export function markHits(markdown, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return markdown;
  return String(markdown).split(/(`+[^`]*`+|\]\([^)]*\)|<[^>\n]+>)/).map((part, k) => (k % 2
    ? part
    : hitsIn(part, q).map(([text, hit]) => (hit ? `<mark>${text}</mark>` : text)).join(""))).join("");
}

// --- Nobody waiting -------------------------------------------------------------------------

// A review whose `ranch-review` stopped (a signal, or the agent's session ended): closed as
// abandoned, so it leaves the list and nobody is asked to answer it. null when it isn't open.
export function abandon(review, now = Date.now()) {
  if (review?.status !== "open") return null;
  return { ...review, status: "dismissed", waiting: null, finishedAt: new Date(now).toISOString(), result: { decision: "abandoned", comments: [] } };
}

// True for an open review whose waiting `ranch-review` is gone: its pid is set and `isAlive`
// says no. A review with no pid (`waiting: null`) isn't: its answer is pasted into the agent.
export function orphaned(review, isAlive) {
  const pid = review?.waiting?.pid;
  return review?.status === "open" && Number.isInteger(pid) && !isAlive(pid);
}

// How long a review has been open: "under a minute", "12 min", "3 h 47 min", "2 d 4 h".
export function openFor(iso, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

// --- Changes since the last sent review ------------------------------------------------------

// Which blocks are new or changed against an earlier text (the last review you sent of the same
// file): true for a block whose kind and text (trimmed) the earlier text doesn't have. Each
// earlier block matches once, so a duplicated paragraph counts as new.
export function changedBlocks(blocks, baseText) {
  const left = new Map();
  const key = (b) => `${b.kind}\n${b.text.trim()}`;
  for (const b of splitBlocks(baseText ?? "")) left.set(key(b), (left.get(key(b)) ?? 0) + 1);
  return blocks.map((b) => {
    const n = left.get(key(b)) ?? 0;
    if (n > 0) { left.set(key(b), n - 1); return false; }
    return true;
  });
}

// What the document shows with unchanged blocks folded: { block: i } rows and { fold: [from, to] }
// rows (inclusive block indices). A run of two or more unchanged blocks folds; a single one
// shows. `shown` (a Set of indices) stays visible: blocks with comments, the one being
// commented, search hits. `unfolded` holds the `from` of folds opened by a click.
export function foldRuns(changed, shown = new Set(), unfolded = new Set()) {
  const out = [];
  for (let i = 0; i < changed.length;) {
    if (changed[i] || shown.has(i)) { out.push({ block: i }); i++; continue; }
    let j = i;
    while (j + 1 < changed.length && !changed[j + 1] && !shown.has(j + 1)) j++;
    if (j > i && !unfolded.has(i)) out.push({ fold: [i, j] });
    else for (let k = i; k <= j; k++) out.push({ block: k });
    i = j + 1;
  }
  return out;
}
