//! Diagnostics: an error that can point at the exact line and column, and
//! render itself with a source excerpt.
//!
//! Every failure in this crate carries a span, because the whole point of a
//! DSL over hand-written JSON is that a mistake tells you where it is.

use std::fmt;

/// 1-indexed position in the source file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub line: usize,
    pub col: usize,
}

impl Span {
    pub fn new(line: usize, col: usize) -> Self {
        Self { line, col }
    }
    /// A span with no meaningful column — points at the whole line.
    pub fn line_only(line: usize) -> Self {
        Self { line, col: 1 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub severity: Severity,
    pub span: Option<Span>,
    pub message: String,
    /// An optional second line suggesting what to do instead.
    pub help: Option<String>,
}

impl Diagnostic {
    pub fn error(span: Span, message: impl Into<String>) -> Self {
        Self { severity: Severity::Error, span: Some(span), message: message.into(), help: None }
    }
    pub fn warn(span: Span, message: impl Into<String>) -> Self {
        Self { severity: Severity::Warning, span: Some(span), message: message.into(), help: None }
    }
    /// A finding about the document as a whole, with no single line to blame.
    pub fn global(severity: Severity, message: impl Into<String>) -> Self {
        Self { severity, span: None, message: message.into(), help: None }
    }
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let tag = match self.severity {
            Severity::Error => "error",
            Severity::Warning => "warn ",
        };
        match self.span {
            Some(s) => write!(f, "{tag} {}:{}: {}", s.line, s.col, self.message)?,
            None => write!(f, "{tag} {}", self.message)?,
        }
        if let Some(h) = &self.help {
            write!(f, "\n      help: {h}")?;
        }
        Ok(())
    }
}

/// A bag of diagnostics plus the source, so it can render excerpts.
#[derive(Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
}

impl Report {
    pub fn push(&mut self, d: Diagnostic) {
        self.diagnostics.push(d);
    }
    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| d.is_error())
    }
    pub fn warnings(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| !d.is_error())
    }
    pub fn error_count(&self) -> usize {
        self.errors().count()
    }
    pub fn warning_count(&self) -> usize {
        self.warnings().count()
    }
    pub fn has_errors(&self) -> bool {
        self.error_count() > 0
    }

    /// Render every diagnostic, each followed by the offending source line
    /// with a caret under the column. `path` is only used for the location
    /// prefix, so callers can pass whatever the user typed.
    pub fn render(&self, path: &str, source: &str) -> String {
        let lines: Vec<&str> = source.lines().collect();
        let mut out = String::new();
        // errors last, so the most important text is closest to the prompt
        let ordered = self
            .warnings()
            .chain(self.errors())
            .collect::<Vec<_>>();
        for d in ordered {
            match d.span {
                Some(s) => {
                    out.push_str(&format!(
                        "{} {path}:{}:{}\n    {}\n",
                        if d.is_error() { "error" } else { "warn " },
                        s.line,
                        s.col,
                        d.message
                    ));
                    if let Some(src) = lines.get(s.line - 1) {
                        out.push_str(&format!("    {:>4} | {}\n", s.line, src));
                        out.push_str(&format!(
                            "         | {}^\n",
                            " ".repeat(s.col.saturating_sub(1))
                        ));
                    }
                }
                None => {
                    out.push_str(&format!(
                        "{} {}\n",
                        if d.is_error() { "error" } else { "warn " },
                        d.message
                    ));
                }
            }
            if let Some(h) = &d.help {
                out.push_str(&format!("         help: {h}\n"));
            }
            out.push('\n');
        }
        out
    }
}
