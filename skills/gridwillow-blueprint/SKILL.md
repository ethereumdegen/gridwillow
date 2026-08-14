---
name: gridwillow-blueprint
description: Use when asked to draw, diagram, map, or visualise a codebase or an infrastructure — or when asked directly for a Gridwillow blueprint or a .bp file. Surveys the system and writes a .bp that compiles to an isometric architecture drawing.
---

# Gridwillow blueprint

Turn a system into a `.bp` file. The compiler renders it as an isometric
engineering drawing: extruded blocks on a hairline grid, wired by orthogonal
connectors with travelling packets, with a hover card on everything and an
inspector behind every block.

You write **one text file and nothing else**. The renderer is fixed. That
constraint is what makes two blueprints of two unrelated systems readable side
by side.

Read `reference/language.md` before writing a line — it is the whole grammar and
the shape table. Read `reference/voice.md` before writing prose; the prose is
most of the value and the default register is wrong for it.

## The procedure

Work the phases in order. The single most reliable way to produce a drawing full
of plausible, wrong connections is to start writing before you have looked.

### 1. Survey — write nothing

- The manifest: `Cargo.toml`, `package.json`, `pyproject.toml`, `go.mod`. Real
  dependencies tell you what the system is more honestly than the README does.
- Every entrypoint: `main.*`, `bin/*`, `cmd/*`, server bootstraps, CLI
  definitions, exported handlers, worker registrations, cron entries.
- The tree, two levels deep (`glob`). Note which directories are large and which
  are one file pretending to be a package.
- Migrations or schema, if present. Tables are the most honest map of a system's
  nouns you will find.
- Deployment: compose files, Terraform, k8s manifests, `railway.json`,
  `Dockerfile`. This is where the infrastructure blocks come from.

By the end you can say in one sentence what the system does when it runs. If you
cannot, keep reading.

### 2. Blocks — 15 to 40 of them

A block is a **subsystem**: something a maintainer would name out loud in a
design conversation. Almost never one file; almost never a whole top-level
directory either.

Under 15 blocks the drawing is trivial. Over 40 it is soup. Collapse leaf modules
into their parent and mention them in the parent's `why` — "also holds the retry
policy and the backoff table" is worth more than two extra blocks.

Choose the kind word a reader recognises, not the most technically precise one.
Redis used only as a job queue is a `topic`, not a `cache`.

Group into 2–6 groups, ordered so reading the sidebar top to bottom walks the
system in the order it actually runs.

### 3. Connections — only real ones

Work outward from the entrypoints. `lsp` is the right tool here: definitions,
references and implementations give you the call graph directly, where `grep`
gives you guesses.

**The hard rule.** Every connection names something concrete in `carry` — a type
signature, a function, an SQL table, an HTTP route, a topic, a channel type. If
you cannot name what crosses the line, the line is not real. Delete it.

This exists because the failure mode of generated architecture diagrams is boxes
joined by vibes. Twenty true connections beat sixty where half are "relates to".

Spend `vol`. It drives packet density, which is the only way the drawing shows
where the hot path is. Do not set everything to 0.5.

### 4. Inspector detail — be generous

`fact`, `list`, `link` and `env` fill the panel that opens on click. This is
where a blueprint stops being a picture and becomes a reference:

- `fact Engine = Postgres 16` — versions, regions, replica counts, retention,
  ports, owners, timeouts.
- `list Tables = orders, refunds` — table names, indexes, topics, routes, flags.
- `link Runbook = https://…` — runbooks, dashboards, design docs.
- `env DATABASE_URL` — what it needs to run.

A database block carrying its real table names is worth more to somebody new
than three paragraphs of prose.

### 5. Narrative

Two tabs: what it does, how it's built. Audience is a competent engineer who has
never seen this system and has four minutes. See `reference/voice.md`.

Use 6–12 `[[phrase|block_id]]` links across the panel. They are what makes the
prose and the drawing feel like one object rather than two things on a screen.

### 6. Check, then hand over

```sh
bp check <name>.bp
```

Fix every error. Read the warnings and fix the ones that are right — they are
about readability, and most of them are right.

Two things `bp check` cannot see, so verify them yourself:

- Every path in `src` **exists**. Check with `glob`; do not assume.
- Every `carry` is **true of the code**, not merely plausible.

Then tell the human, in three or four sentences, what surprised you about the
system. That is often worth more than the drawing.

## Rules that are not negotiable

- Never edit the renderer, the compiler, or the exported HTML. One file.
- Never invent a kind word or a connection kind. Both sets are closed;
  `reference/language.md` has them.
- Never use markdown or HTML in prose. Two inline markups exist and no others.
- Never guess a file path or a table name. Look it up.
- `@col,row` and `via` are last resorts, used after seeing a render, not while
  writing.

## Handing it back

```sh
bp export <name>.bp        # one self-contained HTML file
```

Or the human opens the `.bp` in the Gridwillow app, which redraws on every save.
If they are iterating, point them at the app rather than re-exporting for them.
