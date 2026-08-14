# The blueprint prompt

Paste everything below the line into Claude (or any model with file-reading tools),
together with a checked-out repository or a description of an infrastructure.
It produces one file: `<name>.bp`.

Then run:

```bash
bp check  <name>.bp     # every problem at once, with line numbers
bp export <name>.bp     # one self-contained HTML file
```

or open the `.bp` in the Blueprint app, which redraws it every time you save.

---

You are producing an **architectural blueprint** of the system I have given you — a
codebase, a deployed infrastructure, or both.

The blueprint is rendered as an animated isometric engineering drawing: extruded,
hatched blocks on a hairline grid, wired together by orthogonal connectors with
travelling data packets, alongside a sidebar index and a narrative panel. Hovering a
block explains the subsystem. Hovering a connector explains what crosses it.

**You do not write any of that.** The renderer is fixed and you must not modify it.
Your entire output is a single `.bp` file. That constraint is the point: it is what
makes two blueprints of two different systems readable side by side.

The full grammar is in `PROTOCOL.md`. Read it before you start. The short version:
every construct is one line starting with a keyword, indentation means nothing, a
`group` scopes the blocks under it, and prose that needs more than a line ends with
`>` and continues indented.

Work through the six phases in order. Do not skip ahead — writing the file before you
have surveyed the system is the single most reliable way to produce a drawing full of
plausible, wrong connections.

---

## Phase 1 — Survey

Read, in this order, and write nothing yet:

1. The manifest — `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `*.csproj`.
   Note the real dependencies; they tell you what the system actually is.
2. The README, if there is one. Treat it as a claim, not as evidence.
3. Every entrypoint: `main.*`, `bin/*`, `cmd/*`, server bootstraps, CLI definitions,
   exported handlers, worker registrations, cron definitions.
4. The directory tree, two levels deep. Note which directories are large and which are
   one file pretending to be a package.
5. The schema or migrations directory, if one exists. Tables are the most honest map of
   a system's nouns you will find.

By the end you should be able to answer, in one sentence, what this program does when
it runs. If you cannot, keep reading.

## Phase 2 — Block census

Decide what the blocks are.

- A block is a **subsystem** — a thing a maintainer would name out loud in a design
  conversation. It is almost never a single file, and almost never a whole top-level
  directory either.
- Target **15–40 blocks**. Under 15 the drawing is trivial and not worth generating.
  Over 40 it turns to soup. `bp check` warns outside that band.
- Collapse leaf modules into their parent and mention them in that parent's `why`
  instead. "Also holds the retry policy and the backoff table" is worth more to a
  reader than two extra blocks.
- Give every block a kind word. There are only eight shapes, but many words map onto
  each — write `db`, `server`, `topic`, `bucket`, `lb`, `cron`, whatever the thing
  actually is. The full alias table is in `PROTOCOL.md`. Choose the shape a reader
  would recognise, not the one that is technically most accurate: Redis used purely
  as a job queue is a `topic`, not a `cache`.
- Group blocks into **2–6 groups**, ordered so that reading the sidebar top to bottom
  walks the system in the order it actually runs.
- Set `x<weight>` above 1 only for the few blocks that genuinely dominate the system.
  If everything is heavy, nothing is.

For each block write:

- `is` — one clause, under 90 characters. What it is, not what it is for.
- `why` — 2–4 plain sentences. What it does, roughly how, and **one thing a reader
  would not have guessed** from the name. That last sentence is what makes the hover
  card worth opening.
- `src` — repo-relative paths that actually exist. Directories are fine and often
  better than files. Do not guess a path; check it.
- `uses` — concrete crates, packages, or services. Lowercase.
- `num` — only where a number is genuinely informative. Line counts rarely are.

Then fill the **inspector**, which is what a reader sees on click. This is where a
blueprint stops being a picture and starts being a reference, so be generous:

- `fact Engine = Postgres 16` — labelled values. Versions, regions, replica counts,
  retention windows, ports, owners.
- `list Tables = orders, refunds` — enumerations. Table names, indexes, topics,
  routes, feature flags.
- `link Runbook = https://…` — runbooks, dashboards, design docs.
- `env DATABASE_URL` — the variables the thing needs to run.

All four repeat. A database block with its real table names in it is worth more to
somebody new than three paragraphs of prose.

## Phase 3 — Connection tracing

Now find the connections, working outward from the entrypoints.

**The hard rule:** every connection must name something concrete in `carry` — a type
signature, a function name, an SQL table, an HTTP route, a channel type, a topic name,
an environment variable. If you cannot name what crosses the line, the line is not
real. Delete it.

This rule exists because the failure mode of generated architecture diagrams is boxes
connected by vibes. A drawing with 20 true connections is worth more than one with 60
where half are "relates to".

- Write it as `from -kind-> to "label"` with the kind from the fixed set: `data`,
  `call`, `event`, `read`, `write`, `spawn`. It changes the line style and the packet
  shape, so it is a real signal to the reader.
- The quoted label is 1–4 lowercase words naming what travels: "chosen parent",
  "signed receipt", "a card tap".
- `why` — 2–3 sentences: when it fires, what it carries, and what happens when it
  fails. The failure sentence is the one people remember.
- `vol` — relative business, 0 to 1. This drives packet density, which is how the
  drawing communicates where the hot path is. Do not set everything to 0.5.
- Prefer one well-described connection to three thin ones between the same pair.
- Every block should be touched by at least one connection. An untouched block means
  either a missing connection or a block that should not exist.

## Phase 4 — Narrative

Write the right-hand panel: two tabs, `WHAT IT DOES` and `HOW IT'S BUILT`.

The audience is a competent engineer who has never seen this repo and has about four
minutes. Write it the way you would explain the system to a colleague at a whiteboard.

**Voice — match this:**

> The diagram is a loop because the system is: one archive → pick a parent → write a
> new doctrine → play it → rate it → file it → back to the archive. Everything below
> the loop is the game itself: the Rust engine sits beside it, finished and not
> switched on.

Short declaratives. Concrete nouns. Say the surprising thing plainly rather than
building up to it.

**Do not write:**

- marketing adjectives — powerful, seamless, robust, cutting-edge, state-of-the-art
- bullet lists of features
- anything you would not say out loud
- restatements of what the block labels already say

Two inline markups are available and nothing else:

- `[[display text|node_id]]` — links a phrase to a block. Hovering the phrase lights up
  the block; hovering the block lights up the phrase. Use **6–12** of these across the
  panel. They are what makes the prose and the drawing feel like one object.
- `{{term}}` — marks a glossary term. It needs a matching `term "…" = …` line.

Block types: `h` (heading), `p` (paragraph), `note` (indented aside), `code`
(monospace), `rule` (divider). Raw HTML is escaped, so anything else shows up literally.

Also fill `title` — the human name for what the system *is*, not what the repo is
called — and `tagline`, one lowercase sentence. Then 4–6 `stats`: facts a reader
could not guess. "582 distinct doctrines" is a stat. "47 files" is not.

## Phase 5 — Self-check

Before emitting anything, verify:

`bp check` will catch most of this for you — run it. But check these yourself first,
because two of them it cannot see:

- [ ] Every path in `src` **exists in the repo**. Check them; do not assume.
- [ ] Every `carry` names something concrete that is actually true of the code.
- [ ] Both endpoints of every connection are declared blocks.
- [ ] Every `[[…|id]]` and `{{term}}` resolves.
- [ ] Every block is touched by at least one connection.
- [ ] Block count is between 15 and 40.
- [ ] No two blocks share an id.

## Phase 6 — Emit

Write the complete file to `<name>.bp`. Nothing else — no commentary, no partial
file, no placeholder values. Then run `bp check` on it and fix what it reports.

Then tell the human, in three or four sentences, what you found that surprised you
about the codebase. That is often worth more than the drawing.

---

## Reference: the shape of the file

```
blueprint <name>                     title · tagline · branch? · stamp?
stat <label> = <value>               4-6 of them

group <id> "<Label>"                 note?    — scopes the blocks that follow
  <kind> <id> "<Label>" [x1.4] [@4,-2] [!dormant]
    is / why / src / uses / num / fact / list / link / env

<from> -<kind>-> <to> "<label>"      as? · carry · why · vol? · via?

tab <id> "<Label>"                   h · p · note · code · ---
term "<Term>" = <definition>
```

`kind` (blocks) — eight shapes, many aliases: `entry svc store queue model lib ext job`,
plus `db server api worker cache bucket topic lb cdn client cron` and more.
`kind` (lines) — `data call event read write spawn`.

Prose longer than a line ends with `>` (folded) or `|` (literal) and continues
indented. Inline: `[[text|block_id]]` and `{{term}}`. Nothing else.

Full detail is in `PROTOCOL.md`; the formal grammar is `spec/blueprint.ebnf`.

## Reference: things you do not decide

Positions, colours, fonts, line routing, camera angle, animation speed, panel layout.
All of it is fixed. `@col,row` and `via` exist as manual overrides for the rare case
where the auto-layout tangles something badly — reach for them last, after you have
seen the rendered drawing, not while you are writing the file.
