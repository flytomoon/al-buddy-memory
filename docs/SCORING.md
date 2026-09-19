# How the conformance score works, and how it cannot be gamed

The score answers seven questions about a memory export. Each is 0–100% with the
reason spelled out. This page is the rulebook, so that a low grade is an argument you
can check rather than a verdict you have to take.

## The seven dimensions

| Key | Question | How it is computed |
|---|---|---|
| provenance | Every fact says who asserted it | share of facts with a non-empty provenance label |
| temporal | Every fact says since when it is true | share of facts with a validFrom (or creation) time |
| invalidation | A fact can stop being true without being erased | a trait of the format: `kept` 100%, `expiry-only` 50%, `overwritten`/`deleted` 0%, `unknown` unproven |
| retention | Superseded facts are still there and say what replaced them | 50% for retired facts being present, plus 50% × the share that name a successor; **unproven** when the sample has no retired facts |
| confidence | Every fact says how sure the system is | share of facts with a numeric confidence in [0,1] |
| relationships | Facts relate, and relations have provenance | share of relationships carrying provenance; 0% if there are facts but no relations |
| portability | The export leaves the vendor intact | 34% published schema + 33% lossless round-trip (proven, not claimed, where an importer exists) + 33% one record per fact. The round trip proves the ARTIFACT survives import and re-export; it cannot see a fact the original export left out — that is tested against the stores themselves |

**Grade** = mean of the provable dimensions: A ≥ 90%, B ≥ 75%, C ≥ 50%, D ≥ 25%, else F.

## What "unproven" means

A dimension the sample cannot prove either way (retention, when nothing in the export
has been retired) is reported as unproven and **left out of the mean**. It is never
counted as a failure. If you think your system keeps history, export a sample that
contains a retired fact and the score will show it.

## What is read from the export, and what the adapter declares

Five of the seven dimensions are counted off the records in the file you pasted. Two are
not, and saying which is which is the only thing that keeps "it grades its own homework"
from being a fair hit.

**Read from the export itself** — provenance, temporal, retention, confidence,
relationships. Each is a count over the facts and edges the adapter produced: how many
carry a provenance label, a `validFrom`, a `validTo` and a successor, a confidence in
[0,1], a relation with provenance. A fact with no provenance field scores 0% on
provenance because there is nothing to read, not because of who made it. Change the
sample and these move.

**Declared by whoever wrote the adapter** — invalidation, and two of portability's three
parts:

| Trait | Who decides | Where it is written |
|---|---|---|
| `invalidation` (`kept` / `expiry-only` / `overwritten` / `deleted` / `unknown`) | the adapter author | `adapters.ts:57`, `:95`, `:134` |
| `schema.published` (34% of portability) | the adapter author | `adapters.ts:57`, `:96`, `:135` |
| `itemised` (33% of portability) | the adapter author | `adapters.ts:57`, `:98`, `:137` |
| `roundTrip` (33% of portability) | **executed** where an importer exists; declared otherwise | `adapters.ts:50` |

These are system properties, not sample properties: whether a retired fact survives is a
fact about the store, and no single export can prove it either way. So they are asserted,
with a comment saying why, in one file a reader can check in a minute — and every one of
them appears in the report's own reason line, so a wrong trait is visible in the output
rather than buried in the total.

The round-trip is the one that is genuinely proven rather than claimed: for our portable
format, `proveRoundTrip` imports the artifact into a fresh store, exports it again, and
compares the two canonically (`adapters.ts:20`) — that is a real test, run on your file,
and it fails to `lossy` if it does not hold. For block-style agent files it is declared
`lossless`, and for flat memory records `unknown`, because no importer for those shapes
exists here to run.

**What follows from that.** Our own format scores 100% on invalidation because someone
wrote `invalidation: "kept"`, and the evidence that this is true is not in the scorer —
it is in `src/consolidation.ts` and its tests. If you think a trait is wrong for your
format, that is a one-line PR and the rest of your score does not change with it.

## Why the rest cannot be gamed

- **The reference implementation gets no special path.** Its adapter runs the same
  scorer; its round-trip is proven by importing the artifact and exporting it again.
- **Raising a grade is one field away.** Record who asserted each fact and the
  provenance score goes to 100% for any system. That is the whole point of publishing
  the ruler.

## What the score does not measure

- **Recall quality.** Whether the right facts come back for a query. Those benchmarks
  exist and are saturated; this is not one of them.
- **Truth.** A fact labelled "UserInput" is a fact the store guarantees was labelled
  that way when written and never relabelled. Whether the user was right is the
  agent's problem, as it is everywhere.
- **Scale, latency, cost.** Measured separately; see README "Limits".

## Adding an adapter

An adapter is a function from the raw export to `ConformanceInput` (see
`src/conformance/model.ts`). Write one, add a hand-written fixture in the same shape,
a test asserting each dimension's score, and open a PR. If a shape needs a trait the
model lacks, propose the trait in the PR; the rules above change in the open.
