# Benchmarks

Each one measures one thing, and says what it does not measure. Every run writes one dated JSON
file, carrying the commit it ran, whether the tree was clean, and every setting; a second run on
the same day gets `-2`, then `-3`, and nothing is overwritten.

## Where results go

[`results/`](results/) here holds only the run behind each headline number in the
[README's Benchmarks table](../README.md#benchmarks). Every other run goes to the results folder,
which the runners pick in this order:

1. `$BENCH_RESULTS_DIR`, when set (a relative path is read from the repository root);
2. `../al-buddy-memory-enterprise/bench/results-history`, when that folder exists beside this
   checkout (or, from a git worktree, beside its main checkout): the private run history;
3. `bench/results` here, so a contributor without the private repo still gets their results.

```sh
BENCH_RESULTS_DIR=~/bench-runs node bench/stale-facts/run.mjs --embedder local
```

`--out` still names one file outright. A run in flight keeps its progress (for `--resume`) in
`bench/results/.progress/` in this checkout, which git ignores, wherever the result goes. The
scripts that compare against the published LongMemEval run (`longmemeval/event-study.mjs`,
`longmemeval/ceilings.mjs`) read its official labels from the private history, and say so and stop
before any model call when they cannot find them.

## The harnesses

| | Measures | Model calls |
|---|---|---|
| [`bench.mjs`](bench.mjs), [`bench-vectors.mjs`](bench-vectors.mjs) | Speed and size at 20,000–100,000 facts (the README's "Limits, measured") | none |
| [`longmemeval/`](longmemeval/) | Recall on the public LongMemEval benchmark, scored with its official prompts and metrics | answer + judge per question, on the Claude subscription |
| [`locomo/`](locomo/) | Recall on LoCoMo: the 1,540 scored questions against the published key and the audit-corrected one, the 446 adversarial ones beside them | answer + judge per question (a second verdict for the 99 corrected), on the Claude subscription |
| [`omnimemeval/`](omnimemeval/) | The five OmniMemEval user-memory boards (LoCoMo, LongMemEval, BEAM, HaluMem, PersonaMem v2) through OmniMemEval's own harness, reader and judge, as a contributor-run backend | its shared reader (gpt-4.1-mini) and judge (gpt-4o-mini) over the OpenAI API, metered with a hard spend cap; none in `--dry-run` |
| [`postgres-writes/`](postgres-writes/run.mjs) | What one write costs on the Postgres store as a tenant grows (in-process PGlite); numbers in [docs/POSTGRES.md](../docs/POSTGRES.md#what-a-write-costs) | none |
| [`stale-facts/`](stale-facts/) | When a fact changes, whether recall returns the value true now — and the value true then | none |
| [`memderive/`](memderive/) | Derived state (counts, totals, sets, histories) over facts that change: whether recall returns every event the answer needs, beside plain and stemmed BM25 | none (on-device embedder) |

## Stale facts

Recall benchmarks ask whether a memory can find a fact. They rarely ask whether it finds the fact
that is **still true**. When someone moves from London to Tokyo to Berlin, a memory that only ever
adds holds three answers to "where do I live?", and wording decides which one the assistant
repeats.

[`stale-facts/cases.json`](stale-facts/cases.json) is a small dataset written for this: 22 things
about a person that change over time (home, employer, manager, rent, a release, …) and 2 that do
not, told in the first person, with 27 unrelated facts that share their words. 3 of the changes
include an old fact told late ("back in 2019 I bought a Civic", mentioned after the Tesla). Questions ask where
things stand now, and some ask about a past instant ("what was I driving in early 2023?").

The same statements go into the same store three ways, and the same questions are asked of each:

- **append-only** — every statement an ordinary fact; nothing is ever closed.
- **append-only + freshness** — the same store, recalled with `freshness: 1`, so the most recently
  learned match ranks higher.
- **current-state** — every statement through `recordState(subject, aspect, …)`: a newer state
  closes the one it replaces, and recall returns what is valid at the instant asked.

Every question uses `stateIntent: true`, which adds a ranked list of the states valid at the
instant asked whose declared subject/aspect matches the question: now for a now-question, the
named instant for an as-of one (as-of questions joined it on 2026-11-17; the committed result
below is from before, when only now-questions used it). All questions use content-word and query
expansion.
The local embedder is enabled in the committed result. Scored by identity, not by matching strings: every memory carries the id of the statement it came
from. `stale@1` is the share of questions whose first result is another statement of the same
subject — the answer an assistant would most likely repeat. `current@k`, `stale@k` and `clean@k`
(the true statement in the first k and no other statement of its subject there) look at the first
k. Run it with `npm run build && node bench/stale-facts/run.mjs --embedder local`; the embedder
runs on-device without model API calls. The committed run's numbers, and what they do and do
not say, are in the [README's Benchmarks section](../README.md#benchmarks); every question's
ranking is in its result file.

What it does not show, said plainly:

- It compares the library with itself, with and without invalidation — not with any other system.
- The subject and aspect of each statement come from the dataset. In use, a host model names
  them; this measures what invalidation does once they are named, not how well a model names them.
- An as-of question is handed its instant. In use, a model has to read it from the question.
- The dataset is small and ours. Fork it, add cases that break it, and send them.

## Derived state

Some answers are not stored anywhere: "how many books have I finished this year?", "how much does
Dan still owe me?", "which streaming services am I paying for now?" A reader can work them out only
if recall hands it every event they rest on. [`memderive/cases.json`](memderive/cases.json) is a
small dataset written for this: 36 questions in 6 families (latest value, count, sum, set after adds
and removes, history of states, two latest values combined), over 112 events said by one person
across a year, with 37 near-miss distractors. The run adds real user turns from LongMemEval as
filler (1,500 by default, dated across the same year), so it needs the LongMemEval_S file
(`node bench/longmemeval/download.mjs`) unless you pass `--filler 0`.

The same items go into one store and one BM25 index, and every question is asked of
al-buddy-memory's recall (as the MCP recall tool runs it, and without an embedder) and of Okapi
BM25, plain and with Lucene's stopwords and Porter stemming. `full@k` is the share of questions
with every needed event in the first k. Run it with
`npm run build && node bench/memderive/run.mjs`; no model reads or answers anything.

What it does not show, said plainly:

- It is our dataset, written to test one claim of the MemDerive paper (arXiv 2610.25373) as it was
  described to us. The paper and its data could not be read where this was written, so this is
  not MemDerive. See [docs/research/memderive-2026-10.md](../docs/research/memderive-2026-10.md).
- It scores retrieval. Whether a reader then counts or adds correctly is not measured.
- 36 questions: one question is 2.8 points.
