//! AST → the codeviz IR, with every check that the grammar cannot express.
//!
//! Two classes of finding, and the distinction matters:
//!
//! * **Errors** mean the document cannot be drawn honestly — a connection to a
//!   node that does not exist, an id used twice, a required field missing.
//! * **Warnings** mean it can be drawn but will read badly — a vague payload, a
//!   node nothing connects to, forty-one blocks in one picture.
//!
//! Warnings never block. They exist because the difference between a blueprint
//! that teaches and one that merely renders is almost entirely in this list.

use serde_json::{json, Map, Value};

use crate::ast::*;
use crate::diag::{Diagnostic, Report, Severity, Span};

pub const IR_VERSION: &str = "1.1";

const MAX_ID: usize = 48;
const SOFT_MIN_NODES: usize = 15;
const SOFT_MAX_NODES: usize = 40;
const HARD_MAX_NODES: usize = 60;

/// Words that mean nothing on a connection. If the payload is one of these the
/// author has not actually traced the edge.
const VAGUE: &[&str] = &["data", "info", "stuff", "things", "state", "result", "results", "payload"];

const MARKETING: &[&str] = &[
    "powerful", "seamless", "robust", "cutting-edge", "cutting edge",
    "revolutionary", "state-of-the-art", "state of the art", "best-in-class",
];

pub struct Compiled {
    pub ir: Value,
    pub report: Report,
}

fn check_len(rep: &mut Report, span: Span, what: &str, s: &str, min: usize, max: usize) {
    let n = s.chars().count();
    if n < min {
        rep.push(Diagnostic::error(span, format!("{what} is too short ({n} < {min} characters)")));
    } else if n > max {
        rep.push(Diagnostic::error(span, format!("{what} is too long ({n} > {max} characters)")));
    }
}

fn sentence_count(s: &str) -> usize {
    s.split(['.', '!', '?'])
        .filter(|part| part.split_whitespace().count() >= 3)
        .count()
}

fn details_to_json(details: &[Detail]) -> Value {
    let mut facts = vec![];
    let mut lists = vec![];
    let mut links = vec![];
    let mut env: Vec<String> = vec![];
    for d in details {
        match d {
            Detail::Fact { label, value } => facts.push(json!({ "label": label, "value": value })),
            Detail::List { label, items } => lists.push(json!({ "label": label, "items": items })),
            Detail::Link { label, url } => links.push(json!({ "label": label, "url": url })),
            Detail::Env { vars } => env.extend(vars.iter().cloned()),
        }
    }
    let mut m = Map::new();
    if !facts.is_empty() {
        m.insert("facts".into(), Value::Array(facts));
    }
    if !lists.is_empty() {
        m.insert("lists".into(), Value::Array(lists));
    }
    if !links.is_empty() {
        m.insert("links".into(), Value::Array(links));
    }
    if !env.is_empty() {
        m.insert("env".into(), json!(env));
    }
    Value::Object(m)
}

pub fn compile(doc: &Document, mut report: Report) -> Compiled {
    // ---- meta -----------------------------------------------------------
    let doc_span = doc.meta.span.unwrap_or(Span::line_only(1));
    if doc.meta.repo.is_none() {
        report.push(
            Diagnostic::global(Severity::Error, "the file has no `blueprint` header")
                .with_help("the first declaration must be `blueprint <name>`"),
        );
    }
    for (field, val) in [("title", &doc.meta.title), ("tagline", &doc.meta.tagline)] {
        match val {
            Some(v) => check_len(&mut report, doc_span, field, v, 1, if field == "title" { 60 } else { 160 }),
            None => report.push(Diagnostic::error(doc_span, format!("`{field}` is required"))),
        }
    }
    if let Some(t) = &doc.meta.tagline {
        let lower = t.to_lowercase();
        if MARKETING.iter().any(|m| lower.contains(m)) {
            report.push(
                Diagnostic::warn(doc_span, "the tagline reads like marketing copy")
                    .with_help("say what it does instead"),
            );
        }
    }

    let mut meta = Map::new();
    meta.insert("repo".into(), json!(doc.meta.repo.clone().unwrap_or_default()));
    meta.insert("title".into(), json!(doc.meta.title.clone().unwrap_or_default()));
    meta.insert("tagline".into(), json!(doc.meta.tagline.clone().unwrap_or_default()));
    if let Some(b) = &doc.meta.branch {
        meta.insert("branch".into(), json!(b));
    }
    if let Some(s) = &doc.meta.stamp {
        meta.insert("generated".into(), json!(s));
    }

    // ---- stats ----------------------------------------------------------
    if doc.stats.len() > 6 {
        report.push(Diagnostic::warn(
            doc.stats[6].span,
            format!("{} stats — only the first 6 fit across the top strip", doc.stats.len()),
        ));
    }
    let stats: Vec<Value> = doc
        .stats
        .iter()
        .take(6)
        .map(|s| json!({ "label": s.label, "value": s.value }))
        .collect();

    // ---- groups ---------------------------------------------------------
    let mut seen_group = std::collections::HashSet::new();
    for g in &doc.groups {
        if !seen_group.insert(&g.id) {
            report.push(Diagnostic::error(g.span, format!("group `{}` is declared twice", g.id)));
        }
        check_len(&mut report, g.span, "a group label", &g.label, 1, 40);
    }
    if doc.groups.len() > 8 {
        report.push(Diagnostic::warn(
            doc.groups[8].span,
            format!("{} groups — past about six the sidebar stops being scannable", doc.groups.len()),
        ));
    }
    let groups: Vec<Value> = doc
        .groups
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let mut m = Map::new();
            m.insert("id".into(), json!(g.id));
            m.insert("label".into(), json!(g.label));
            m.insert("order".into(), json!(i + 1));
            if let Some(n) = &g.note {
                m.insert("note".into(), json!(n));
            }
            Value::Object(m)
        })
        .collect();

    // ---- nodes ----------------------------------------------------------
    let mut node_ids = std::collections::HashSet::new();
    let mut nodes = vec![];
    for n in &doc.nodes {
        if !node_ids.insert(n.id.clone()) {
            report.push(Diagnostic::error(n.span, format!("`{}` is declared twice", n.id)));
        }
        check_len(&mut report, n.span, "a label", &n.label, 1, 34);

        match &n.summary {
            Some(s) => check_len(&mut report, n.span, "`is`", s, 1, 90),
            None => report.push(
                Diagnostic::error(n.span, format!("`{}` has no `is` line", n.id))
                    .with_help("one clause saying what it is, under 90 characters"),
            ),
        }
        match &n.detail {
            Some(d) => {
                check_len(&mut report, n.span, "`why`", d, 20, 600);
                if sentence_count(d) < 2 {
                    report.push(Diagnostic::warn(
                        n.span,
                        format!("`{}` has a one-sentence `why` — the hover card wants 2-4", n.id),
                    ));
                }
            }
            None => report.push(
                Diagnostic::error(n.span, format!("`{}` has no `why` line", n.id))
                    .with_help("2-4 sentences, ending with something a reader would not have guessed"),
            ),
        }
        if let Some(w) = n.weight
            && !(0.5..=2.0).contains(&w) {
                report.push(Diagnostic::error(n.span, format!("weight x{w} is outside 0.5 to 2.0")));
            }

        let mut m = Map::new();
        m.insert("id".into(), json!(n.id));
        m.insert("label".into(), json!(n.label));
        m.insert("group".into(), json!(n.group));
        m.insert("kind".into(), json!(n.kind.as_ir()));
        m.insert("summary".into(), json!(n.summary.clone().unwrap_or_default()));
        m.insert("detail".into(), json!(n.detail.clone().unwrap_or_default()));
        if let Some(w) = n.weight {
            m.insert("weight".into(), json!(w));
        }
        if let Some((c, r)) = n.pos {
            m.insert("pos".into(), json!([c, r]));
        }
        if let Some(s) = n.status
            && s != Status::Active {
                m.insert("status".into(), json!(s.as_ir()));
            }
        if !n.paths.is_empty() {
            m.insert("paths".into(), json!(n.paths));
        }
        if !n.tech.is_empty() {
            m.insert("tech".into(), json!(n.tech));
        }
        if !n.metrics.is_empty() {
            m.insert(
                "metrics".into(),
                json!(n.metrics.iter().map(|(l, v)| json!({"label": l, "value": v})).collect::<Vec<_>>()),
            );
        }
        if let Value::Object(d) = details_to_json(&n.details)
            && !d.is_empty() {
                m.insert("details".into(), Value::Object(d));
            }
        nodes.push(Value::Object(m));

        if !seen_group.contains(&n.group) {
            report.push(Diagnostic::error(
                n.span,
                format!("`{}` is in group `{}`, which is never declared", n.id, n.group),
            ));
        }
    }

    if doc.nodes.len() > HARD_MAX_NODES {
        report.push(Diagnostic::global(
            Severity::Error,
            format!("{} blocks — the hard ceiling is {HARD_MAX_NODES}", doc.nodes.len()),
        ));
    } else if doc.nodes.len() < SOFT_MIN_NODES {
        report.push(
            Diagnostic::global(
                Severity::Warning,
                format!("only {} blocks — under {SOFT_MIN_NODES} the drawing looks trivial", doc.nodes.len()),
            )
            .with_help("split a subsystem or two"),
        );
    } else if doc.nodes.len() > SOFT_MAX_NODES {
        report.push(
            Diagnostic::global(
                Severity::Warning,
                format!("{} blocks — past {SOFT_MAX_NODES} the drawing turns to soup", doc.nodes.len()),
            )
            .with_help("collapse leaf modules into their parents"),
        );
    }

    // ---- edges ----------------------------------------------------------
    let mut edge_ids = std::collections::HashSet::new();
    let mut pair_seen = std::collections::HashSet::new();
    let mut touched = std::collections::HashSet::new();
    let mut edges = vec![];

    for e in &doc.edges {
        if !node_ids.contains(&e.from) {
            report.push(Diagnostic::error(
                e.span,
                format!("`{}` is not a declared block", e.from),
            ));
        }
        if !node_ids.contains(&e.to) {
            report.push(Diagnostic::error(
                e.span,
                format!("`{}` is not a declared block", e.to),
            ));
        }
        if e.from == e.to {
            report.push(Diagnostic::error(e.span, "a connection from a block to itself"));
        }
        touched.insert(e.from.clone());
        touched.insert(e.to.clone());

        let key = format!("{}>{}", e.from, e.to);
        if !pair_seen.insert(key.clone()) {
            report.push(
                Diagnostic::warn(e.span, format!("a second connection already runs {key}"))
                    .with_help("consider merging them into one better-described line"),
            );
        }

        // Derive an id when the author did not name one. Truncate to fit the
        // slug limit, then disambiguate on collision.
        let mut id = e.id.clone().unwrap_or_else(|| {
            let d = format!("{}__{}", e.from, e.to);
            d.chars().take(MAX_ID).collect()
        });
        if edge_ids.contains(&id) {
            let mut k = 2;
            loop {
                let suffix = format!("_{k}");
                let base: String = id.chars().take(MAX_ID - suffix.len()).collect();
                let cand = format!("{base}{suffix}");
                if !edge_ids.contains(&cand) {
                    if e.id.is_some() {
                        report.push(Diagnostic::error(
                            e.span,
                            format!("connection id `{id}` is used twice"),
                        ));
                    }
                    id = cand;
                    break;
                }
                k += 1;
            }
        }
        edge_ids.insert(id.clone());

        match &e.label {
            Some(l) => check_len(&mut report, e.span, "a connection label", l, 1, 40),
            None => report.push(
                Diagnostic::error(e.span, "a connection needs a quoted label")
                    .with_help(r#"cli_repl -call-> turn_runner "one REPL line""#),
            ),
        }
        match &e.payload {
            Some(p) => {
                check_len(&mut report, e.span, "`carry`", p, 1, 160);
                if VAGUE.contains(&p.trim().to_lowercase().as_str()) {
                    report.push(
                        Diagnostic::warn(e.span, format!("`carry {p}` names nothing concrete"))
                            .with_help("a type, a function, a table, a route — or delete the line"),
                    );
                }
            }
            None => report.push(
                Diagnostic::error(e.span, "a connection needs a `carry` line")
                    .with_help("name the concrete thing that crosses it, or the line is not real"),
            ),
        }
        match &e.detail {
            Some(d) => check_len(&mut report, e.span, "`why`", d, 20, 400),
            None => report.push(Diagnostic::error(
                e.span,
                "a connection needs a `why` line — when it fires, what it carries, what failure looks like",
            )),
        }
        if let Some(v) = e.volume
            && !(0.0..=1.0).contains(&v) {
                report.push(Diagnostic::error(e.span, format!("vol {v} is outside 0 to 1")));
            }

        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        m.insert("from".into(), json!(e.from));
        m.insert("to".into(), json!(e.to));
        m.insert("kind".into(), json!(e.kind.as_ir()));
        m.insert("label".into(), json!(e.label.clone().unwrap_or_default()));
        m.insert("payload".into(), json!(e.payload.clone().unwrap_or_default()));
        m.insert("detail".into(), json!(e.detail.clone().unwrap_or_default()));
        if let Some(v) = e.volume {
            m.insert("volume".into(), json!(v));
        }
        if e.bidirectional {
            m.insert("bidirectional".into(), json!(true));
        }
        if !e.waypoints.is_empty() {
            m.insert(
                "waypoints".into(),
                json!(e.waypoints.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()),
            );
        }
        edges.push(Value::Object(m));
    }

    for n in &doc.nodes {
        if !touched.contains(&n.id) {
            report.push(
                Diagnostic::warn(n.span, format!("nothing connects to `{}`", n.id))
                    .with_help("wire it up, or drop it"),
            );
        }
    }

    // ---- narrative -------------------------------------------------------
    let terms: std::collections::HashSet<String> =
        doc.terms.iter().map(|t| t.term.to_lowercase()).collect();
    let mut ref_count = 0usize;

    let tabs: Vec<Value> = doc
        .tabs
        .iter()
        .map(|t| {
            let blocks: Vec<Value> = t
                .blocks
                .iter()
                .map(|b| {
                    for (label, id) in find_node_refs(&b.text) {
                        ref_count += 1;
                        if !node_ids.contains(&id) {
                            report.push(Diagnostic::error(
                                b.span,
                                format!("[[…|{id}]] points at a block that does not exist"),
                            ));
                        }
                        if label.trim().is_empty() {
                            report.push(Diagnostic::error(b.span, "a [[…|…]] link has no text"));
                        }
                    }
                    for term in find_terms(&b.text) {
                        if !terms.contains(&term.to_lowercase()) {
                            report.push(
                                Diagnostic::error(b.span, format!("{{{{{term}}}}} has no `term` declaration"))
                                    .with_help(format!(r#"term "{term}" = …"#)),
                            );
                        }
                    }
                    json!({ "type": b.kind.as_ir(), "text": b.text })
                })
                .collect();
            json!({ "id": t.id, "label": t.label, "blocks": blocks })
        })
        .collect();

    if doc.tabs.is_empty() {
        report.push(
            Diagnostic::global(Severity::Error, "the blueprint has no narrative")
                .with_help(r#"add at least one `tab what "What it does"`"#),
        );
    } else if ref_count < 3 {
        report.push(
            Diagnostic::global(
                Severity::Warning,
                format!("only {ref_count} [[…|block]] links in the narrative"),
            )
            .with_help("the panel and the drawing should point at each other"),
        );
    }

    let glossary: Vec<Value> = doc
        .terms
        .iter()
        .map(|t| json!({ "term": t.term, "definition": t.definition }))
        .collect();

    let mut narrative = Map::new();
    narrative.insert("tabs".into(), Value::Array(tabs));
    if !glossary.is_empty() {
        narrative.insert("glossary".into(), Value::Array(glossary));
    }

    let ir = json!({
        "codeviz": IR_VERSION,
        "meta": Value::Object(meta),
        "stats": stats,
        "groups": groups,
        "nodes": nodes,
        "edges": edges,
        "narrative": Value::Object(narrative),
    });

    Compiled { ir, report }
}

/// Extract `[[label|node_id]]` pairs. Hand-rolled rather than regex to keep the
/// crate dependency-free — it is scanned once per block, so speed is moot.
fn find_node_refs(s: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let b = s.as_bytes();
    let mut i = 0;
    while i + 3 < b.len() {
        if b[i] == b'[' && b[i + 1] == b'['
            && let Some(end) = s[i + 2..].find("]]") {
                let inner = &s[i + 2..i + 2 + end];
                if let Some((label, id)) = inner.split_once('|') {
                    out.push((label.to_string(), id.trim().to_string()));
                }
                i += end + 4;
                continue;
            }
        i += 1;
    }
    out
}

/// Extract `{{term}}` occurrences.
fn find_terms(s: &str) -> Vec<String> {
    let mut out = vec![];
    let b = s.as_bytes();
    let mut i = 0;
    while i + 3 < b.len() {
        if b[i] == b'{' && b[i + 1] == b'{'
            && let Some(end) = s[i + 2..].find("}}") {
                out.push(s[i + 2..i + 2 + end].trim().to_string());
                i += end + 4;
                continue;
            }
        i += 1;
    }
    out
}
