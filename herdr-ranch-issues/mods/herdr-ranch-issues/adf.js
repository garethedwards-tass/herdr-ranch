// Atlassian Document Format (Jira Cloud's rich text) to Markdown, for the issue page and prompts.
// Unknown nodes keep their text, so nothing a ticket says is dropped.

function marks(text, list) {
  let out = text;
  for (const m of list ?? []) {
    if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `_${out}_`;
    else if (m.type === "strike") out = `~~${out}~~`;
    else if (m.type === "link" && m.attrs?.href) out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes) {
  return (nodes ?? []).map((n) => {
    switch (n.type) {
      case "text": return marks(n.text ?? "", n.marks);
      case "hardBreak": return "  \n";
      case "mention": return n.attrs?.text ?? "@someone";
      case "emoji": return n.attrs?.text ?? n.attrs?.shortName ?? "";
      case "inlineCard": case "blockCard": return n.attrs?.url ? `<${n.attrs.url}>` : "";
      case "date": return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
      case "status": return `[${n.attrs?.text ?? ""}]`;
      default: return inline(n.content);
    }
  }).join("");
}

function block(n, indent) {
  const pad = "  ".repeat(indent);
  switch (n.type) {
    case "paragraph": return pad + inline(n.content);
    case "heading": return `${"#".repeat(Math.min(6, n.attrs?.level ?? 2))} ${inline(n.content)}`;
    case "bulletList": return n.content.map((li) => item(li, "- ", indent)).join("\n");
    case "orderedList": return n.content.map((li, i) => item(li, `${(n.attrs?.order ?? 1) + i}. `, indent)).join("\n");
    case "taskList": return n.content.map((li) => `${pad}- [${li.attrs?.state === "DONE" ? "x" : " "}] ${inline(li.content)}`).join("\n");
    case "codeBlock": return `${pad}\`\`\`${n.attrs?.language ?? ""}\n${inline(n.content)}\n${pad}\`\`\``;
    case "blockquote": return blocks(n.content, indent).split("\n").map((l) => `> ${l}`).join("\n");
    case "panel": return blocks(n.content, indent).split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "table": return table(n);
    case "mediaSingle": case "mediaGroup": return "_(attachment)_";
    case "expand": case "nestedExpand": return `**${n.attrs?.title ?? "Details"}**\n\n${blocks(n.content, indent)}`;
    default: return n.content ? blocks(n.content, indent) : inline([n]);
  }
}

function item(li, bullet, indent) {
  const [first, ...rest] = li.content ?? [];
  const head = `${"  ".repeat(indent)}${bullet}${first ? block(first, 0) : ""}`;
  return [head, ...rest.map((c) => block(c, indent + 1))].join("\n");
}

function table(n) {
  const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => blocks(c.content, 0).replace(/\n+/g, " ").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function blocks(nodes, indent) {
  return (nodes ?? []).map((n) => block(n, indent)).filter((s) => s !== "").join("\n\n");
}

export function adfToMarkdown(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return blocks(doc.content, 0).trim();
}
