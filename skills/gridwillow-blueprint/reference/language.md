# The `.bp` language

Everything you need to author a blueprint. The formal grammar is
`spec/blueprint.ebnf` in the Gridwillow repo; this is the working reference.

## Two rules

**Line-oriented.** Every construct is one line beginning with a keyword.
Indentation is decorative and means nothing.

**Context-scoped.** A declaration opens a scope; attribute lines after it attach
to that scope until the next declaration. An attribute in the wrong scope is an
error with a line number, not silently-dropped data.

The one exception is the block scalar (`>` and `|`), where indentation delimits
the block.

## Skeleton

```
blueprint <name>
  title    <human name for what the system IS>
  tagline  <one lowercase sentence>
  branch   <optional>
  stamp    <optional — a version or date>

stat <Label> = <value>                    # 4-6, across the top strip

group <id> "<Label>"                      # scopes the blocks that follow
  note <optional one-liner>

<kind> <id> "<Label>" [x1.4] [@4,-2] [!dormant]
  is    <one clause, under 90 chars>
  why   <2-4 sentences, or `>` for a block>
  src   <path> <path>
  uses  <tech> <tech>
  num   <Label> = <value>                 # headline number, hover card
  fact  <Label> = <value>                 # inspector row
  list  <Label> = <a>, <b>, <c>           # inspector chips
  link  <Label> = <url>                   # inspector link
  env   <VAR> <VAR>                       # inspector chips

<from> -<kind>-> <to> "<label>"           # `<-kind->` for bidirectional
  as    <explicit id>                     # optional; default is from__to
  carry <the concrete thing>
  why   <2-3 sentences>
  vol   <0.0 - 1.0>
  via   <col,row> <col,row>               # optional manual routing

tab <id> "<Label>"
  h     <heading>
  p     <paragraph>
  note  <indented aside>
  code  |
    verbatim lines
  ---                                     # divider

term "<Term>" = <definition>
```

Comments are whole-line only, starting with `#`.

## Block kinds — eight shapes, many words

| shape | drawn as | means | write any of |
|---|---|---|---|
| entrypoint | tall narrow prism | a way in | `entry` `lb` `loadbalancer` `ingress` `gateway` `cli` `endpoint` |
| service | cube, vertical hatch | does work | `svc` `service` `server` `api` `app` `worker` `function` `lambda` `proc` `module` |
| store | wide laminated slab | data rests | `store` `db` `database` `postgres` `mysql` `sqlite` `cache` `redis` `bucket` `s3` `blob` `volume` `disk` `index` `table` |
| queue | ribbed stack of plates | work waits | `queue` `topic` `stream` `channel` `buffer` `bus` `kafka` `pubsub` `mailbox` |
| model | cube with a dot | a model call | `model` `llm` `inference` `agent` |
| library | low flat plate | shared code | `lib` `library` `pkg` `package` `crate` `schema` `config` `contract` |
| external | ghost box, no fill | not yours | `ext` `external` `third_party` `vendor` `saas` `client` `browser` `mobile` `user` `cdn` |
| job | small cube on a stem | own clock | `job` `cron` `timer` `scheduler` `batch` `task` |

The set is closed. A word outside it is an error.

**Modifiers**, any order after the label:

- `x1.4` — weight, 0.5–2.0. Size and height only. Raise it for the two or three
  blocks that dominate; if everything is heavy nothing is.
- `@4,-2` — manual grid position. Last resort.
- `!dormant` — faded, exists but not switched on. `!planned` — ghost outline.

## Connection kinds — six

| write | drawn as | means |
|---|---|---|
| `-data->` | solid hairline | a value moves |
| `-call->` | solid, arrowhead | A invokes B and waits |
| `-event->` | dashed | fire-and-forget, pub/sub, webhook |
| `-read->` | fine dotted | A reads state B owns |
| `-write->` | double solid, arrowhead | A mutates state B owns |
| `-spawn->` | sparse dotted | A creates or launches B |

Also closed. `<-call->` marks bidirectional — it changes the hover card's arrow,
not the line.

## Prose

A value runs to the end of its line. For more, end the line with a marker:

- `>` **folded** — following lines join with spaces, a blank line becomes a
  paragraph break. Use for all prose.
- `|` **literal** — newlines preserved. Use for `code`.

A block ends at the first line indented no further than the line that opened it.

```
  why >
    Written before the processor is called, never after. If the process
    dies between the two, reconciliation finds the orphan by state.
```

Two inline markups, and nothing else works:

- `[[display text|block_id]]` — a highlighted phrase wired to a block. Hover
  either, the other lights up. Click flies the camera there.
- `{{term}}` — dotted underline with a definition on hover. Needs a matching
  `term "…" = …`.

Markdown does not render. HTML is escaped.

## Field limits

| field | limit |
|---|---|
| ids | `lower_snake_case`, 2–48 chars, starts with a letter |
| `title` | 60 chars |
| `tagline` | 160 chars |
| block label | 34 chars |
| `is` | 90 chars |
| `why` (block) | 20–600 chars |
| `carry` | 160 chars |
| `why` (connection) | 20–400 chars |
| connection label | 40 chars |
| `stat` | ≤6 of them |
| groups | 2–6 in practice, 8 max |
| blocks | 15–40 target, 60 hard max |

## What the checker will tell you

**Errors** block the build: unknown kind word, connection to a block that does
not exist, duplicate id, `[[…|id]]` pointing at nothing, missing `is`/`why`/
`carry`, a length out of range, a block declared before any group.

**Warnings** do not block, and each one is a real readability problem: under 15
or over 40 blocks, a block nothing connects to, `carry data` (name something
concrete), a one-sentence `why`, marketing language in the tagline, two
connections running the same direction between the same pair, fewer than three
narrative links.

## A worked fragment

```
group core "The core"
  note the state machine, and the one place truth lives

svc checkout "Checkout" x1.6
  is   turns a cart into an authorised payment
  why >
    Owns the state machine and nothing else. Every transition is written to
    the ledger before the call that causes it, never after, so a crash
    mid-flight leaves a recoverable record rather than a mystery.
  fact Language = Rust
  fact States = created, authorising, authorised, captured, refunded
  list Endpoints = POST /v1/checkout, POST /v1/capture, POST /v1/refund
  src  services/checkout/
  uses axum tokio sqlx
  link Runbook = https://wiki/runbooks/checkout

db orders "Orders" x1.5
  is    the ledger — every authorisation, capture and refund ever taken
  why >
    Postgres with a single writer and two read replicas. It is the only
    store in the system permitted to be a source of truth; everything else
    is a cache, an index, or a copy that may be thrown away.
  fact  Engine = Postgres 16
  fact  Backups = PITR, 7 days
  list  Tables = orders, order_items, captures, refunds, idempotency_keys
  env   DATABASE_URL PGBOUNCER_HOST
  num   Size = 1.4 TB

checkout -write-> orders "the authorisation"
  carry INSERT INTO orders (id, cart_id, state, amount_cents)
  why >
    Written before the processor is called, never after. If the process dies
    between the two, the reconciler finds the orphan by its state.
  vol   0.8
```
