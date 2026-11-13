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
//! unknown language answers `"lang": null` and no lines. Instead of "text" a request may name a
//! "file" or a git blob ({"git": {"cwd", "rev", "path"}}); "tab": 4 counts a tab as 4 columns.
//! `--requests <file>` reads the requests from a file (Herdr's exec has no stdin);
//! `--lang <name> <file>` highlights one file; `--languages` lists the languages.

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
    // Markdown's names, old and new style.
    "text.title", "text.emphasis", "text.strong", "text.literal", "text.uri", "text.reference",
    "markup.heading", "markup.italic", "markup.bold", "markup.raw", "markup.link", "markup.list", "markup.quote",
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
        Lang { name: "css", exts: &["css", "scss", "less"],
            config: config(tree_sitter_css::LANGUAGE.into(), "css", tree_sitter_css::HIGHLIGHTS_QUERY, "", "") },
        // TypeScript's queries add to JavaScript's, as editors combine them.
        Lang { name: "typescript", exts: &["ts", "mts", "cts"],
            config: config(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript",
                &format!("{}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY), "",
                &format!("{}\n{}", tree_sitter_typescript::LOCALS_QUERY, tree_sitter_javascript::LOCALS_QUERY)) },
        Lang { name: "tsx", exts: &["tsx"],
            config: config(tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx",
                &format!("{}\n{}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY, tree_sitter_javascript::JSX_HIGHLIGHT_QUERY), "",
                &format!("{}\n{}", tree_sitter_typescript::LOCALS_QUERY, tree_sitter_javascript::LOCALS_QUERY)) },
        Lang { name: "json", exts: &["json", "jsonc", "json5", "code-workspace"],
            config: config(tree_sitter_json::LANGUAGE.into(), "json", tree_sitter_json::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "python", exts: &["py", "pyi", "pyw"],
            config: config(tree_sitter_python::LANGUAGE.into(), "python", tree_sitter_python::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "java", exts: &["java"],
            config: config(tree_sitter_java::LANGUAGE.into(), "java", tree_sitter_java::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "c_sharp", exts: &["cs", "csx"],
            config: config(tree_sitter_c_sharp::LANGUAGE.into(), "c_sharp", tree_sitter_c_sharp::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "go", exts: &["go"],
            config: config(tree_sitter_go::LANGUAGE.into(), "go", tree_sitter_go::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "rust", exts: &["rs"],
            config: config(tree_sitter_rust::LANGUAGE.into(), "rust", tree_sitter_rust::HIGHLIGHTS_QUERY, tree_sitter_rust::INJECTIONS_QUERY, "") },
        Lang { name: "php", exts: &["php", "phtml", "php5", "php7", "phps"],
            config: config(tree_sitter_php::LANGUAGE_PHP.into(), "php", tree_sitter_php::HIGHLIGHTS_QUERY, tree_sitter_php::INJECTIONS_QUERY, "") },
        Lang { name: "ruby", exts: &["rb", "rake", "gemspec", "ru"],
            config: config(tree_sitter_ruby::LANGUAGE.into(), "ruby", tree_sitter_ruby::HIGHLIGHTS_QUERY, "", tree_sitter_ruby::LOCALS_QUERY) },
        Lang { name: "yaml", exts: &["yaml", "yml"],
            config: config(tree_sitter_yaml::LANGUAGE.into(), "yaml", tree_sitter_yaml::HIGHLIGHTS_QUERY, "", "") },
        Lang { name: "bash", exts: &["sh", "bash", "zsh", "ksh", "bats", "envrc"],
            config: config(tree_sitter_bash::LANGUAGE.into(), "bash", tree_sitter_bash::HIGHLIGHT_QUERY, "", "") },
        Lang { name: "markdown", exts: &["md", "markdown", "mdx"],
            config: config(tree_sitter_md::LANGUAGE.into(), "markdown", tree_sitter_md::HIGHLIGHT_QUERY_BLOCK,
                // Inline text goes to the inline grammar, as editors set it up.
                &format!("{}\n((inline) @injection.content (#set! injection.language \"markdown_inline\"))", tree_sitter_md::INJECTION_QUERY_BLOCK), "") },
        Lang { name: "markdown_inline", exts: &[],
            config: config(tree_sitter_md::INLINE_LANGUAGE.into(), "markdown_inline", tree_sitter_md::HIGHLIGHT_QUERY_INLINE, tree_sitter_md::INJECTION_QUERY_INLINE, "") },
        Lang { name: "sql", exts: &["sql", "ddl", "dml", "prs"],
            config: config(tree_sitter_sequel::LANGUAGE.into(), "sql", tree_sitter_sequel::HIGHLIGHTS_QUERY, "", "") },
    ]
}

/// Other names a request or an injection may use for a language.
fn alias(name: &str) -> &str {
    match name {
        "js" | "jsx" | "ecmascript" | "node" => "javascript",
        "ts" => "typescript",
        "py" | "python3" => "python",
        "cs" | "csharp" | "c#" => "c_sharp",
        "rb" => "ruby",
        "sh" | "shell" | "zsh" => "bash",
        "md" => "markdown",
        "yml" => "yaml",
        "jsonc" => "json",
        "postgres" | "postgresql" | "mysql" | "tsql" | "sqlite" => "sql",
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
        let named = match file { "Dockerfile" | "Makefile" => None, ".bashrc" | ".zshrc" | ".profile" | ".bash_profile" => Some("bash"), _ => None };
        if let Some(n) = named { return self.named(n); }
        let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
        self.by_ext.get(ext.as_str()).map(|&i| &self.langs[i])
    }
}

/// The text's spans per line, in UTF-16 units within each line.
fn highlight(reg: &Registry, hl: &mut Highlighter, lang: &Lang, text: &str, tab: usize) -> Result<Vec<Vec<(usize, usize, &'static str)>>, String> {
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
                    } else if ch == '\t' && tab > 0 {
                        col += tab;
                    } else if ch != '\r' {
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

/// A request: the text itself, or a file to read, or a blob of a git repository (`rev` "" or
/// absent: the work tree's file). `tab`: columns a tab counts as (0: as one character), to
/// match a view that shows tabs as spaces.
#[derive(Deserialize)]
struct Request {
    id: serde_json::Value,
    lang: Option<String>,
    path: Option<String>,
    text: Option<String>,
    file: Option<String>,
    git: Option<GitBlob>,
    #[serde(default)]
    tab: usize,
}
#[derive(Deserialize)]
struct GitBlob { cwd: String, rev: Option<String>, path: String }

fn source(req: &Request) -> Result<String, String> {
    if let Some(t) = &req.text { return Ok(t.clone()); }
    if let Some(f) = &req.file { return std::fs::read(f).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| format!("{f}: {e}")); }
    if let Some(g) = &req.git {
        let spec = match g.rev.as_deref() { Some(r) if !r.is_empty() => format!("{r}:{}", g.path), _ => format!(":{}", g.path) };
        let out = std::process::Command::new("git").args(["-C", &g.cwd, "show", &spec]).output().map_err(|e| format!("git: {e}"))?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        if out.stdout.len() > MAX_BYTES { return Err("too large".into()); }
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err("no text, file or git".into())
}

fn answer(reg: &Registry, hl: &mut Highlighter, req: &Request) -> serde_json::Value {
    let lang = req.lang.as_deref().and_then(|n| reg.named(n)).or_else(|| req.path.as_deref().and_then(|p| reg.for_path(p)));
    let Some(lang) = lang else { return json!({ "id": req.id, "lang": null, "lines": [] }) };
    let text = match source(req) { Ok(t) => t, Err(err) => return json!({ "id": req.id, "lang": lang.name, "lines": [], "error": err }) };
    match highlight(reg, hl, lang, &text, req.tab) {
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
        let req = Request { id: json!(0), lang: Some(args[1].clone()), path: Some(args[2].clone()), text: Some(text), file: None, git: None, tab: 0 };
        println!("{}", answer(&reg, &mut hl, &req));
        return;
    }
    // Requests from a file (`--requests <file>`), else from stdin until it closes; one per line.
    let input: Box<dyn BufRead> = if args.first().map(String::as_str) == Some("--requests") && args.len() == 2 {
        Box::new(io::BufReader::new(std::fs::File::open(&args[1]).expect("can't read the requests")))
    } else {
        Box::new(io::BufReader::new(io::stdin()))
    };
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in input.lines() {
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
