# The blueprint DSL

A `.bp` file describes a software system — its servers, databases, queues and
the data that moves between them — and a fixed renderer draws it as an animated
isometric engineering plan you can hover and click through.

Think Mermaid, for infrastructure, in three dimensions.

`spec/blueprint.ebnf` is the formal grammar. `spec/blueprint-ir.schema.json` is
the compiled form the renderer consumes. This file is the one to read.

---

## Two rules carry the whole design

**Line-oriented.** Every construct is one line beginning with a keyword.
Indentation is decorative and means nothing. A file that is mis-indented — the
most common way a generated file goes wrong — still parses exactly the same.

**Context-scoped.** A declaration opens a scope; the attribute lines after it
attach to that scope until the next declaration. Attribute keywords are checked
against the open scope, so a misplaced line is a precise error instead of data
that silently vanishes.

The one exception to the first rule is the block scalar, `>` and `|`, where
indentation delimits the block. Prose has to span lines somehow, and this
follows YAML's convention so it reads the way you expect.

## The whole language, on one screen

```
# comments are whole-line only

blueprint payments-platform
  title    The Payment Path
  tagline  what happens between a card tap and a settled ledger row
  branch   main
  stamp    v4.2.0

stat Services = 11 · 3 languages
stat Peak     = 4,200 req/s

group edge "The edge"
  note everything before the request is ours

lb ingress "Load balancer" x1.2
  is    terminates TLS and picks a healthy checkout instance
  why >
    Two of them, one per zone, sharing a floating address. Health checks
    are shallow on purpose — a deep check took the whole pool down in
    March when the ledger was slow.
  src   infra/nginx/
  uses  nginx
  num   Zones = 2

group core "Core"

svc checkout "Checkout" x1.5
  is   turns a cart into an authorised payment
  why  Owns the state machine. Every transition is written before the
       call that causes it, so a crash mid-flight is recoverable.
  src  services/checkout/

db orders "Orders" x1.4
  is    the ledger — every authorisation, capture and refund
  why >
    Postgres, single writer, replicas for reads. It is the only store
    in the system that is allowed to be the source of truth.
  fact  Engine  = Postgres 16
  fact  Region  = us-east-1
  fact  Backups = PITR, 7 days
  list  Tables  = orders, order_items, captures, refunds
  list  Indexes = orders_customer_idx, orders_created_at_idx
  link  Runbook = https://wiki/runbooks/orders-db
  env   DATABASE_URL PGBOUNCER_HOST

topic settlements "Settlements" !planned
  is   the queue the ledger writes to and settlement reads from
  why  Not built yet. Settlement polls the table directly today, which is
       the reason the nightly job takes nineteen minutes.

# ------------------------------------------------------------------
# connections
# ------------------------------------------------------------------

ingress -call-> checkout "a tap"
  carry POST /v1/checkout {cart_id, payment_method}
  why   The only inbound path. A 5xx here is the one alert that pages.
  vol   0.9

checkout -write-> orders "the authorisation"
  carry INSERT INTO orders (id, cart_id, state, amount_cents)
  why >
    Written before the processor is called, never after. If the process
    dies between the two, a reconciliation job finds the orphan by state.
  vol   0.8

# ------------------------------------------------------------------
# narrative
# ------------------------------------------------------------------

tab what "What it does"
  h  The Payment Path
  p >
    A card tap arrives at [[the load balancer|ingress]] and leaves as a row
    in [[the ledger|orders]]. Everything between is one {{state machine}}.
  note Hover a block for what it is. Click one for everything about it.
  code |
    curl -XPOST https://api/v1/checkout -d @cart.json

term "state machine" = a set of named states and the legal moves between them
```

## The shape table

`kind` decides the geometry. There are eight shapes and that is the whole
visual vocabulary — learn them once and every blueprint anyone writes is
readable. What varies is the *word* you use: many domain words alias onto each
shape, so you can call a thing what it actually is.

| shape | drawn as | reads as | write it as |
|---|---|---|---|
| entrypoint | tall narrow prism | a way in | `entry` `lb` `ingress` `gateway` `cli` `endpoint` |
| service | cube, vertical hatch | a thing that does work | `svc` `server` `api` `app` `worker` `lambda` `module` |
| store | wide laminated slab | a place data rests | `store` `db` `postgres` `mysql` `sqlite` `cache` `redis` `bucket` `s3` `blob` `volume` `index` `table` |
| queue | ribbed stack of plates | a place work waits | `queue` `topic` `stream` `channel` `buffer` `bus` `kafka` `pubsub` `mailbox` |
| model | cube with a dot | a call to a model | `model` `llm` `inference` `agent` |
| library | low flat plate | shared code or contract | `lib` `pkg` `crate` `schema` `config` `contract` |
| external | ghost box, no fill | not yours | `ext` `saas` `vendor` `client` `browser` `mobile` `user` `cdn` |
| job | small cube on a stem | runs on its own clock | `job` `cron` `timer` `scheduler` `batch` `task` |

Pick the shape a reader recognises, not the one that is most technically
precise. Redis used only as a job queue is a `topic`, not a `cache`.

**Modifiers**, in any order after the label:

- `x1.4` — visual weight, 0.5 to 2.0. Raise it for the two or three blocks
  that dominate. If everything is heavy, nothing is.
- `@4,-2` — manual grid position. Reach for it after you have seen the render,
  never while writing.
- `!dormant` — faded, for code that exists but is not switched on.
  `!planned` — a ghost outline, for what is coming. Default is active.

## The line table

| kind | drawn as | use it for |
|---|---|---|
| `-data->` | solid hairline | a value moves from one place to another |
| `-call->` | solid with arrowhead | A invokes B and waits |
| `-event->` | dashed | fire-and-forget, pub/sub, webhooks |
| `-read->` | fine dotted | A reads state B owns |
| `-write->` | double solid, arrowhead | A mutates state B owns |
| `-spawn->` | sparse dotted | A creates or launches B |

Write `<-call->` for bidirectional; it changes the hover card's arrow, not the
line. `vol` (0 to 1) sets packet density and speed — the only way the drawing
shows where the hot path is, so spend it. A connection's id is derived as
`from__to`; override it with `as` only when you need to.

## Attributes by scope

| scope | keywords |
|---|---|
| `blueprint` | `title` `tagline` `branch` `stamp` |
| top level | `stat <label> = <value>` |
| `group` | `note` |
| node | `is` `why` `src` `uses` `num` `fact` `list` `link` `env` |
| connection | `carry` `why` `vol` `as` `via` |
| `tab` | `h` `p` `note` `code` `---` |

**`is`** is one clause, under 90 characters — what it is, not what it is for.
**`why`** is 2–4 sentences: what it does, roughly how, and one thing a reader
would not have guessed. That last sentence is what makes a hover card worth
opening.

**`carry`** is the hard one. Every connection must name something concrete —
a type signature, a function, an SQL table, an HTTP route, a topic. If you
cannot name what crosses the line, the line is not real; delete it. This rule
exists because the failure mode of generated architecture diagrams is boxes
joined by vibes.

## The inspector

Hovering shows a quick card. **Clicking pins a full inspector** in the right
panel, and that is where `fact`, `list`, `link` and `env` land — alongside the
source paths, the tech chips, and every connection in and out, each one
clickable to walk the graph.

```
db orders "Orders"
  fact Engine  = Postgres 16          →  a labelled row
  list Tables  = orders, refunds      →  chips
  link Runbook = https://…            →  a clickable row
  env  DATABASE_URL PGBOUNCER_HOST    →  chips
  num  Rows    = 4.2M                 →  a headline number on the hover card
```

`num` and `fact` share a syntax and differ in destination: `num` is one of the
up-to-four headline numbers on the hover card, `fact` is an inspector row.
All of them repeat.

## Prose values

An attribute value runs to the end of its line. For anything longer, end the
line with a block marker:

- `>` **folded** — following lines are joined with spaces; a blank line becomes
  a paragraph break. Use this for all prose.
- `|` **literal** — newlines preserved. Use this for `code`.

A block ends at the first line indented no further than the line that opened
it, or at end of file.

Two inline markups work inside any prose, and nothing else does:

- `[[display text|node_id]]` — a highlighted phrase wired to a block. Hover
  either and the other lights up; click to fly there and open the inspector.
  Six to twelve across a narrative is about right.
- `{{term}}` — dotted underline, definition on hover. Must have a matching
  `term "…" = …` declaration.

Markdown does not work. HTML is escaped.

## Errors and warnings

`bp check` splits its findings in two, and the split is the point.

**Errors** block a build: an unknown enum value, a connection to a block that
does not exist, a duplicate id, a `[[…|id]]` pointing at nothing, a missing
required field, a length out of range. Every one carries a line, a column, and
the offending source line with a caret under it.

**Warnings** never block, and each is a thing that makes a blueprint worse to
read: fewer than 15 or more than 40 blocks, a block nothing connects to, a
vague `carry` like "data", a one-sentence `why`, marketing language in the
tagline, two connections running the same direction between the same pair,
fewer than three narrative links.

`--force` builds anyway. The app is more forgiving still: a file that stops
parsing keeps the last good drawing on screen with the errors over it, because
blanking the window on every half-typed line makes a live-reload loop useless.

## What you do not control

Positions, colours, fonts, hatching, line routing, camera angle, animation,
panel layout, label placement. All fixed, identical for every blueprint, and
fully deterministic — no `Math.random`, no clock-seeded values. The same file
always produces the same drawing, so you can change one block, save, and see
exactly what moved.

## Layout, if you are curious

1. Blocks are ranked by longest path through the whole graph. Cycles are handled
   by bounding the relaxation passes rather than detecting them.
2. Inside a group, the *distinct* ranks its members occupy are renumbered
   `0,1,2…`, so a group's plot is compact regardless of where it sits globally.
3. Same-rank blocks stack front-to-back, centred in the plot.
4. Group plots are packed in projected coordinates (`u = col − row`,
   `v = col + row`) rather than on the floor grid. Packing on the floor leaves
   voids that grow with each plot's depth, and turns the drawing into a thin
   diagonal streak with two empty corners.
5. `@col,row` overrides all of it.
