# Gridwillow skills

Two skills that teach a coding agent to write and maintain `.bp` blueprints.

| skill | when it fires |
|---|---|
| `gridwillow-blueprint` | draw / diagram / map a codebase or infrastructure, or a direct request for a `.bp` |
| `gridwillow-refresh` | a blueprint exists and the code has moved on |

Both are plain `SKILL.md` files with `name` and `description` frontmatter, which
is the format [OMP](https://omp.sh) and Claude Code both use — so one folder
serves either.

```sh
./skills/install.sh          # OMP    -> ~/.omp/agent/skills/
./skills/install.sh claude   # Claude -> ~/.claude/skills/
```

Symlinks, not copies, so `git pull` updates them in place. Restart the agent
afterwards so discovery runs again.

## What they assume

The `bp` binary on `$PATH`:

```sh
cargo install --path crates/gridwillow-cli
```

`gridwillow-blueprint` bundles its own reference material — `reference/language.md`
(the full grammar and shape table) and `reference/voice.md` (prose standards) —
so it works installed globally, with no copy of this repo nearby.

## Why a skill rather than a prompt

`PROMPT.md` at the repo root is the same procedure as one long paste. It still
works, and it is the right thing if you want to read the instructions yourself
before handing them over.

A skill is better when the agent should reach for this without being told: you
say "map this repo out for me" and it loads the language reference, surveys the
tree, traces the call graph, and hands back a `.bp` that compiles — rather than
inventing its own diagram format for the fourth time this week.
