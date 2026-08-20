# Voice

The prose is most of the value. A blueprint whose blocks are labelled correctly
and whose hover cards say nothing is a worse artifact than a whiteboard photo,
because it looks authoritative.

The default register for generated documentation is wrong for this. Correct it
deliberately.

## Who you are writing for

A competent engineer who has never seen this system and has about four minutes.
They can read code. They cannot yet tell which parts matter, which decisions
were forced, and which things will bite them.

Write the way you would explain it to a colleague at a whiteboard, out loud.

## The one test that matters

**Every `why` ends with something the reader would not have guessed from the
name.** That last sentence is the entire reason to open a hover card.

Not guessable:

> Health checks are shallow on purpose: a deep check that touched the ledger
> took the whole pool down in March when a slow query made every instance look
> sick.

Guessable, therefore worthless:

> The load balancer distributes traffic across healthy instances for high
> availability and reliability.

If you cannot find the non-obvious sentence, you have not read enough of the
code yet. Go back rather than padding.

## Register

Short declaratives. Concrete nouns. Say the surprising thing plainly instead of
building up to it. Contractions are fine. Semicolons are fine.

Match this:

> The diagram is a loop because the system is: one archive → pick a parent →
> write a new doctrine → play it → rate it → file it → back to the archive.
> Everything below the loop is the game itself: the Rust engine sits beside it,
> finished and not switched on.

## Never write

- Marketing adjectives: powerful, seamless, robust, scalable, cutting-edge,
  state-of-the-art, best-in-class, enterprise-grade. The checker warns on some
  of these in the tagline; it cannot catch them everywhere.
- "Responsible for", "handles", "manages", "facilitates", "leverages",
  "utilises". Say what it does.
- Bullet lists of features inside a `why`.
- A restatement of the block's own label. `is` on a block called Load Balancer
  should not begin "load balances".
- Hedging you do not mean. "May potentially" is two hedges for no reason.
- Anything you would not say out loud to a colleague.

## Field by field

**`title`** — what the system *is*, not what the repo is called.
`metalcraft-agent` → "The Pod". `payments-platform` → "The Payment Path".

**`tagline`** — one lowercase sentence, no full stop needed. What it does.
`one rust binary that runs an agent as a scoped persona, on a box you own`

**`stat`** — facts a reader could not guess, and that reveal *shape* rather than
size. "582 distinct doctrines" is a stat. "47 source files" is not.

**`is`** — one clause, what it *is*, not what it is for. "the ledger — every
authorisation, capture and refund ever taken", not "handles order persistence".

**`why`** — 2–4 sentences. What it does, roughly how, then the non-obvious
thing. Do not open with "This module".

**connection `carry`** — the concrete thing, written for a human to read:
`INSERT INTO orders (id, cart_id, state, amount_cents)`, `POST /v1/checkout
{cart_id, payment_method}`, `AppContext { SqliteStore, BlobStore, OwnerIdentity }`.

**connection `why`** — when it fires, what it carries, and what failure looks
like. The failure sentence is the one people remember.

> Written before the processor is called, never after. If the process dies
> between the two, the reconciler finds the orphan by its state.

## The narrative panel

Two tabs. The first says what the system does and why it is shaped this way.
The second says how it is built and what was traded away.

Structure that works:

1. `h` — the title again, then a paragraph that gets a stranger oriented in
   three sentences.
2. The organising idea. Every system has one; find it and name it.
3. `note` — a short aside telling the reader how to use the drawing.
4. The rule or invariant the whole thing rests on, and what breaks without it.
5. In the second tab: the dependencies you did not write, the extension seam,
   the determinism or consistency story, and **what is deliberately missing**.

That last section is the most valuable and the most often skipped. Write down
the gaps — no service mesh, no fallback provider, no cross-region reads — with
one clause on why each was cheaper to live with than to run. It stops the next
person having to work out whether it was an oversight.

Close with a paragraph on where the file lives, so a reader who spots something
wrong knows what to edit.

## Links

Use 6–12 `[[phrase|block_id]]` links across the panel. Link the phrase that
names the thing, not a bare noun:

- Good: `[[a named, scoped tool set|persona_store]]`
- Good: `[[the load balancer|ingress]]`
- Weak: `[[it|ingress]]`

Do not link the same block five times. Do not link every block — a panel where
everything is highlighted has highlighted nothing.

## Glossary

Use `{{term}}` for words a competent engineer outside this domain would not
know, and define them in one sentence without jargon. Two or three per blueprint
is plenty. Do not define words the reader obviously knows.
