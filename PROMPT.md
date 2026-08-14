# The blueprint prompt

Paste everything below the line into Claude (or any model with file-reading tools),
together with a checked-out repository. It produces one file: `<repo>.codeviz.json`.

Then run:

```bash
node scripts/validate.mjs <repo>.codeviz.json
node scripts/build.mjs    <repo>.codeviz.json
```

and open the resulting `.blueprint.html`.

---

You are producing an **architectural blueprint** of the repository I have given you.

The blueprint is rendered as an animated isometric engineering drawing: extruded,
hatched blocks on a hairline grid, wired together by orthogonal connectors with
travelling data packets, alongside a sidebar index and a narrative panel. Hovering a
block explains the subsystem. Hovering a connector explains what crosses it.

**You do not write any of that.** The renderer is fixed and you must not modify it.
Your entire output is a single JSON document conforming to `schema/codeviz.schema.json`.
That constraint is the point: it is what makes two blueprints of two different systems
readable side by side.

Work through the six phases in order. Do not skip ahead — writing the JSON before you
have surveyed the repo is the single most reliable way to produce a drawing full of
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

## Phase 2 — Node census

Decide what the blocks are.

- A node is a **subsystem** — a thing a maintainer would name out loud in a design
  conversation. It is almost never a single file, and almost never a whole top-level
  directory either.
- Target **15–40 nodes**. Under 15 the drawing is trivial and not worth generating.
  Over 40 it turns to soup. The validator warns outside that band.
- Collapse leaf modules into their parent and mention them in that parent's `detail`
  instead. "Also holds the retry policy and the backoff table" is worth more to a
  reader than two extra blocks.
- Give every node a `kind` from the fixed enum. The kind decides the geometry — see
  the shape table in `PROTOCOL.md`. Choose the one a reader would recognise, not the
  one that is technically most accurate: a Redis instance used purely as a job queue
  is a `queue`, not a `store`.
- Group nodes into **2–6 groups**, ordered so that reading the sidebar top to bottom
  walks the system in the order it actually runs.
- Set `weight` above 1 only for the few blocks that genuinely dominate the system.
  If everything is heavy, nothing is.

For each node write:

- `summary` — one clause, under 90 characters. What it is, not what it is for.
- `detail` — 2–4 plain sentences. What it does, roughly how, and **one thing a reader
  would not have guessed** from the name. That last sentence is what makes the hover
  card worth opening.
- `paths` — repo-relative paths that actually exist. Directories are fine and often
  better than files. Do not guess a path; check it.
- `tech` — concrete crates, packages, or services. Lowercase.
- `metrics` — only where a number is genuinely informative. Line counts rarely are.

## Phase 3 — Edge tracing

Now find the connections, working outward from the entrypoints.

**The hard rule:** every edge must name something concrete in `payload` — a type
signature, a function name, an SQL table, an HTTP route, a channel type, a topic name,
an environment variable. If you cannot name what crosses the line, the line is not
real. Delete it.

This rule exists because the failure mode of generated architecture diagrams is boxes
connected by vibes. A drawing with 20 true edges is worth more than one with 60 edges
where half are "relates to".

- Pick `kind` from the fixed enum: `data`, `call`, `event`, `read`, `write`, `spawn`.
  It changes the line style and the packet shape, so it is a real signal to the reader.
- `label` — 1–4 lowercase words naming what travels. "chosen parent", "signed receipt".
- `detail` — 2–3 sentences: when it fires, what it carries, and what happens when it
  fails. The failure sentence is the one people remember.
- `volume` — relative business, 0 to 1. This drives packet density, which is how the
  drawing communicates where the system's hot path is. Do not set everything to 0.5.
- Prefer one well-described edge to three thin ones between the same pair.
- Every node should be touched by at least one edge. An untouched node means either a
  missing edge or a node that should not exist.

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
- `{{term}}` — marks a glossary term. It must also appear in `narrative.glossary`.

Block types: `h` (heading), `p` (paragraph), `note` (indented aside), `code`
(monospace), `rule` (divider). Raw HTML is escaped, so anything else shows up literally.

Also fill `meta.title` — the human name for what the system *is*, not what the repo is
called — and `meta.tagline`, one lowercase sentence. Then 4–6 `stats`: facts a reader
could not guess. "582 distinct doctrines" is a stat. "47 files" is not.

## Phase 5 — Self-check

Before emitting anything, verify:

- [ ] Every `edges[].from` and `edges[].to` resolves to a `nodes[].id`.
- [ ] Every `nodes[].group` resolves to a `groups[].id`.
- [ ] Every `[[…|node_id]]` in the narrative resolves to a real node.
- [ ] Every `{{term}}` appears in `narrative.glossary`.
- [ ] Every node is touched by at least one edge.
- [ ] Every path in `paths` exists in the repo. Check them; do not assume.
- [ ] Every `payload` names something concrete.
- [ ] Every `kind` is from the enum. You have not invented one.
- [ ] Node count is between 15 and 40.
- [ ] No two nodes share an `id`.

## Phase 6 — Emit

Write the complete JSON to `<repo-name>.codeviz.json`. Nothing else — no commentary,
no partial file, no placeholder values.

Then tell the human, in three or four sentences, what you found that surprised you
about the codebase. That is often worth more than the drawing.

---

## Reference: the document

```jsonc
{
  "codeviz": "1.0",
  "meta":   { "repo", "branch?", "title", "tagline", "generated?" },
  "stats":  [ { "label", "value" } ],                    // 4-6
  "groups": [ { "id", "label", "order?", "note?" } ],    // 2-6
  "nodes":  [ {
    "id", "label", "group", "kind",
    "summary", "detail",
    "weight?", "pos?", "paths?", "tech?", "metrics?", "status?"
  } ],
  "edges":  [ {
    "id", "from", "to", "kind",
    "label", "payload", "detail",
    "volume?", "bidirectional?", "waypoints?"
  } ],
  "narrative": {
    "tabs": [ { "id", "label", "blocks": [ { "type", "text" } ] } ],
    "glossary": [ { "term", "definition" } ]
  }
}
```

`node kind` — `entrypoint` · `service` · `store` · `queue` · `model` · `library` · `external` · `job`
`edge kind` — `data` · `call` · `event` · `read` · `write` · `spawn`
`block type` — `h` · `p` · `note` · `code` · `rule`
`status` — `active` · `dormant` · `planned`

Full field-by-field detail, including the shape each `kind` produces, is in
`PROTOCOL.md`. The authoritative constraints are in `schema/codeviz.schema.json`.

## Reference: things you do not decide

Positions, colours, fonts, line routing, camera angle, animation speed, panel layout.
All of it is fixed. `pos` and `waypoints` exist as manual overrides for the rare case
where the auto-layout tangles something badly — reach for them last, after you have
seen the rendered drawing, not while you are writing the JSON.
