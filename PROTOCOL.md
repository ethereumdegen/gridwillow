# The codeviz protocol, v1.0

One JSON document describes a codebase. A fixed renderer draws it. This file is the
human-readable reference; `schema/codeviz.schema.json` is the authority, and
`scripts/validate.mjs` is what actually enforces it.

```
{ codeviz, meta, stats, groups, nodes, edges, narrative }
```

---

## The shape table

`kind` is the single most consequential field on a node. It is a closed enum, and it
decides the geometry — so the visual grammar is identical across every repo anyone ever
renders. Learn these eight and you can read any blueprint.

| kind | drawn as | reads as | use it for |
|---|---|---|---|
| `entrypoint` | tall narrow prism, vertical hatch | a way in | `main`, CLI commands, server bootstrap, exported handlers |
| `service` | cube, vertical hatch | a thing that does work | the default; any module with behaviour |
| `store` | wide laminated slab, cross-hatch | a place data rests | database, archive, filesystem, cache-as-truth |
| `queue` | ribbed stack of thin plates | a place work waits | channel, buffer, job queue, topic |
| `model` | cube with a dot on top | a call to a model | LLM call sites, inference endpoints |
| `library` | low flat plate | shared code | utils, types, shared crates, generated clients |
| `external` | ghost box, no fill | not yours | third-party APIs, vendored deps, other teams' services |
| `job` | small cube floating on a stem | runs on its own clock | cron, background workers, timers |

Pick the one a reader recognises, not the one that is most technically precise. Redis
used only as a job queue is a `queue`. A Postgres table used only as a lock is closer
to a `queue` than a `store`.

`weight` (0.5–2, default 1) scales footprint and height. It never changes the shape.
Raise it for the two or three blocks that dominate the system; if everything is heavy,
the drawing says nothing.

`status` — `active` (default), `dormant` (faded, for code that exists but is not
switched on), `planned` (ghost outline, for what is coming).

## The line table

| kind | drawn as | use it for |
|---|---|---|
| `data` | solid hairline | a value moves from one place to another |
| `call` | solid with arrowhead | A invokes B and waits |
| `event` | dashed | fire-and-forget, pub/sub, hooks |
| `read` | fine dotted | A reads state B owns |
| `write` | double solid with arrowhead | A mutates state B owns |
| `spawn` | sparse dotted | A creates or launches B |

`volume` (0–1) sets packet count and speed. It is the only way the drawing shows where
the hot path is, so spend it: 0.9 for the loop that runs constantly, 0.2 for the path
that fires at boot.

`bidirectional` only changes the hover card's arrow. It does not draw a second line.

## Field-by-field

### `meta`

| field | required | notes |
|---|---|---|
| `repo` | ✓ | the name on disk |
| `branch` | | shown greyed next to the repo name |
| `title` | ✓ | what the system **is** — "The Evolution Harness", not "metalcraft-agent" |
| `tagline` | ✓ | one lowercase sentence. The validator warns on marketing adjectives |
| `generated` | | free text in the footer — a date, a commit sha |

### `stats` (0–6)

The strip across the top. Facts a reader could not guess from the repo name. Counts
that reveal shape beat counts that reveal size — `582 distinct doctrines` is a stat,
`47 source files` is not.

### `groups` (1–8, realistically 2–6)

Sidebar section headers, and the unit of layout: each group becomes its own plot on
the floor. Order them so reading the sidebar top to bottom walks the system in the
order it runs. `note` adds a small greyed line under the header.

### `nodes` (4–60, target 15–40)

| field | required | notes |
|---|---|---|
| `id` | ✓ | `lower_snake_case`. Referenced by edges and by the narrative |
| `label` | ✓ | 1–3 words. Rendered uppercase; write it in normal case |
| `group` | ✓ | must match a `groups[].id` |
| `kind` | ✓ | see the shape table |
| `summary` | ✓ | one clause, ≤90 chars. Sidebar tooltip and card first line |
| `detail` | ✓ | 2–4 sentences. End with something a reader would not have guessed |
| `weight` | | 0.5–2 |
| `pos` | | `[col, row]` manual override. Skip it until you have seen the render |
| `paths` | | repo-relative and real. Directories are often better than files |
| `tech` | | lowercase crate/package/service names |
| `metrics` | | up to 4 `{label, value}`. Only where a number teaches something |
| `status` | | `active` \| `dormant` \| `planned` |

### `edges` (1–160)

| field | required | notes |
|---|---|---|
| `id` | ✓ | `lower_snake_case` |
| `from`, `to` | ✓ | node ids. No self-loops |
| `kind` | ✓ | see the line table |
| `label` | ✓ | 1–4 lowercase words naming what travels |
| `payload` | ✓ | **the concrete thing.** A type, a function, a table, a route, a topic |
| `detail` | ✓ | 2–3 sentences: when it fires, what it carries, what failure looks like |
| `volume` | | 0–1 |
| `bidirectional` | | card arrow only |
| `waypoints` | | `[[col,row], …]` manual routing. Last resort |

If `payload` cannot name something concrete, the edge is not real. Delete it.

### `narrative`

`tabs[]` — 1–4 tabs, each with `blocks[]`. Block types:

| type | renders as |
|---|---|
| `h` | section heading with a rule under it |
| `p` | paragraph |
| `note` | indented aside with a left bar |
| `code` | monospace block, no inline markup applied |
| `rule` | horizontal divider (`text` ignored) |

Two inline markups exist, and nothing else:

- `[[display text|node_id]]` → a highlighted phrase wired to that block. Hover either
  one and the other lights up. Use 6–12 across the panel.
- `{{term}}` → dotted underline; the definition shows on hover. Must also appear in
  `narrative.glossary`.

Everything else is escaped. Markdown does not work. HTML does not work.

## What you do not control

Positions, colours, fonts, hatching, line routing, camera angle, animation, panel
layout, label placement. All fixed, all identical for every blueprint.

The renderer is also fully deterministic — no `Math.random`, no clock-seeded values —
so the same JSON always produces the same arrangement. Edit one node, rebuild, and you
can see exactly what moved.

## Layout, if you are curious

1. Nodes are ranked by longest path through the whole graph. Cycles are handled by
   bounding the relaxation passes rather than detecting them.
2. Inside each group, the *distinct* ranks its members occupy are renumbered `0,1,2…`,
   so each group's plot is compact regardless of where it sits in the global order.
3. Same-rank nodes stack front-to-back, centred in the plot.
4. Group plots are packed in projected coordinates (`u = col − row`,
   `v = col + row`) rather than on the floor grid, because packing on the floor leaves
   voids that grow with each plot's depth.
5. `pos` overrides win over all of it.

## Errors and warnings

`scripts/validate.mjs` splits its findings in two.

**Errors** block the build (`--force` overrides): unknown enum values, dangling edge
endpoints, undeclared groups, duplicate ids, `[[…|id]]` pointing at nothing, missing
required fields, lengths out of range.

**Warnings** never block, and every one of them is a thing that makes a blueprint worse
to read: fewer than 15 or more than 40 nodes, a node no edge touches, a vague `payload`
like "data", a single-sentence `detail`, marketing language in the tagline, fewer than
three narrative links, two edges running the same direction between the same pair.

The renderer is separately forgiving at load time: nodes with an unknown group or kind
and edges with unresolvable endpoints are dropped and logged to the console rather than
throwing, so a nearly-correct blueprint still draws.
