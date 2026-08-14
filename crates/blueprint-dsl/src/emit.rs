//! The formatter: AST back to canonical `.bp` text.
//!
//! Used by `bp fmt`, and by the Tauri app when it writes a dragged block's new
//! position back into the source. Because it emits from the AST rather than
//! from the IR, it never invents a field the author did not write — a node with
//! no `uses` line comes back with no `uses` line.

use crate::ast::*;

const WIDTH: usize = 78;

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn number(v: f64) -> String {
    let s = format!("{v}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Emit `key value` on one line if it fits, otherwise as a folded block.
fn prose(out: &mut Vec<String>, indent: &str, key: &str, text: &str) {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = format!("{indent}{key} {flat}");
    if one.chars().count() <= WIDTH && !flat.contains('\n') {
        out.push(one);
        return;
    }
    out.push(format!("{indent}{key} >"));
    let avail = WIDTH.saturating_sub(indent.len() + 2).max(24);
    let mut line = String::new();
    for word in flat.split(' ') {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > avail {
            out.push(format!("{indent}  {line}"));
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        out.push(format!("{indent}  {line}"));
    }
}

pub fn emit(doc: &Document) -> String {
    let mut out: Vec<String> = vec![];

    out.push(format!("blueprint {}", doc.meta.repo.clone().unwrap_or_default()));
    if let Some(v) = &doc.meta.title {
        prose(&mut out, "  ", "title", v);
    }
    if let Some(v) = &doc.meta.tagline {
        prose(&mut out, "  ", "tagline", v);
    }
    if let Some(v) = &doc.meta.branch {
        out.push(format!("  branch {v}"));
    }
    if let Some(v) = &doc.meta.stamp {
        out.push(format!("  stamp {v}"));
    }
    out.push(String::new());

    for s in &doc.stats {
        out.push(format!("stat {} = {}", s.label, s.value));
    }
    if !doc.stats.is_empty() {
        out.push(String::new());
    }

    for g in &doc.groups {
        out.push(format!("group {} {}", g.id, quote(&g.label)));
        if let Some(n) = &g.note {
            out.push(format!("  note {n}"));
        }
        out.push(String::new());

        for n in doc.nodes.iter().filter(|n| n.group == g.id) {
            let mut head = format!("{} {} {}", n.kind.as_short(), n.id, quote(&n.label));
            if let Some(w) = n.weight {
                head.push_str(&format!(" x{}", number(w)));
            }
            if let Some((c, r)) = n.pos {
                head.push_str(&format!(" @{c},{r}"));
            }
            if let Some(s) = n.status
                && s != Status::Active {
                    head.push_str(&format!(" !{}", s.as_ir()));
                }
            out.push(head);

            if let Some(v) = &n.summary {
                prose(&mut out, "  ", "is", v);
            }
            if let Some(v) = &n.detail {
                prose(&mut out, "  ", "why", v);
            }
            if !n.paths.is_empty() {
                out.push(format!("  src {}", n.paths.join(" ")));
            }
            if !n.tech.is_empty() {
                out.push(format!("  uses {}", n.tech.join(" ")));
            }
            for (l, v) in &n.metrics {
                out.push(format!("  num {l} = {v}"));
            }
            for d in &n.details {
                match d {
                    Detail::Fact { label, value } => out.push(format!("  fact {label} = {value}")),
                    Detail::List { label, items } => {
                        out.push(format!("  list {label} = {}", items.join(", ")))
                    }
                    Detail::Link { label, url } => out.push(format!("  link {label} = {url}")),
                    Detail::Env { vars } => out.push(format!("  env {}", vars.join(" "))),
                }
            }
            out.push(String::new());
        }
    }

    if !doc.edges.is_empty() {
        out.push(format!("# {}", "-".repeat(70)));
        out.push("# connections".into());
        out.push(format!("# {}", "-".repeat(70)));
        out.push(String::new());
    }

    for e in &doc.edges {
        let arrow = format!(
            "{}-{}->",
            if e.bidirectional { "<" } else { "" },
            e.kind.as_ir()
        );
        let label = e.label.as_ref().map(|l| format!(" {}", quote(l))).unwrap_or_default();
        out.push(format!("{} {arrow} {}{label}", e.from, e.to));
        if let Some(id) = &e.id {
            out.push(format!("  as {id}"));
        }
        if let Some(v) = &e.payload {
            prose(&mut out, "  ", "carry", v);
        }
        if let Some(v) = &e.detail {
            prose(&mut out, "  ", "why", v);
        }
        if let Some(v) = e.volume {
            out.push(format!("  vol {}", number(v)));
        }
        if !e.waypoints.is_empty() {
            let pts: Vec<String> = e.waypoints.iter().map(|(a, b)| format!("{a},{b}")).collect();
            out.push(format!("  via {}", pts.join(" ")));
        }
        out.push(String::new());
    }

    if !doc.tabs.is_empty() {
        out.push(format!("# {}", "-".repeat(70)));
        out.push("# narrative".into());
        out.push(format!("# {}", "-".repeat(70)));
        out.push(String::new());
    }

    for t in &doc.tabs {
        out.push(format!("tab {} {}", t.id, quote(&t.label)));
        out.push(String::new());
        for b in &t.blocks {
            match b.kind {
                BlockKind::Rule => out.push("  ---".into()),
                BlockKind::Code => {
                    out.push("  code |".into());
                    for line in b.text.lines() {
                        out.push(format!("    {line}"));
                    }
                }
                k => prose(&mut out, "  ", k.as_ir(), &b.text),
            }
            out.push(String::new());
        }
    }

    for t in &doc.terms {
        let one = format!("term {} = {}", quote(&t.term), t.definition);
        if one.chars().count() <= WIDTH {
            out.push(one);
        } else {
            out.push(format!("term {} >", quote(&t.term)));
            let mut line = String::new();
            for word in t.definition.split_whitespace() {
                if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > WIDTH - 4 {
                    out.push(format!("  {line}"));
                    line.clear();
                }
                if !line.is_empty() {
                    line.push(' ');
                }
                line.push_str(word);
            }
            if !line.is_empty() {
                out.push(format!("  {line}"));
            }
        }
        out.push(String::new());
    }

    // collapse runs of blank lines, and end with exactly one newline
    let mut text = String::new();
    let mut blank = false;
    for line in out {
        if line.is_empty() {
            if blank {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        text.push_str(&line);
        text.push('\n');
    }
    format!("{}\n", text.trim_end())
}
