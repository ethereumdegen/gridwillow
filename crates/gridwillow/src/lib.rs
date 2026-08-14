//! Gridwillow — a text language for describing software architecture, and its
//! compiler to the JSON intermediate representation the renderer draws.
//!
//! Think of it as Mermaid for three-dimensional infrastructure blueprints:
//! you write what the servers, databases, queues and data flows are, and a
//! fixed renderer turns that into an isometric engineering drawing you can
//! hover and click your way through.
//!
//! ```no_run
//! let src = std::fs::read_to_string("infra.bp").unwrap();
//! match gridwillow::build(&src) {
//!     Ok(out) => println!("{}", out.ir),
//!     Err(report) => eprint!("{}", report.render("infra.bp", &src)),
//! }
//! ```

pub mod ast;
pub mod compile;
pub mod diag;
pub mod emit;
pub mod html;
pub mod parse;

pub use compile::{Compiled, IR_VERSION};
pub use diag::{Diagnostic, Report, Severity, Span};

/// Parse and compile in one step.
///
/// Returns the IR plus any warnings on success. On failure the report is
/// returned whole, so a caller can render every problem at once rather than
/// making the author fix them one per run.
pub fn build(source: &str) -> Result<Compiled, Report> {
    let (doc, report) = parse::parse(source);
    if report.has_errors() {
        // Parse errors mean the AST is incomplete; compiling it would bury the
        // real cause under a cascade of invented ones.
        return Err(report);
    }
    let out = compile::compile(&doc, report);
    if out.report.has_errors() { Err(out.report) } else { Ok(out) }
}

/// Parse and compile, keeping the IR even when there are errors.
///
/// The Tauri app uses this so a file with one bad connection still draws the
/// rest while you fix it, instead of blanking the window on every keystroke.
pub fn build_lossy(source: &str) -> Compiled {
    let (doc, report) = parse::parse(source);
    compile::compile(&doc, report)
}
