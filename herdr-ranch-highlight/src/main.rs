//! ranch-highlight: syntax highlighting for Herdr Ranch's diff views, with tree-sitter.
//!
//! Mods can't load native code, so they run this and talk to it over stdin and stdout, one
//! JSON object per line:
//!
//!   request:  {"id": 1, "path": "src/a.cfc", "text": "..."}   (or "lang": "cfml" instead of "path")
//!   response: {"id": 1, "lang": "cfml", "lines": [[[0, 9, "keyword"], [10, 14, "function"]], []]}
//!
//! `lines` has one entry per line of `text`; each span is [start, end, class] in UTF-16 code
//! units within its line (what a JavaScript string slices by). Plain text has no span. An
//! unknown language answers `"lang": null` and no lines. `--lang <name> <file>` highlights one
//! file and prints its response; `--languages` lists the languages and their file extensions.

use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

/// The classes a mod colors. tree-sitter-highlight matches a capture to the longest of these
/// that is a prefix of it ("function.builtin.static" is "function.builtin").
const NAMES: &[&str] = &[
    "attribute", "boolean", "comment", "comment.documentation", "constant", "constant.builtin", "constructor",
    "embedded", "escape", "function", "function.builtin", "function.method", "keyword", "label", "module", "number",
    "operator", "property", "punctuation", "punctuation.bracket", "punctuation.delimiter", "punctuation.special",
    "string", "string.escape", "string.regex", "string.special", "tag", "tag.error", "type", "type.builtin",
    "variable", "variable.builtin", "variable.parameter",
];

/// Texts bigger than this aren't highlighted: a diff view shows a few hundred lines at a time.
const MAX_BYTES: usize = 2 * 1024 * 1024;

struct Lang {
    name: &'static str,
    exts: &'static [&'static str],
    config: HighlightConfiguration,
}

fn config(language: tree_sitter::Language, name: &str, highlights: &str, injections: &str, locals: &str) -> HighlightConfiguration {
    let mut c = HighlightConfiguration::new(language, name, highlights, injections, locals)
        .unwrap_or_else(|e| panic!("{name}: bad queries: {e}"));
    c.configure(NAMES);
    c
}

fn languages() -> Vec<Lang> {
    let cfml_q = |f: &str| match f {
        "cfml/highlights" => include_str!("../queries/cfml/highlights.scm"),
        "cfml/injections" => include_str!("../queries/cfml/injections.scm"),
        "cfscript/highlights" => include_str!("../queries/cfscript/highlights.scm"),
        "cfscript/injections" => include_str!("../queries/cfscript/injections.scm"),
        "cfquery/highlights" => include_str!("../queries/cfquery/highlights.scm"),
        _ => "",
    };
    vec![
        Lang { name: "cfml", exts: &["cfm", "cfml", "cfc"],
            config: config(tree_sitter_cfml::LANGUAGE_CFML.into(), "cfml", cfml_q("cfml/highlights"), cfml_q("cfml/injections"), "") },
        Lang { name: "cfscript", exts: &["cfs"],
            config: config(tree_sitter_cfml::LANGUAGE_CFSCRIPT.into(), "cfscript", cfml_q("cfscript/highlights"), cfml_q("cfscript/injections"), "") },
        Lang { name: "cfquery", exts: &[],
            config: config(tree_sitter_cfml::LANGUAGE_CFQUERY.into(), "cfquery", cfml_q("cfquery/highlights"), "", "") },
        Lang { name: "javascript", exts: &["js", "mjs", "cjs", "jsx"],
            config: config(tree_sitter_javascript::LANGUAGE.into(), "javascript",
                &format!("{}\n{}", tree_sitter_javascript::HIGHLIGHT_QUERY, tree_sitter_javascript::JSX_HIGHLIGHT_QUERY),
                tree_sitter_javascript::INJECTIONS_QUERY, tree_sitter_javascript::LOCALS_QUERY) },
        Lang { name: "html", exts: &["html", "htm", "xhtml"],
            config: config(tree_sitter_html::LANGUAGE.into(), "html", tree_sitter_html::HIGHLIGHTS_QUERY, tree_sitter_html::INJECTIONS_QUERY, "") },
        Lang { name: "css", exts: &["css"],
            config: config(tree_sitter_css::LANGUAGE.into(), "css", tree_sitter_css::HIGHLIGHTS_QUERY, "", "") },
    ]
}

/// Other names a request or an injection may use for a language.
fn alias(name: &str) -> &str {
    match name {
        "js" | "jsx" | "ecmascript" => "javascript",
        "xml" | "svg" => "html",
        "cfc" | "cfm" => "cfml",
        n => n,
    }
}

struct Registry {
    langs: Vec<Lang>,
    by_name: HashMap<&'static str, usize>,
    by_ext: HashMap<&'static str, usize>,
}

impl Registry {
    fn new() -> Self {
        let langs = languages();
        let mut by_name = HashMap::new();
        let mut by_ext = HashMap::new();
        for (i, l) in langs.iter().enumerate() {
            by_name.insert(l.name, i);
            for e in l.exts { by_ext.insert(*e, i); }
        }
        Registry { langs, by_name, by_ext }
    }
    fn named(&self, name: &str) -> Option<&Lang> {
        self.by_name.get(alias(&name.to_ascii_lowercase())).map(|&i| &self.langs[i])
    }
    fn for_path(&self, path: &str) -> Option<&Lang> {
        let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
        self.by_ext.get(ext.as_str()).map(|&i| &self.langs[i])
    }
}

/// The text's spans per line, in UTF-16 units within each line.
fn highlight(reg: &Registry, hl: &mut Highlighter, lang: &Lang, text: &str) -> Result<Vec<Vec<(usize, usize, &'static str)>>, String> {
    let line_count = text.split('\n').count();
    let mut lines: Vec<Vec<(usize, usize, &'static str)>> = vec![Vec::new(); line_count];
    if text.len() > MAX_BYTES { return Ok(lines); }
    let events = hl
        .highlight(&lang.config, text.as_bytes(), None, None, |name| reg.named(name).map(|l| &l.config))
        .map_err(|e| format!("{e:?}"))?;
    let mut stack: Vec<usize> = Vec::new();
    // Where we are: the line, and the UTF-16 column at byte `at`.
    let (mut line, mut col, mut at) = (0usize, 0usize, 0usize);
    for ev in events {
        match ev.map_err(|e| format!("{e:?}"))? {
            HighlightEvent::HighlightStart(h) => stack.push(h.0),
            HighlightEvent::HighlightEnd => { stack.pop(); }
            HighlightEvent::Source { start, end } => {
                debug_assert_eq!(start, at);
                let class = stack.last().map(|&i| NAMES[i]);
                let mut span_start = col;
                for ch in text[start..end].chars() {
                    if ch == '\n' {
                        if let Some(c) = class { if col > span_start { push(&mut lines[line], span_start, col, c); } }
                        line += 1; col = 0; span_start = 0;
                    } else {
                        col += ch.len_utf16();
                    }
                }
                if let Some(c) = class { if col > span_start && line < lines.len() { push(&mut lines[line], span_start, col, c); } }
                at = end;
            }
        }
    }
    Ok(lines)
}

/// Adds a span, joining it to the last one when they touch and share a class.
fn push(spans: &mut Vec<(usize, usize, &'static str)>, s: usize, e: usize, c: &'static str) {
    if let Some(last) = spans.last_mut() {
        if last.1 == s && last.2 == c { last.1 = e; return; }
    }
    spans.push((s, e, c));
}

#[derive(Deserialize)]
struct Request { id: serde_json::Value, lang: Option<String>, path: Option<String>, text: String }

fn answer(reg: &Registry, hl: &mut Highlighter, req: &Request) -> serde_json::Value {
    let lang = req.lang.as_deref().and_then(|n| reg.named(n)).or_else(|| req.path.as_deref().and_then(|p| reg.for_path(p)));
    let Some(lang) = lang else { return json!({ "id": req.id, "lang": null, "lines": [] }) };
    match highlight(reg, hl, lang, &req.text) {
        Ok(lines) => json!({ "id": req.id, "lang": lang.name, "lines": lines.iter().map(|l| l.iter().map(|(s, e, c)| json!([s, e, c])).collect::<Vec<_>>()).collect::<Vec<_>>() }),
        Err(err) => json!({ "id": req.id, "lang": lang.name, "lines": [], "error": err }),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let reg = Registry::new();
    let mut hl = Highlighter::new();
    if args.first().map(String::as_str) == Some("--languages") {
        let list: Vec<_> = reg.langs.iter().map(|l| json!({ "name": l.name, "extensions": l.exts })).collect();
        println!("{}", serde_json::to_string_pretty(&list).unwrap());
        return;
    }
    if args.first().map(String::as_str) == Some("--lang") && args.len() == 3 {
        let mut text = String::new();
        std::fs::File::open(&args[2]).and_then(|mut f| f.read_to_string(&mut text)).expect("can't read the file");
        let req = Request { id: json!(0), lang: Some(args[1].clone()), path: Some(args[2].clone()), text };
        println!("{}", answer(&reg, &mut hl, &req));
        return;
    }
    // Server: one request per line until stdin closes.
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let resp = match serde_json::from_str::<Request>(&line) {
            Ok(req) => answer(&reg, &mut hl, &req),
            Err(e) => json!({ "id": null, "error": format!("bad request: {e}") }),
        };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}
