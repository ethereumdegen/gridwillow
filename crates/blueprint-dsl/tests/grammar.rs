//! Grammar and compiler behaviour, pinned.
//!
//! Every test here is either a rule from the spec or a bug that got through
//! once. The bug ones are named for what broke.

use blueprint_dsl::{build_lossy, parse};

/// A minimal document that compiles clean, so tests can add one thing to it.
fn base(extra: &str) -> String {
    format!(
        "blueprint demo\n\
         \x20 title A Demo\n\
         \x20 tagline it demonstrates one thing at a time\n\
         \n\
         group core \"Core\"\n\
         \n\
         svc alpha \"Alpha\"\n\
         \x20 is the first thing\n\
         \x20 why It does the first job. It does it twice on Tuesdays.\n\
         \n\
         svc beta \"Beta\"\n\
         \x20 is the second thing\n\
         \x20 why It does the second job. Nothing else does that job.\n\
         \n\
         alpha -call-> beta \"work\"\n\
         \x20 carry do_the_thing(Request) -> Response\n\
         \x20 why Fires once per request. A failure here is retried twice.\n\
         \n\
         tab what \"What\"\n\
         \x20 p See [[alpha|alpha]] and [[beta|beta]] and [[both|alpha]].\n\
         {extra}"
    )
}

fn errors(src: &str) -> Vec<String> {
    build_lossy(src).report.errors().map(|d| d.message.clone()).collect()
}

fn warnings(src: &str) -> Vec<String> {
    build_lossy(src).report.warnings().map(|d| d.message.clone()).collect()
}

#[test]
fn a_minimal_document_compiles_without_errors() {
    let out = build_lossy(&base(""));
    assert!(!out.report.has_errors(), "{:?}", errors(&base("")));
    assert_eq!(out.ir["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(out.ir["edges"].as_array().unwrap().len(), 1);
}

// --- the arrow-vs-kind collision -----------------------------------------
//
// `api`, `db`, `server` and friends are node-kind aliases AND perfectly good
// node ids. Before the fix, `api -call-> other` parsed as a declaration of a
// node of kind `api` named `-call->`.

#[test]
fn a_node_id_that_is_also_a_kind_word_still_wires_up() {
    let src = "blueprint demo\n  title T\n  tagline t\n\
               group svc_group \"G\"\n\
               svc api \"API\"\n  is a\n  why It serves. It also listens.\n\
               db store \"DB\"\n  is b\n  why It stores. It also indexes.\n\
               api -write-> store \"rows\"\n  carry INSERT INTO orders\n  why On every order. A failure rolls back.\n\
               tab main \"T\"\n  p x\n";
    let out = build_lossy(src);
    assert!(!out.report.has_errors(), "{:?}", errors(src));
    let edges = out.ir["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0]["from"], "api");
    assert_eq!(edges[0]["to"], "store");
    assert_eq!(edges[0]["kind"], "write");
}

#[test]
fn an_arrow_shaped_label_is_not_a_connection() {
    let src = base("svc gamma \"maps a-call->b\"\n  is c\n  why It maps. It also folds.\n");
    let out = build_lossy(&src);
    assert_eq!(out.ir["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(out.ir["edges"].as_array().unwrap().len(), 1);
}

// --- scoping --------------------------------------------------------------

#[test]
fn group_scopes_the_nodes_that_follow_it() {
    let src = "blueprint d\n  title T\n  tagline t\n\
               group one \"One\"\n\
               svc aa \"A\"\n  is x\n  why It does. It also does.\n\
               group two \"Two\"\n\
               svc bb \"B\"\n  is y\n  why It does. It also does.\n\
               aa -data-> bb \"v\"\n  carry Thing\n  why Always. Never fails.\n\
               tab main \"T\"\n  p x\n";
    let out = build_lossy(src);
    let nodes = out.ir["nodes"].as_array().unwrap();
    assert_eq!(nodes[0]["group"], "one");
    assert_eq!(nodes[1]["group"], "two");
}

#[test]
fn an_attribute_in_the_wrong_scope_is_a_precise_error() {
    let e = errors(&base("svc gamma \"G\"\n  is x\n  why It does. It also does.\n  carry nope\n"));
    assert!(e.iter().any(|m| m.contains("`carry` is not valid inside a node")), "{e:?}");
}

#[test]
fn a_node_declared_before_any_group_is_an_error() {
    let e = errors("blueprint d\n  title T\n  tagline t\nsvc aa \"A\"\n  is x\n  why y z\n");
    assert!(e.iter().any(|m| m.contains("not inside a group")), "{e:?}");
}

// --- indentation ----------------------------------------------------------

#[test]
fn indentation_outside_a_block_carries_no_meaning() {
    let flat = base("").replace("\n  ", "\n");
    let deep = base("").replace("\n  ", "\n\t\t\t");
    let a = build_lossy(&base("")).ir;
    let b = build_lossy(&flat).ir;
    let c = build_lossy(&deep).ir;
    assert_eq!(a, b, "removing indentation changed the result");
    assert_eq!(a, c, "adding indentation changed the result");
}

#[test]
fn a_folded_block_joins_lines_and_keeps_paragraph_breaks() {
    let src = base(
        "svc gamma \"G\"\n  is x\n  why >\n    one two\n    three\n\n    four\n",
    );
    let n = &build_lossy(&src).ir["nodes"][2];
    assert_eq!(n["detail"], "one two three\n\nfour");
}

#[test]
fn a_literal_block_keeps_its_line_breaks() {
    let src = base("tab two \"Two\"\n  code |\n    line one\n      indented\n    line three\n");
    let blocks = &build_lossy(&src).ir["narrative"]["tabs"][1]["blocks"];
    assert_eq!(blocks[0]["type"], "code");
    assert_eq!(blocks[0]["text"], "line one\n  indented\nline three");
}

#[test]
fn a_block_ends_at_the_first_dedented_line() {
    let src = base("svc gamma \"G\"\n  why >\n    prose here\n  is a summary\n");
    let n = &build_lossy(&src).ir["nodes"][2];
    assert_eq!(n["detail"], "prose here");
    assert_eq!(n["summary"], "a summary");
}

// --- ids ------------------------------------------------------------------

#[test]
fn a_connection_id_is_derived_from_its_endpoints() {
    assert_eq!(build_lossy(&base("")).ir["edges"][0]["id"], "alpha__beta");
}

#[test]
fn two_connections_between_the_same_pair_get_distinct_ids() {
    let src = base("alpha -read-> beta \"more\"\n  carry SELECT 1\n  why Sometimes. Harmless.\n");
    let out = build_lossy(&src);
    let e = out.ir["edges"].as_array().unwrap();
    assert_eq!(e[0]["id"], "alpha__beta");
    assert_eq!(e[1]["id"], "alpha__beta_2");
    assert!(warnings(&src).iter().any(|m| m.contains("already runs")));
}

#[test]
fn a_duplicate_node_id_is_an_error() {
    let e = errors(&base("svc alpha \"Again\"\n  is x\n  why It does. It also does.\n"));
    assert!(e.iter().any(|m| m.contains("declared twice")), "{e:?}");
}

// --- kinds and modifiers --------------------------------------------------

#[test]
fn domain_words_normalise_onto_the_eight_shapes() {
    for (word, shape) in [
        ("db", "store"), ("postgres", "store"), ("bucket", "store"),
        ("server", "service"), ("worker", "service"), ("lambda", "service"),
        ("topic", "queue"), ("kafka", "queue"),
        ("lb", "entrypoint"), ("cdn", "external"), ("cron", "job"),
    ] {
        let src = base(&format!("{word} thing \"T\"\n  is x\n  why It does. It also does.\n"));
        let out = build_lossy(&src);
        assert!(!out.report.has_errors(), "{word}: {:?}", errors(&src));
        assert_eq!(out.ir["nodes"][2]["kind"], shape, "{word} should draw as {shape}");
    }
}

#[test]
fn modifiers_parse_in_any_order() {
    let src = base("svc gamma \"G\" !dormant @4,-2 x1.5\n  is x\n  why It does. It also does.\n");
    let n = &build_lossy(&src).ir["nodes"][2];
    assert_eq!(n["weight"], 1.5);
    assert_eq!(n["pos"], serde_json::json!([4, -2]));
    assert_eq!(n["status"], "dormant");
}

#[test]
fn an_unknown_kind_word_suggests_the_real_ones() {
    let src = base("wizard thing \"T\"\n  is x\n  why It does. It also does.\n");
    let d: Vec<_> = build_lossy(&src)
        .report
        .errors()
        .filter(|d| d.message.contains("wizard"))
        .map(|d| d.help.clone().unwrap_or_default())
        .collect();
    assert!(d[0].contains("entry svc store queue"), "{d:?}");
}

// --- cross references -----------------------------------------------------

#[test]
fn a_connection_to_a_missing_block_is_an_error_with_the_name_in_it() {
    let src = base("alpha -call-> ghost \"x\"\n  carry f()\n  why Never. Nothing.\n");
    assert!(errors(&src).iter().any(|m| m.contains("`ghost` is not a declared block")));
}

#[test]
fn a_narrative_link_to_a_missing_block_is_an_error() {
    let src = base("tab two \"Two\"\n  p see [[it|nowhere]]\n");
    assert!(errors(&src).iter().any(|m| m.contains("nowhere")));
}

#[test]
fn a_glossary_term_must_be_declared() {
    let src = base("tab two \"Two\"\n  p a {{widget}} appears\n");
    assert!(errors(&src).iter().any(|m| m.contains("widget")));
    let ok = base("tab two \"Two\"\n  p a {{widget}} appears\nterm \"widget\" = a small thing\n");
    assert!(!build_lossy(&ok).report.has_errors(), "{:?}", errors(&ok));
}

// --- the quality warnings -------------------------------------------------

#[test]
fn a_vague_payload_warns_but_does_not_block() {
    let src = base("alpha -data-> beta \"x\"\n  carry data\n  why Sometimes it happens. Sometimes not.\n");
    let out = build_lossy(&src);
    assert!(!out.report.has_errors());
    assert!(warnings(&src).iter().any(|m| m.contains("names nothing concrete")));
}

#[test]
fn an_unwired_block_warns() {
    let src = base("svc lonely \"Lonely\"\n  is x\n  why It does. It also does.\n");
    assert!(warnings(&src).iter().any(|m| m.contains("nothing connects to `lonely`")));
}

#[test]
fn marketing_language_in_the_tagline_warns() {
    let src = base("").replace("it demonstrates one thing at a time", "a powerful, seamless platform");
    assert!(warnings(&src).iter().any(|m| m.contains("marketing")));
}

// --- the inspector payload ------------------------------------------------

#[test]
fn structured_details_reach_the_ir() {
    let src = base(
        "db orders \"Orders\"\n\
         \x20 is where orders live\n\
         \x20 why Holds every order. Postgres with point-in-time recovery.\n\
         \x20 fact Engine = Postgres 16\n\
         \x20 fact Region = us-east-1\n\
         \x20 list Tables = orders, order_items, refunds\n\
         \x20 link Runbook = https://wiki/runbooks/orders\n\
         \x20 env DATABASE_URL PGBOUNCER_HOST\n\
         \x20 num Rows = 4.2M\n",
    );
    let out = build_lossy(&src);
    assert!(!out.report.has_errors(), "{:?}", errors(&src));
    let d = &out.ir["nodes"][2]["details"];
    assert_eq!(d["facts"][0]["label"], "Engine");
    assert_eq!(d["facts"][1]["value"], "us-east-1");
    assert_eq!(d["lists"][0]["items"], serde_json::json!(["orders", "order_items", "refunds"]));
    assert_eq!(d["links"][0]["url"], "https://wiki/runbooks/orders");
    assert_eq!(d["env"], serde_json::json!(["DATABASE_URL", "PGBOUNCER_HOST"]));
    // `num` is the hover card's headline, kept apart from the inspector rows
    assert_eq!(out.ir["nodes"][2]["metrics"][0]["label"], "Rows");
}

// --- the formatter --------------------------------------------------------

#[test]
fn formatting_is_idempotent_and_meaning_preserving() {
    let src = base("");
    let (doc, _) = parse::parse(&src);
    let once = blueprint_dsl::emit::emit(&doc);
    let (doc2, r2) = parse::parse(&once);
    assert!(!r2.has_errors(), "formatted output does not re-parse");
    let twice = blueprint_dsl::emit::emit(&doc2);
    assert_eq!(once, twice, "formatting is not idempotent");
    assert_eq!(build_lossy(&src).ir, build_lossy(&once).ir, "formatting changed the meaning");
}

// --- diagnostics ----------------------------------------------------------

#[test]
fn every_error_points_at_a_real_line() {
    let src = base("svc gamma \"G\"\n  is x\n  why It does. It also does.\n  carry nope\n");
    let out = build_lossy(&src);
    let n = src.lines().count();
    for d in out.report.errors() {
        if let Some(s) = d.span {
            assert!(s.line >= 1 && s.line <= n, "line {} outside 1..={n}", s.line);
        }
    }
}
