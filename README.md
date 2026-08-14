# codebase-blueprint-ai

Point a language model at a repository. Get back an animated isometric engineering
drawing of its architecture, as one self-contained HTML file.

![the drawing](docs/preview.png)

The model does not write HTML, CSS, or three.js. It writes **one JSON file**, and a
fixed renderer prints it. That split is the whole idea: two blueprints of two different
systems can be read side by side, because a laminated slab means *store* in both of
them and a ribbed stack means *queue* in both of them.

---

## Use it

```bash
# 1. hand PROMPT.md and a checked-out repo to a model with file access
#    -> it writes my-repo.codeviz.json

# 2. check it
node scripts/validate.mjs my-repo.codeviz.json

# 3. bake it
node scripts/build.mjs my-repo.codeviz.json

# 4. open my-repo.blueprint.html
```

No install, no `node_modules`, no dev server, no network. Node 18+ is the only
requirement, and only for the build step — the output itself is a single HTML file that
opens straight off disk.

Try it on the repo that describes itself, or on a real one:

```bash
node scripts/build.mjs examples/self.codeviz.json              && open examples/self.blueprint.html
node scripts/build.mjs examples/metalcraft-agent.codeviz.json  && open examples/metalcraft-agent.blueprint.html
```

`examples/metalcraft-agent.codeviz.json` was produced by running `PROMPT.md` against
[metalcraft-agent](https://github.com/rust4ai/metalcraft-agent) — 39 subsystems, 63
connections, every claimed source path verified to exist.

## What you get

- **Isometric field of extruded blocks.** Shape encodes kind — eight kinds, closed set.
  Height and footprint scale with declared weight.
- **Orthogonal connectors** with chamfered corners, six line styles, and travelling
  data packets whose density tracks declared traffic.
- **Hover a block** → what the subsystem does, which files back it, what it is built
  with, how many connections touch it.
- **Hover a connector** → both endpoints, the concrete payload that crosses it, when it
  fires, what happens when it fails. Its packets speed up so you can see which line
  you're reading.
- **Sidebar index** of every block under its group, with connection counts. Click to
  fly the camera.
- **Narrative panel** in tabs, with highlighted phrases wired to the blocks. Hover a
  phrase and its block lights up in the drawing, and vice versa.

Controls: drag to pan, scroll to zoom, `Q`/`E` to rotate ninety degrees, `F` to fit,
`L` to toggle labels, `Esc` to clear.

## Layout of this repo

```
PROMPT.md                    the prompt — hand this to the model
PROTOCOL.md                  field reference, shape table, layout notes
schema/codeviz.schema.json   the authority (JSON Schema draft 2020-12)
scripts/validate.mjs         structure + cross-reference + prose checks, 0 deps
scripts/build.mjs            bake JSON into one self-contained HTML
template/index.html          the shell
template/style.css           the chrome
template/renderer.js         the drawing — fixed, never regenerated
vendor/three.module.min.js   pinned r169, checked in on purpose
examples/self.codeviz.json   this repo describing itself
```

## Design notes

**The contract does the enforcing.** Every field has a length limit, every enum is
closed, and `additionalProperties` is false throughout — a misspelled key is an error
rather than data that quietly vanishes. The validator then re-checks by hand the things
a schema cannot see: that both endpoints of every connection resolve, that every
bracketed phrase in the narrative points at a node that exists, that nothing is left
unwired. It also nags about quality — a `payload` of just `"data"` is a warning, a
one-sentence hover detail is a warning, marketing adjectives in the tagline are a
warning. None of those block a build.

**The camera does not orbit.** Orthographic, pinned to the `(1,1,1)` axis — exactly the
classic isometric elevation. Pan, zoom, and ninety-degree snaps are the entire control
set. The moment you can tumble to an arbitrary angle, the thing stops reading as an
engineering drawing and starts reading as a 3D toy.

**No lights.** Faces are flat-coloured to fake the shading, which keeps every edge
crisp at any zoom and makes the render cost trivial. Hatching is drawn procedurally
into canvas textures at startup, so the output carries no image assets.

**Deterministic.** No `Math.random`, no clock-seeded values. Same JSON, same drawing —
so you can edit one node, rebuild, and diff what moved.

**three.js is vendored, not fetched.** Pinned at r169 and embedded in every output as a
base64 data URL inside an import map, which resolves under `file://` where a relative
module import would be blocked by CORS. It costs about 660 KB per file and buys a
deliverable that still renders identically on a laptop with no internet in five years.

## Editing a blueprint by hand

The JSON is the source. If the model got a detail wrong, fix the JSON and rebuild —
it takes under a second. Common manual touches:

- `weight` to emphasise the blocks that matter
- `pos: [col, row]` to move a block the auto-layout put somewhere silly
- `waypoints` to untangle a specific connector
- `status: "dormant"` for code that exists but is not switched on

## Licence

three.js is vendored under its own MIT licence (`vendor/three.LICENSE`).
