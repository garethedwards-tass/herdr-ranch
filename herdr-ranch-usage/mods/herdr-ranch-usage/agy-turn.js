// Antigravity CLI's context numbers, from one gen_metadata row of a conversation's sqlite file
// (shared: the Agents list and Usage read it).
//
// The row is a protobuf without a published schema. Read from real conversations: field 1 holds
// the turn; in it 9.10.1 is the tokens in context and 9.10.4 the limit compaction works to
// (512,000 for Gemini 4, below the model's full window); 1 → 4 is that call's tokens: 2 new input,
// 3 output, 5 read from cache. A row of another shape (a whole prompt record, or a later agy that
// moved them) gives null, never a wrong number.

// Protobuf, only as far as reading: a message's fields as [number, value] (varints as numbers,
// length-delimited ones as bytes). Null when the bytes aren't a message.
function fields(b) {
  const out = [];
  let i = 0;
  const varint = () => { let r = 0, m = 1, c; do { if (i >= b.length) throw 0; c = b[i++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return r; };
  try {
    while (i < b.length) {
      const k = varint(), f = Math.floor(k / 8), w = k % 8;
      if (f === 0) return null;
      if (w === 0) out.push([f, varint()]);
      else if (w === 1) { i += 8; out.push([f, null]); }
      else if (w === 5) { i += 4; out.push([f, null]); }
      else if (w === 2) { const n = varint(); if (i + n > b.length) return null; out.push([f, b.subarray(i, i + n)]); i += n; }
      else return null;
    }
  } catch { return null; }
  return i === b.length ? out : null;
}
const field = (b, n) => (b ? fields(b)?.find(([f, v]) => f === n && v instanceof Uint8Array)?.[1] ?? null : null);
const number = (b, n) => { const v = b ? fields(b)?.find(([f, x]) => f === n && typeof x === "number")?.[1] : null; return typeof v === "number" ? v : null; };
const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

// One gen_metadata row (hex) → { context, window, input, output, cacheRead }, or null when it
// isn't a turn's record.
export function parseAgyTurn(hex) {
  if (!/^(?:[0-9A-Fa-f]{2})+$/.test(hex ?? "")) return null;
  const turn = field(fromHex(hex), 1);
  const usage = field(field(turn, 9), 10), call = field(turn, 4);
  const context = number(usage, 1), window = number(usage, 4);
  if (context == null || !(window > 0) || context > window * 2) return null;
  return { context, window, input: number(call, 2) ?? 0, output: number(call, 3) ?? 0, cacheRead: number(call, 5) ?? 0 };
}

