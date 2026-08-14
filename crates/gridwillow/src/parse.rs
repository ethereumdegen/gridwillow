//! The parser.
//!
//! Line-oriented and single-pass. There is no separate lexer because there are
//! no multi-line tokens: every construct begins at the start of a line with a
//! keyword, and the only thing that spans lines is a block scalar, which the
//! line loop consumes greedily.
//!
//! Indentation is *decorative* everywhere except inside a block scalar. That is
//! deliberate: the most common way for a generated file to be wrong is
//! inconsistent indentation, and it costs nothing to be immune to it.

use crate::ast::*;
use crate::diag::{Diagnostic, Report, Span};

/// Which declaration the following attribute lines attach to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    None,
    Blueprint,
    Group(usize),
    Node(usize),
    Edge(usize),
    Tab(usize),
}

impl Scope {
    fn describe(self) -> &'static str {
        match self {
            Scope::None => "the top level",
            Scope::Blueprint => "a `blueprint` header",
            Scope::Group(_) => "a `group`",
            Scope::Node(_) => "a node",
            Scope::Edge(_) => "a connection",
            Scope::Tab(_) => "a `tab`",
        }
    }
}

pub struct Parser<'a> {
    lines: Vec<&'a str>,
    i: usize,
    doc: Document,
    scope: Scope,
    current_group: Option<String>,
    pub report: Report,
}

/// Number of leading spaces, counting a tab as four.
fn indent_of(s: &str) -> usize {
    let mut n = 0;
    for c in s.chars() {
        match c {
            ' ' => n += 1,
            '\t' => n += 4,
            _ => break,
        }
    }
    n
}

/// Split `head rest-of-line` into the first word and the trimmed remainder.
fn split_word(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i..].trim()),
        None => (s, ""),
    }
}

/// Read a `"quoted label"` from the front, returning it and what follows.
fn take_quoted(s: &str) -> Option<(String, &str)> {
    let s = s.trim_start();
    let rest = s.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                if let Some((_, n)) = chars.next() {
                    out.push(n);
                }
            }
            '"' => return Some((out, rest[i + 1..].trim_start())),
            _ => out.push(c),
        }
    }
    None
}

fn is_slug(s: &str) -> bool {
    let n = s.chars().count();
    (2..=48).contains(&n)
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn split_eq(s: &str) -> Option<(String, String)> {
    let (a, b) = s.split_once('=')?;
    Some((a.trim().to_string(), b.trim().to_string()))
}

fn split_commas(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

impl<'a> Parser<'a> {
    pub fn new(source: &'a str) -> Self {
        Self {
            lines: source.lines().collect(),
            i: 0,
            doc: Document::default(),
            scope: Scope::None,
            current_group: None,
            report: Report::default(),
        }
    }

    fn err(&mut self, line: usize, col: usize, msg: impl Into<String>) {
        self.report.push(Diagnostic::error(Span::new(line, col), msg));
    }

    fn err_help(&mut self, line: usize, col: usize, msg: impl Into<String>, help: impl Into<String>) {
        self.report.push(Diagnostic::error(Span::new(line, col), msg).with_help(help));
    }

    pub fn parse(mut self) -> (Document, Report) {
        while self.i < self.lines.len() {
            let raw = self.lines[self.i];
            let lineno = self.i + 1;
            self.i += 1;

            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            self.dispatch(raw, trimmed, lineno);
        }
        (self.doc, self.report)
    }

    fn dispatch(&mut self, raw: &'a str, trimmed: &'a str, lineno: usize) {
        let col = indent_of(raw) + 1;
        let (head, rest) = split_word(trimmed);

        // --- declarations -------------------------------------------------
        match head {
            "blueprint" => return self.decl_blueprint(rest, lineno, col),
            "group" => return self.decl_group(rest, lineno, col),
            "tab" => return self.decl_tab(rest, lineno, col),
            "term" => return self.decl_term(rest, lineno, col),
            "stat" => return self.decl_stat(rest, lineno, col),
            _ => {}
        }
        // Connections are tested BEFORE node kinds, and the test is deliberately
        // strict: an arrow, with a bare slug in front of it. Kind words like
        // `api` and `db` are also perfectly good node ids, so `api -call-> x`
        // would otherwise be read as declaring a node of kind `api` named
        // `-call->`. Requiring a slug before the arrow also means a label
        // containing something arrow-shaped cannot be mistaken for a wire.
        if let Some(arrow_at) = find_arrow(trimmed)
            && is_slug(trimmed[..arrow_at.0].trim()) {
                return self.decl_edge(trimmed, arrow_at, lineno, col);
            }
        // A kind word always means a node declaration. No kind word is also an
        // attribute keyword, and inside a tab every line is keyword-prefixed,
        // so there is nothing left to disambiguate. Routing here even when the
        // rest of the line is malformed is deliberate: `decl_node` can then say
        // "`a` is not a valid node id" instead of the caller shrugging with
        // "`svc` is not a keyword".
        if NodeKind::parse(head).is_some() {
            return self.decl_node(head, rest, raw, lineno, col);
        }

        // --- attributes ---------------------------------------------------
        self.attribute(head, rest, raw, lineno, col);
    }

    // ---------------------------------------------------------------- decls

    fn decl_blueprint(&mut self, rest: &str, lineno: usize, col: usize) {
        if self.doc.meta.repo.is_some() {
            self.err(lineno, col, "a second `blueprint` header — there can be only one");
            return;
        }
        let slug = rest.trim();
        if slug.is_empty() {
            self.err_help(lineno, col, "`blueprint` needs a repo name", "blueprint my-service");
            return;
        }
        self.doc.meta.repo = Some(slug.to_string());
        self.doc.meta.span = Some(Span::new(lineno, col));
        self.scope = Scope::Blueprint;
    }

    fn decl_stat(&mut self, rest: &str, lineno: usize, col: usize) {
        match split_eq(rest) {
            Some((label, value)) if !label.is_empty() && !value.is_empty() => {
                self.doc.stats.push(Stat { label, value, span: Span::new(lineno, col) });
            }
            _ => self.err_help(
                lineno,
                col,
                "`stat` needs `label = value`",
                "stat Rust = 28,794 lines · 91 files",
            ),
        }
        // stat does not open a scope; leave the current one alone
    }

    fn decl_group(&mut self, rest: &str, lineno: usize, col: usize) {
        let (id, after) = split_word(rest);
        if !is_slug(id) {
            self.err_help(
                lineno,
                col,
                format!("`{id}` is not a valid group id"),
                "lower_snake_case, 2-48 characters, starting with a letter",
            );
            return;
        }
        let Some((label, _)) = take_quoted(after) else {
            self.err_help(
                lineno,
                col,
                "a group needs a quoted label",
                r#"group ways_in "Ways in""#,
            );
            return;
        };
        self.doc.groups.push(Group {
            id: id.to_string(),
            label,
            note: None,
            span: Span::new(lineno, col),
        });
        self.current_group = Some(id.to_string());
        self.scope = Scope::Group(self.doc.groups.len() - 1);
    }

    fn decl_node(&mut self, kindword: &str, rest: &str, _raw: &str, lineno: usize, col: usize) {
        let kind = NodeKind::parse(kindword).expect("checked by caller");
        let (id, after) = split_word(rest);
        if !is_slug(id) {
            self.err_help(
                lineno,
                col,
                format!("`{id}` is not a valid node id"),
                "lower_snake_case, 2-48 characters, starting with a letter",
            );
            return;
        }
        let Some((label, mods)) = take_quoted(after) else {
            self.err_help(
                lineno,
                col,
                format!("`{id}` needs a quoted label"),
                format!(r#"{kindword} {id} "Human Name""#),
            );
            return;
        };
        let Some(group) = self.current_group.clone() else {
            self.err_help(
                lineno,
                col,
                format!("`{id}` is not inside a group"),
                "declare a `group` before the nodes that belong to it",
            );
            return;
        };

        let mut node = Node {
            id: id.to_string(),
            label,
            kind,
            group,
            weight: None,
            pos: None,
            status: None,
            summary: None,
            detail: None,
            paths: vec![],
            tech: vec![],
            metrics: vec![],
            details: vec![],
            span: Span::new(lineno, col),
        };

        for m in mods.split_whitespace() {
            if let Some(w) = m.strip_prefix('x') {
                match w.parse::<f64>() {
                    Ok(v) => node.weight = Some(v),
                    Err(_) => self.err(lineno, col, format!("`{m}` is not a weight like x1.4")),
                }
            } else if let Some(p) = m.strip_prefix('@') {
                match parse_pair(p) {
                    Some(v) => node.pos = Some(v),
                    None => self.err(lineno, col, format!("`{m}` is not a position like @4,-2")),
                }
            } else if let Some(s) = m.strip_prefix('!') {
                match Status::parse(s) {
                    Some(v) => node.status = Some(v),
                    None => self.err_help(
                        lineno,
                        col,
                        format!("`{s}` is not a status"),
                        "!dormant or !planned (active is the default)",
                    ),
                }
            } else {
                self.err_help(
                    lineno,
                    col,
                    format!("unexpected `{m}` after the label"),
                    "modifiers are x<weight>, @<col>,<row> and !<status>",
                );
            }
        }

        self.doc.nodes.push(node);
        self.scope = Scope::Node(self.doc.nodes.len() - 1);
    }

    fn decl_edge(&mut self, trimmed: &'a str, arrow_at: (usize, usize), lineno: usize, col: usize) {
        let (start, end) = arrow_at;
        let from = trimmed[..start].trim();
        let arrow = &trimmed[start..end];
        let after = trimmed[end..].trim();

        let bidirectional = arrow.starts_with('<');
        let kindword = arrow.trim_start_matches('<').trim_start_matches('-').trim_end_matches("->");
        let Some(kind) = EdgeKind::parse(kindword) else {
            self.err_help(
                lineno,
                col,
                format!("`{kindword}` is not a connection kind"),
                format!("one of: {}", EdgeKind::ALL),
            );
            return;
        };

        let (to, after_to) = split_word(after);
        if !is_slug(from) || !is_slug(to) {
            self.err_help(
                lineno,
                col,
                "a connection needs two node ids",
                r#"cli_repl -call-> turn_runner "one REPL line""#,
            );
            return;
        }
        let label = take_quoted(after_to).map(|(l, _)| l);

        self.doc.edges.push(Edge {
            id: None,
            from: from.to_string(),
            to: to.to_string(),
            kind,
            bidirectional,
            label,
            payload: None,
            detail: None,
            volume: None,
            waypoints: vec![],
            span: Span::new(lineno, col),
        });
        self.scope = Scope::Edge(self.doc.edges.len() - 1);
    }

    fn decl_tab(&mut self, rest: &str, lineno: usize, col: usize) {
        let (id, after) = split_word(rest);
        if !is_slug(id) {
            self.err(lineno, col, format!("`{id}` is not a valid tab id"));
            return;
        }
        let Some((label, _)) = take_quoted(after) else {
            self.err_help(lineno, col, "a tab needs a quoted label", r#"tab what "What it does""#);
            return;
        };
        self.doc.tabs.push(Tab {
            id: id.to_string(),
            label,
            blocks: vec![],
            span: Span::new(lineno, col),
        });
        self.scope = Scope::Tab(self.doc.tabs.len() - 1);
    }

    fn decl_term(&mut self, rest: &str, lineno: usize, col: usize) {
        let Some((term, after)) = take_quoted(rest) else {
            self.err_help(
                lineno,
                col,
                "a glossary term must be quoted",
                r#"term "persona" = a scoped set of tools"#,
            );
            return;
        };
        let definition = if let Some(v) = after.strip_prefix('=') {
            self.value(v.trim(), lineno)
        } else if after == ">" || after == "|" {
            self.block(after == "|", lineno)
        } else {
            self.err_help(lineno, col, "a glossary term needs a definition", "term \"x\" = …");
            return;
        };
        self.doc.terms.push(Term { term, definition, span: Span::new(lineno, col) });
        // does not open a scope
    }

    // ----------------------------------------------------------- attributes

    fn attribute(&mut self, head: &str, rest: &str, raw: &str, lineno: usize, col: usize) {
        // A tab rule is the one attribute with no value.
        if head == "---" {
            if let Scope::Tab(t) = self.scope {
                self.doc.tabs[t].blocks.push(TextBlock {
                    kind: BlockKind::Rule,
                    text: String::new(),
                    span: Span::new(lineno, col),
                });
            } else {
                self.err(lineno, col, "`---` only means anything inside a `tab`");
            }
            return;
        }

        let known = matches!(
            head,
            "title" | "tagline" | "branch" | "stamp" | "note" | "is" | "why" | "src" | "uses"
                | "num" | "fact" | "list" | "link" | "env" | "as" | "carry" | "vol" | "via"
                | "h" | "p" | "code"
        );
        if !known {
            self.err_help(
                lineno,
                col,
                format!("`{head}` is not a keyword"),
                format!(
                    "node kinds: {} (aliases: {}) — or did you mean an attribute?",
                    NodeKind::ALL_SHORT,
                    NodeKind::COMMON_ALIASES
                ),
            );
            return;
        }

        let scope = self.scope;
        match scope {
            Scope::Blueprint => self.attr_blueprint(head, rest, lineno, col),
            Scope::Group(g) => self.attr_group(g, head, rest, lineno, col),
            Scope::Node(n) => self.attr_node(n, head, rest, lineno, col),
            Scope::Edge(e) => self.attr_edge(e, head, rest, lineno, col),
            Scope::Tab(t) => self.attr_tab(t, head, rest, raw, lineno, col),
            Scope::None => self.err_help(
                lineno,
                col,
                format!("`{head}` appears before any declaration"),
                "start the file with a `blueprint` header",
            ),
        }
    }

    fn wrong_scope(&mut self, head: &str, lineno: usize, col: usize, valid_in: &str) {
        let here = self.scope.describe();
        self.err_help(
            lineno,
            col,
            format!("`{head}` is not valid inside {here}"),
            format!("`{head}` belongs to {valid_in}"),
        );
    }

    fn attr_blueprint(&mut self, head: &str, rest: &str, lineno: usize, col: usize) {
        let v = self.value(rest, lineno);
        match head {
            "title" => self.doc.meta.title = Some(v),
            "tagline" => self.doc.meta.tagline = Some(v),
            "branch" => self.doc.meta.branch = Some(v),
            "stamp" => self.doc.meta.stamp = Some(v),
            _ => self.wrong_scope(head, lineno, col, "a node, a connection, or a tab"),
        }
    }

    fn attr_group(&mut self, g: usize, head: &str, rest: &str, lineno: usize, col: usize) {
        match head {
            "note" => {
                let v = self.value(rest, lineno);
                self.doc.groups[g].note = Some(v);
            }
            _ => self.wrong_scope(head, lineno, col, "a node or a connection"),
        }
    }

    fn attr_node(&mut self, n: usize, head: &str, rest: &str, lineno: usize, col: usize) {
        match head {
            "is" => {
                let v = self.value(rest, lineno);
                self.doc.nodes[n].summary = Some(v);
            }
            "why" => {
                let v = self.value(rest, lineno);
                self.doc.nodes[n].detail = Some(v);
            }
            "src" => self.doc.nodes[n]
                .paths
                .extend(rest.split_whitespace().map(str::to_string)),
            "uses" => self.doc.nodes[n]
                .tech
                .extend(rest.split_whitespace().map(str::to_string)),
            "num" | "fact" => match split_eq(rest) {
                Some((label, value)) if !label.is_empty() && !value.is_empty() => {
                    // `num` is the headline number on the hover card; `fact` is
                    // an inspector row. Same syntax, different destination.
                    if head == "num" {
                        self.doc.nodes[n].metrics.push((label, value));
                    } else {
                        self.doc.nodes[n].details.push(Detail::Fact { label, value });
                    }
                }
                _ => self.err_help(
                    lineno,
                    col,
                    format!("`{head}` needs `label = value`"),
                    "fact Engine = Postgres 16",
                ),
            },
            "list" => match split_eq(rest) {
                Some((label, items)) if !label.is_empty() && !items.is_empty() => {
                    self.doc.nodes[n]
                        .details
                        .push(Detail::List { label, items: split_commas(&items) });
                }
                _ => self.err_help(
                    lineno,
                    col,
                    "`list` needs `label = a, b, c`",
                    "list Tables = orders, order_items, refunds",
                ),
            },
            "link" => match split_eq(rest) {
                Some((label, url)) if !label.is_empty() && !url.is_empty() => {
                    self.doc.nodes[n].details.push(Detail::Link { label, url });
                }
                _ => self.err_help(
                    lineno,
                    col,
                    "`link` needs `label = url`",
                    "link Runbook = https://wiki/runbooks/orders",
                ),
            },
            "env" => {
                let vars: Vec<String> = rest.split_whitespace().map(str::to_string).collect();
                if vars.is_empty() {
                    self.err_help(lineno, col, "`env` needs at least one name", "env DATABASE_URL");
                } else {
                    self.doc.nodes[n].details.push(Detail::Env { vars });
                }
            }
            _ => self.wrong_scope(head, lineno, col, "a connection or a tab"),
        }
    }

    fn attr_edge(&mut self, e: usize, head: &str, rest: &str, lineno: usize, col: usize) {
        match head {
            "as" => {
                let id = rest.trim();
                if is_slug(id) {
                    self.doc.edges[e].id = Some(id.to_string());
                } else {
                    self.err(lineno, col, format!("`{id}` is not a valid connection id"));
                }
            }
            "carry" => {
                let v = self.value(rest, lineno);
                self.doc.edges[e].payload = Some(v);
            }
            "why" => {
                let v = self.value(rest, lineno);
                self.doc.edges[e].detail = Some(v);
            }
            "vol" => match rest.trim().parse::<f64>() {
                Ok(v) => self.doc.edges[e].volume = Some(v),
                Err(_) => {
                    self.err_help(lineno, col, "`vol` needs a number", "vol 0.9 — 0 is idle, 1 is hot")
                }
            },
            "via" => {
                let mut pts = vec![];
                let mut bad = None;
                for p in rest.split_whitespace() {
                    match parse_pair(p) {
                        Some(v) => pts.push(v),
                        None => bad = Some(p.to_string()),
                    }
                }
                match bad {
                    Some(b) => self.err_help(
                        lineno,
                        col,
                        format!("`{b}` is not a waypoint"),
                        "via 4,-2 6,-2",
                    ),
                    None => self.doc.edges[e].waypoints.extend(pts),
                }
            }
            _ => self.wrong_scope(head, lineno, col, "a node or a tab"),
        }
    }

    fn attr_tab(&mut self, t: usize, head: &str, rest: &str, _raw: &str, lineno: usize, col: usize) {
        let kind = match head {
            "h" => BlockKind::Heading,
            "p" => BlockKind::Paragraph,
            "note" => BlockKind::Note,
            "code" => BlockKind::Code,
            _ => return self.wrong_scope(head, lineno, col, "a node or a connection"),
        };
        // `code` defaults to a literal block so indentation survives
        let text = if kind == BlockKind::Code && (rest == "|" || rest == ">") {
            self.block(rest == "|", lineno)
        } else {
            self.value(rest, lineno)
        };
        self.doc.tabs[t].blocks.push(TextBlock { kind, text, span: Span::new(lineno, col) });
    }

    // --------------------------------------------------------------- values

    /// An attribute value: either the rest of the line, or a block scalar if
    /// the line is exactly `>` (folded) or `|` (literal).
    fn value(&mut self, rest: &str, opener_line: usize) -> String {
        match rest.trim() {
            ">" => self.block(false, opener_line),
            "|" => self.block(true, opener_line),
            other => other.to_string(),
        }
    }

    /// Consume every following line indented strictly more than the opening
    /// line, strip the common indent, and join.
    ///
    /// Folded: lines join with a space, a blank line becomes a paragraph break.
    /// Literal: lines are preserved verbatim.
    fn block(&mut self, literal: bool, opener_line: usize) -> String {
        let base = indent_of(self.lines[opener_line - 1]);
        let mut raw: Vec<&str> = vec![];

        while self.i < self.lines.len() {
            let line = self.lines[self.i];
            if line.trim().is_empty() {
                // A blank line only ends the block if what follows is dedented.
                let next = self.lines[self.i + 1..]
                    .iter()
                    .find(|l| !l.trim().is_empty());
                match next {
                    Some(n) if indent_of(n) > base => {
                        raw.push("");
                        self.i += 1;
                        continue;
                    }
                    _ => break,
                }
            }
            if indent_of(line) <= base {
                break;
            }
            raw.push(line);
            self.i += 1;
        }

        let strip = raw
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| indent_of(l))
            .min()
            .unwrap_or(0);

        let dedented: Vec<String> = raw
            .iter()
            .map(|l| {
                if l.trim().is_empty() {
                    String::new()
                } else {
                    let mut cut = 0;
                    let mut seen = 0;
                    for c in l.chars() {
                        if seen >= strip {
                            break;
                        }
                        seen += if c == '\t' { 4 } else { 1 };
                        cut += c.len_utf8();
                    }
                    l[cut..].to_string()
                }
            })
            .collect();

        if literal {
            let mut s = dedented.join("\n");
            while s.ends_with('\n') {
                s.pop();
            }
            s
        } else {
            let mut out = String::new();
            for line in dedented {
                if line.trim().is_empty() {
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                } else {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push(' ');
                    }
                    out.push_str(line.trim());
                }
            }
            out
        }
    }
}

fn parse_pair(s: &str) -> Option<(i64, i64)> {
    let (a, b) = s.split_once(',')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Find `-kind->` or `<-kind->` in a line, returning its byte range.
///
/// Searched rather than matched at a fixed offset because the source id is
/// variable length, and because finding it is what distinguishes a connection
/// line from an attribute line in the first place.
fn find_arrow(s: &str) -> Option<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' && (i == 0 || bytes[i - 1] != b'-') {
            // scan a run of lowercase letters, then expect "->"
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_lowercase() {
                j += 1;
            }
            if j > i + 1 && s[j..].starts_with("->") {
                let start = if i > 0 && bytes[i - 1] == b'<' { i - 1 } else { i };
                return Some((start, j + 2));
            }
        }
        i += 1;
    }
    None
}

pub fn parse(source: &str) -> (Document, Report) {
    Parser::new(source).parse()
}
