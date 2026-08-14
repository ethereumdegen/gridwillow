# Gridwillow

**A 3D diagram language for software architecture.**

[![licence](https://img.shields.io/badge/licence-MIT-black)](LICENSE)
[![language](https://img.shields.io/badge/compiler-Rust-black)](crates/gridwillow)
[![site](https://img.shields.io/badge/gridwillow.com-live-4a9d5f)](https://gridwillow.com)

Write a plain text file describing your services, databases, queues and the data
that moves between them. Get back an isometric engineering drawing you can pan,
hover and click through — with a full inspector behind every block.

![A Gridwillow blueprint of a payments platform, with the ledger selected and its inspector open](docs/preview.png)

```
db orders "Orders" x1.5
  is    the ledger — every authorisation, capture and refund ever taken
  why >
    Postgres with a single writer and two read replicas. It is the only
    store in the system permitted to be a source of truth; everything else
    is a cache, an index, or a copy that may be thrown away.
  fact  Engine  = Postgres 16
  fact  Backups = PITR, 7 days
  list  Tables  = orders, order_items, captures, refunds, idempotency_keys
  link  Runbook = https://wiki/runbooks/orders-db
  env   DATABASE_URL PGBOUNCER_HOST

checkout -write-> orders "the authorisation"
  carry INSERT INTO orders (id, cart_id, state, amount_cents)
  why >
    Written before the processor is called, never after. If the process dies
    between the two, the reconciler finds the orphan by its state.
  vol   0.8
```

## Why not just use Mermaid

Mermaid draws the graph you typed. Gridwillow makes you say enough about the
system that the drawing is worth keeping:

- **Shape carries meaning.** Eight block shapes, closed set — a laminated slab
  is a store, a ribbed stack is a queue, a ghost box is something you don't own.
  Two blueprints of two unrelated systems can be read side by side.
- **Every line has to be real.** A connection must name a concrete function,
  type, table or route in `carry`. If you can't name what crosses it, the
  compiler tells you the line isn't real. This is the rule that stops
  architecture diagrams becoming boxes joined by vibes.
- **Detail lives in the file.** `fact`, `list`, `link` and `env` fill an
  inspector that opens on click — table names, indexes, env vars, runbooks —
  so the diagram answers questions instead of just decorating a wiki.
- **It compiles.** Dangling references, undeclared blocks and missing prose are
  errors with a line and a column. Vague payloads and unwired blocks are
  warnings. A blueprint that renders is a blueprint someone checked.

The cost is that it is more work to write than a Mermaid graph. That is on
purpose, and it's why the [agent skills](#let-an-agent-write-it) exist.

## Use it

```bash
cargo install --path crates/gridwillow-cli   # the `bp` binary

bp check  infra.bp        # every problem at once, with line and column
bp export infra.bp        # one self-contained HTML file
bp fmt    infra.bp --write
```

Or open it in the app, which redraws every time you save:

```bash
cd app && cargo tauri dev
```

Three examples ship with it:

```bash
bp export examples/payments.bp           # a payments platform — 16 blocks
bp export examples/metalcraft-agent.bp   # a real Rust service — 39 blocks
bp export examples/self.bp               # this repo, describing itself
```

## Let an agent write it

```sh
./skills/install.sh          # OMP    -> ~/.omp/agent/skills/
./skills/install.sh claude   # Claude -> ~/.claude/skills/
```

Two skills, plain `SKILL.md` files in the format [OMP](https://omp.sh) and Claude
Code both discover:

- **`gridwillow-blueprint`** surveys a repo — manifest, entrypoints, migrations,
  deployment config — traces the call graph with `lsp`, and writes a `.bp`. It
  bundles its own grammar and prose references, so it works installed globally
  with no copy of this repo nearby.
- **`gridwillow-refresh`** takes a blueprint that already exists and checks every
  claim in it against the code: paths that moved, functions that were deleted,
  tables that were added. A diagram that is quietly wrong is worse than none.

The compiler is the grader — the skill is told to run `bp check` and fix what it
reports, so what comes back compiles.

## What you get

- **An isometric field of extruded blocks.** Eight shapes, closed set — but many
  words for each, so you write `db`, `topic`, `lb`, `cron`, whatever the thing is.
- **Orthogonal connectors** with chamfered corners, six line styles, and travelling
  packets whose density tracks the traffic you declared.
- **Hover a block** → what it is, what backs it, how many connections touch it.
- **Hover a connector** → both endpoints and the concrete payload that crosses it.
  Its packets speed up so you can see which line you're reading.
- **Click a block** → the inspector: facts, table names, env vars, source paths,
  runbook links, and every connection in and out — each one clickable to walk the
  graph.
- **A narrative panel** whose highlighted phrases are wired to the blocks. Hover a
  phrase and its block lights up, and the reverse.

Controls: drag to pan, scroll to zoom, `Q`/`E` to rotate ninety degrees, `F` to
fit, `L` for labels, `Esc` to deselect.

## How it fits together

```
       you (or a model)                fixed machinery
    ┌────────────────────┐   ┌──────────────────────────────────┐
    │  infra.bp          │──▶│ gridwillow      parse → compile  │
    │  the only file     │   │      │                           │
    │  anyone authors    │   │      ▼                           │
    └────────────────────┘   │    IR (JSON)                     │
                             │      │                           │
                             │      ├──▶ renderer/  three.js    │
                             │      │      ├─ bp export → .html │
                             │      │      └─ Gridwillow.app    │
                             │      └──▶ spec/*.schema.json     │
                             └──────────────────────────────────┘
```

| path | what it is |
|---|---|
| `skills/` | OMP / Claude Code skills — an agent that writes and refreshes blueprints |
| `PROMPT.md` | the same procedure as one long paste, if you prefer that |
| `PROTOCOL.md` | the language reference — read this one |
| `spec/blueprint.ebnf` | the formal grammar |
| `spec/blueprint-ir.schema.json` | the compiled IR the renderer consumes |
| `crates/gridwillow/` | parser, compiler, formatter, HTML exporter |
| `crates/gridwillow-cli/` | the `bp` binary |
| `renderer/` | the drawing — one implementation, shared by app and export |
| `app/` | the Tauri viewer with live reload |
| `site/` | gridwillow.com — a static page and a zero-dependency server |
| `vendor/` | three.js r169, pinned and checked in on purpose |
| `examples/` | a payments platform, a real Rust service, and this repo |

## Design notes

**The file is the product.** HTML is one renderer of it, the app is another.
Everything downstream of the `.bp` is fixed machinery that behaves identically
for every file it is ever handed — which is why two blueprints of two different
systems can be read side by side. A laminated slab means *store* in both.

**Indentation means nothing.** Every construct is one line starting with a
keyword, and a declaration owns the attribute lines after it. The most common
way a generated file goes wrong is inconsistent indentation, and it costs
nothing to be immune. The one exception is block scalars (`>` and `|`), which
follow YAML's convention.

**Errors point at lines.** `bp check` reports everything at once with a caret
under the column and a suggestion underneath. The app is more forgiving still: a
file that stops parsing keeps the last good drawing on screen with the errors
over it, because blanking the window on every half-typed line makes a
live-reload loop useless.

**The camera does not orbit.** Orthographic, pinned to the `(1,1,1)` axis —
exactly the classic isometric elevation. Pan, zoom, and ninety-degree snaps are
the entire control set. The moment you can tumble to an arbitrary angle, it
stops reading as an engineering drawing and starts reading as a 3D toy.

**No lights.** Faces are flat-coloured to fake the shading, which keeps every
edge crisp at any zoom and makes the render cost trivial. Hatching is drawn
procedurally into canvas textures at startup, so nothing ships as an image.

**Deterministic.** No `Math.random`, no clock-seeded values. Same file, same
drawing — so you can change one block, save, and diff what moved.

**three.js is vendored, not fetched.** Pinned at r169 and embedded in every
export as a base64 data URL inside an import map, which resolves under `file://`
where a relative module import would be blocked by CORS. It costs about 660 KB
per file and buys a deliverable that still renders identically, offline, in five
years.

## The visual harness

The renderer is the one part a unit test can't reach, so there's a harness that
drives it headlessly and *measures* the result instead of eyeballing it:

```bash
npm i                                            # playwright, dev-only
node scripts/shoot.mjs examples/payments.bp --check
```

It renders across zoom levels and device pixel ratios, writes a PNG per
combination, and asserts three things per frame:

- the canvas fits its container (catches pixel-ratio scaling bugs)
- every label sits where it should, within 1.5px
- labels were actually measured, and at least one is visible

The alignment check re-projects each block's apex itself from the canvas's real
on-screen rectangle and compares that against where the label div ended up. It
shares no code with the renderer's label maths, so a bug in one can't hide in
the other.

That check exists because it had to: the renderer was calling
`setSize(w, h, false)`, which skips setting the canvas's CSS size. On a retina
display the canvas laid out at twice its container — the drawing rendered double
and clipped, and every label landed at half position. Screenshots at
devicePixelRatio 1 look perfect and can never catch it.

```bash
node scripts/shoot.mjs examples/payments.bp --zoom 0.5,1,2,4 --dpr 1,2
node scripts/shoot.mjs examples/payments.bp --focus orders --inspect
```

## Building the app

Needs the Rust toolchain and the Tauri CLI (`cargo install tauri-cli --version '^2'`).

```bash
cd app && cargo tauri dev      # run it
cd app && cargo tauri build    # a .app / .dmg
```

The webview assets are assembled from `renderer/` by `app/src-tauri/build.rs`, so
there is one renderer and it cannot drift from what `bp export` produces.

## The site

`site/` is gridwillow.com: one static page, one exported blueprint running live in
the hero, and a dependency-free Node server so Railway can boot it with no install
step.

```bash
cd site && npm start        # http://localhost:3000
```

### Deploying it

New Railway service from this repo, then in **Settings → Source** set
**Root Directory** to `site`. That is the whole configuration — the builder finds
`site/package.json`, sees the `start` script, and runs it. There is deliberately
no `railway.json`: Railway resolves config files from the *repository* root
rather than the service root, so one sitting in `site/` would be silently
ignored and one at the top would need an absolute path for no benefit.

Set **Watch Paths** to `site/**` if you don't want a Rust commit redeploying the
page.

For the domain: Railway issues a CNAME and a TXT record, both required. An apex
like `gridwillow.com` needs a provider that flattens CNAMEs at the root —
Cloudflare, DNSimple, Namecheap and bunny.net all do; a plain A record will not
work.

`site/payments.blueprint.html` is the one build artifact in version control —
Railway builds `site/` alone and has no Rust toolchain to regenerate it. After
editing the sample, rebuild it and commit:

```bash
bp export examples/payments.bp -o site/payments.blueprint.html
```

## Licence

three.js is vendored under its own MIT licence (`vendor/three.LICENSE`).
