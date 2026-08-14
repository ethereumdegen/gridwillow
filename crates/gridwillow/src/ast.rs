//! The AST: a direct, lossless record of what the file said.
//!
//! Nothing here validates or defaults anything — that is [`crate::compile`]'s
//! job. Keeping the two apart is what lets `bp fmt` round-trip a file without
//! quietly inventing fields the author never wrote.

use crate::diag::Span;

#[derive(Debug, Default)]
pub struct Document {
    pub meta: Meta,
    pub stats: Vec<Stat>,
    pub groups: Vec<Group>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub tabs: Vec<Tab>,
    pub terms: Vec<Term>,
}

#[derive(Debug, Default)]
pub struct Meta {
    pub repo: Option<String>,
    pub title: Option<String>,
    pub tagline: Option<String>,
    pub branch: Option<String>,
    pub stamp: Option<String>,
    pub span: Option<Span>,
}

#[derive(Debug)]
pub struct Stat {
    pub label: String,
    pub value: String,
    pub span: Span,
}

#[derive(Debug)]
pub struct Group {
    pub id: String,
    pub label: String,
    pub note: Option<String>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Entrypoint,
    Service,
    Store,
    Queue,
    Model,
    Library,
    External,
    Job,
}

impl NodeKind {
    /// There are only eight shapes, but many words for the things that take
    /// them. An author describing infrastructure should be able to write `db`
    /// or `bucket` or `lb` and get the right block, without the visual
    /// vocabulary growing past what a reader can learn in a minute.
    ///
    /// Aliases normalise; the IR always carries one of the eight.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            // ways in
            "entry" | "entrypoint" | "lb" | "loadbalancer" | "ingress"
            | "gateway" | "cli" | "endpoint" => Self::Entrypoint,

            // things that do work
            "svc" | "service" | "server" | "api" | "app" | "worker"
            | "function" | "lambda" | "proc" | "module" => Self::Service,

            // things data rests in
            "store" | "db" | "database" | "postgres" | "mysql" | "sqlite"
            | "cache" | "redis" | "bucket" | "s3" | "blob" | "volume"
            | "disk" | "index" | "table" => Self::Store,

            // things work waits in
            "queue" | "topic" | "stream" | "channel" | "buffer" | "bus"
            | "kafka" | "pubsub" | "mailbox" => Self::Queue,

            // inference
            "model" | "llm" | "inference" | "agent" => Self::Model,

            // shared code, config, contracts
            "lib" | "library" | "pkg" | "package" | "crate" | "schema"
            | "config" | "contract" => Self::Library,

            // not yours
            "ext" | "external" | "third_party" | "vendor" | "saas"
            | "client" | "browser" | "mobile" | "user" | "cdn" => Self::External,

            // runs on its own clock
            "job" | "cron" | "timer" | "scheduler" | "batch" | "task" => Self::Job,

            _ => return None,
        })
    }
    pub fn as_ir(self) -> &'static str {
        match self {
            Self::Entrypoint => "entrypoint",
            Self::Service => "service",
            Self::Store => "store",
            Self::Queue => "queue",
            Self::Model => "model",
            Self::Library => "library",
            Self::External => "external",
            Self::Job => "job",
        }
    }
    pub fn as_short(self) -> &'static str {
        match self {
            Self::Entrypoint => "entry",
            Self::Service => "svc",
            Self::Store => "store",
            Self::Queue => "queue",
            Self::Model => "model",
            Self::Library => "lib",
            Self::External => "ext",
            Self::Job => "job",
        }
    }
    pub const ALL_SHORT: &'static str = "entry svc store queue model lib ext job";
    /// Shown in the "did you mean" help when a kind word is not recognised.
    pub const COMMON_ALIASES: &'static str =
        "db server api worker cache bucket topic lb cdn client cron";
}

/// A repeatable, structured section on a node. These are what fill the
/// inspector panel when a block is selected — the place where a reader goes
/// looking for the table names, the env vars, and the runbook link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detail {
    /// `fact Engine = Postgres 16` — a labelled value, rendered as a row.
    Fact { label: String, value: String },
    /// `list Tables = orders, order_items` — rendered as chips.
    List { label: String, items: Vec<String> },
    /// `link Runbook = https://…` — rendered as a clickable row.
    Link { label: String, url: String },
    /// `env DATABASE_URL PGBOUNCER_HOST` — variables this thing needs.
    Env { vars: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Active,
    Dormant,
    Planned,
}

impl Status {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "active" => Self::Active,
            "dormant" => Self::Dormant,
            "planned" => Self::Planned,
            _ => return None,
        })
    }
    pub fn as_ir(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Dormant => "dormant",
            Self::Planned => "planned",
        }
    }
}

#[derive(Debug)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    pub group: String,
    pub weight: Option<f64>,
    pub pos: Option<(i64, i64)>,
    pub status: Option<Status>,
    pub summary: Option<String>,
    pub detail: Option<String>,
    pub paths: Vec<String>,
    pub tech: Vec<String>,
    /// The 1-4 headline numbers shown on the hover card.
    pub metrics: Vec<(String, String)>,
    /// Everything else, shown in the inspector when the block is selected.
    pub details: Vec<Detail>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Data,
    Call,
    Event,
    Read,
    Write,
    Spawn,
}

impl EdgeKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "data" => Self::Data,
            "call" => Self::Call,
            "event" => Self::Event,
            "read" => Self::Read,
            "write" => Self::Write,
            "spawn" => Self::Spawn,
            _ => return None,
        })
    }
    pub fn as_ir(self) -> &'static str {
        match self {
            Self::Data => "data",
            Self::Call => "call",
            Self::Event => "event",
            Self::Read => "read",
            Self::Write => "write",
            Self::Spawn => "spawn",
        }
    }
    pub const ALL: &'static str = "data call event read write spawn";
}

#[derive(Debug)]
pub struct Edge {
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub bidirectional: bool,
    pub label: Option<String>,
    pub payload: Option<String>,
    pub detail: Option<String>,
    pub volume: Option<f64>,
    pub waypoints: Vec<(i64, i64)>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Heading,
    Paragraph,
    Note,
    Code,
    Rule,
}

impl BlockKind {
    pub fn as_ir(self) -> &'static str {
        match self {
            Self::Heading => "h",
            Self::Paragraph => "p",
            Self::Note => "note",
            Self::Code => "code",
            Self::Rule => "rule",
        }
    }
}

#[derive(Debug)]
pub struct TextBlock {
    pub kind: BlockKind,
    pub text: String,
    pub span: Span,
}

#[derive(Debug)]
pub struct Tab {
    pub id: String,
    pub label: String,
    pub blocks: Vec<TextBlock>,
    pub span: Span,
}

#[derive(Debug)]
pub struct Term {
    pub term: String,
    pub definition: String,
    pub span: Span,
}
