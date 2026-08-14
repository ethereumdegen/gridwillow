---
name: gridwillow-refresh
description: Use when a .bp blueprint already exists and the code has moved on — to check it for drift, or after a refactor, a migration, or a new service. Verifies every claim in the file against the repository and repairs what has gone stale.
---

# Refresh a blueprint

A blueprint that is quietly wrong is worse than no blueprint, because it looks
authoritative. This skill checks an existing `.bp` against the code it claims to
describe and repairs the drift.

Use `gridwillow-blueprint` to write one from scratch; use this one when the file
already exists.

## Start with the machine checks

```sh
bp check <name>.bp
```

Everything it reports is real. Fix the errors first — a file that does not
compile cannot be reasoned about. Then read the warnings; most are right.

`bp check` cannot see whether the file is *true*, which is what the rest of this
is for.

## Then verify the claims, cheapest first

**Paths.** Every `src` entry must still exist. This is the fastest and most
common drift — a rename moves a module and no one updates the drawing.

```sh
grep -oE '^\s*src .*' <name>.bp | tr -s ' ' '\n' | grep -v '^src$' | sort -u
```

Check each with `glob`. A path that has moved usually means the block's `why` is
stale too — look before you just repoint it.

**Payloads.** Every `carry` names something concrete: a function, a type, a
table, a route. Confirm each still exists and still means what the line says.
`lsp` for symbols, `grep` for routes and SQL. A `carry` naming a function that
was deleted is the single most misleading thing a blueprint can contain.

**Facts.** Versions, replica counts, timeouts, schedules, retention windows.
These rot silently. Check them against the manifest, the deployment config, and
the migrations — not against the last blueprint.

**Table and index lists.** Compare `list Tables` against the migrations
directory. New tables are the clearest signal that a subsystem grew and its
`why` no longer covers what it does.

**Environment variables.** Compare `env` against `.env.example`, the compose
file, and the deployment config.

## Then look for what is missing

Drift is rarely only decay; usually something was added.

- New entrypoints, new binaries, new top-level directories since the blueprint's
  `stamp`. `git log --diff-filter=A --name-only` since that point is a fast way
  to see what appeared.
- New services in the compose or deployment files.
- A directory that has grown enough to deserve its own block — or two blocks
  that have collapsed into one thing and should be merged.
- Blocks marked `!planned` that have since shipped, and blocks that are now
  `!dormant`.

Adding a block means checking every connection that should now terminate on it.
This is the step people skip, and it is why refreshed blueprints tend to grow
islands.

## Repair, and keep the prose

The prose is the expensive part. Do not rewrite a `why` that is still true just
because you are editing the block. Change the sentence that is wrong and leave
the rest.

When a subsystem has genuinely changed shape, rewrite the whole `why` properly —
including the closing non-obvious sentence. A half-updated paragraph reads worse
than either version. See `../gridwillow-blueprint/reference/voice.md`.

Update `stamp` to the version or date you verified against. That is what the
next refresh will diff from.

## Check the block count has not drifted either

15–40 is the readable band. A blueprint that has grown to 50 needs leaf blocks
folded into their parents, not a bigger screen. One that has shrunk to 12 has
usually lost detail rather than complexity.

## Finish

```sh
bp check <name>.bp
bp export <name>.bp
```

Then tell the human what actually changed, in a short list — not what you
verified, what moved. "The settlement worker now writes to S3 before the
acquirer, and three tables were added to the ledger" is the useful report.
Mention anything you found in the code that looked wrong rather than merely
undocumented; a blueprint refresh is one of the few times somebody reads a whole
system on purpose.
