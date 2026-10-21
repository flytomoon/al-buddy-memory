# Derived state vs BM25 (the MemDerive claim), October 2026

Queue item #1429 (founder, Telegram 9146: "test 4, 5, and 6 and give me the results"). Written
2026-10-21.

## Read this first

1. **This is not MemDerive.** The paper (arXiv 2610.25373) could not be read from where this
   was written. arxiv.org, export.arxiv.org, alphaxiv, the Wayback Machine, Semantic Scholar,
   Papers with Code and r.jina.ai are all outside the sandbox's network allowlist. GitHub search
   needs a query string the sandbox refuses, and no `memderive` user or org exists on GitHub.
   The paper is also newer than the model that wrote this. So its tasks, its data and its code
   were all out of reach, and this is **not** a replica of it. It is our own small benchmark of
   the one claim we were given: *memory systems trail BM25 on derived state over evolving data*.
2. **"Tests 4, 5 and 6" could not be identified.** They are presumably the paper's own task
   numbers, and those could not be read. Nothing here is numbered to look like them. The six
   families below have names, not numbers.
   **Recommendation:** put the PDF, or the link to its code, somewhere this repo's jobs can read
   (for example `docs/research/sources/`), and re-queue "map MemDerive tests 4–6 onto
   bench/memderive and re-score". The bench takes new cases without code changes.
3. **No money was spent.** Nothing calls a model: scoring is retrieval-only, and the embedder runs
   on-device (MiniLM). No subscription or metered API was used.

## Result

On 36 derived-state questions, **al-buddy-memory as the MCP recall tool runs it beats both BM25
baselines, and loses no question to either of them at 10 results.**

Seed 1 is the committed run, [`bench/results/2026-10-21-memderive.json`](../../bench/results/2026-10-21-memderive.json).
Seeds 2 and 3 use other samples of 1,500 LongMemEval user turns as filler. Each cell is the number
of questions (of 36) where every event the answer needs is among the first *k* results.

| System | full@5 (seeds 1/2/3) | **full@10** | full@20 | needed events found @10 (seed 1) |
|---|---|---|---|---|
| **al-buddy** (hybrid, `expand`, as the MCP tool) | 6 / 8 / 10 | **14 / 15 / 14** | 20 / 19 / 18 | 60.1% |
| al-buddy-keyword (same recall, no embedder) | 4 / 4 / 4 | 5 / 6 / 5 | 8 / 9 / 9 | 34.2% |
| fts (the store's keyword search: the MCP fallback with no embedder) | 3 / 2 / 3 | 7 / 7 / 7 | 8 / 9 / 9 | 36.8% |
| bm25 (plain Okapi) | 3 / 2 / 3 | 6 / 6 / 6 | 7 / 8 / 8 | 32.9% |
| bm25-stem (Lucene stopwords + Porter: Pyserini's default) | 5 / 7 / 6 | 7 / 7 / 7 | 10 / 10 / 10 | 36.6% |

By family, at 10 results (seed 1), al-buddy / bm25-stem:

- latest value: 6/8 vs 3/8
- count: 1/6 vs 0/6
- sum: 4/6 vs 2/6
- set after adds and removes: 0/6 vs 0/6
- history of states: 2/7 vs 1/7
- two latest values combined: 1/3 vs 1/3

For the 11 questions where an outdated value competes with the current one, the current value
ranks above every value it replaced 3 times out of 11 for al-buddy and 0 out of 11 for bm25-stem.

So does the claim hold for us? **For the shipped path, no.** Vector recall finds the events BM25
cannot reach by words: "Took the red-eye to Boston" for *flights*, "Done reading The Overstory" for
*books finished*. At 10 results, al-buddy wins 7 questions from stemmed BM25 and loses none, on
every seed.

**For our keyword-only paths, partly yes.** The MCP tool falls back to the store's keyword search
when no embedder is configured. That path ties stemmed BM25 on the count at 10, but it loses
specific questions to it on every seed. `HybridRetriever` without an embedder does worse: 5–6
questions against stemmed BM25's 7. Both causes are below.

## Where we lose to BM25, and why

Every loss below shows up on every seed unless it says otherwise. The ranks are 1-based, and "–"
means not in the first 20.

### Loss 1: no stemming in keyword search

Our keyword list matches whole words exactly. The SQLite FTS5 table uses `tokenize = 'unicode61'`
(`src/sqlite-memory-store.ts:252`), Postgres uses `to_tsvector('simple', …)`
(`src/postgres-memory-store.ts:230`), and the in-memory store and the governed visible-match
helpers compare whole words (`src/in-memory-store.ts:166`, `src/query-filter.ts:83`). So a
question in the plural never meets an event in the singular:

| Question | Needed event | fts | bm25-stem | al-buddy |
|---|---|---|---|---|
| therapy-history: "Which **therapists** have I seen?" | "Started seeing a **therapist**, Dr. Kim." | – | 1 | 5 |
| migraines-count: "How many **migraines** …since March?" | 4× "…**migraine**…" | –, –, –, – | 1, 17, 11, 14 | 3, 8, 7, 6 |
| interviews-count: "…have I **interviewed** with?" | "Second-round **interview** with Figma" | – | 5 | – (every seed) |
| flights-count: "How many **flights** …?" | "My **flight** to Austin was delayed" | – | 4 | 10 |
| classes-set: "Which **classes** …?" | "…a Spanish **class** on Monday nights" | – | 19 | – |
| managers-history: "Who have my **managers** been…?" | "My **manager** at Globex is Tom Becker." | – | 10 | 3 |
| practice-now, coach-now (@5): "…soccer **practice**", "Who **coaches**…" | "…now **practices** Wednesday", "…a new **coach**" | 6, 6 | 5, 2 | 5, 2 |

Without an embedder this costs whole questions: therapy-history at 10 on every seed, migraines-count
at 20, and practice-now and coach-now at 5. With the embedder, vectors cover most of it. What is
left is one needed event fewer than stemmed BM25 on interviews-count on every seed (and flights,
classes or team on some seeds). There is also therapy-history at 5 on seed 3: its second event,
"Switched to a new **therapist**", is 6th for al-buddy, and stemmed BM25 had both in its first 5.

**Fix (QUEUE 1):** stem the keyword index, in all three stores at once.
- SQLite: `tokenize = 'porter unicode61'`, which FTS5 has built in. The table has to be rebuilt
  from `memory_nodes.content_text`, because the lean index is contentless and cannot rebuild
  itself; follow the pattern of the lean-index migration at `src/sqlite-memory-store.ts:404`.
- Postgres: the same stems. `'english'` is Snowball (Porter2), and stopwords would make the two
  stores disagree, so stem in JS into the tsvector source, or prove the two agree on the
  conformance corpus.
- In-memory store and `mentionsAny` / `visibleRelevance`: the same stemmer. Otherwise governed
  reads would hide matches that the store found.

Gates: this bench's keyword systems reach stemmed BM25 on the stemming questions; the LongMemEval
50-question gain/break sweeps (`bench/longmemeval/recall-sweep.mjs`, as in 2026-10-18) do not
regress; stale-facts is unchanged; the store conformance spec passes on all three stores.

### Loss 2: `expand` reads "so far", "still", "now" and "last fall" as *give me the latest*

`analyzeQuery` sets `order: "latest"` for any current-time word (`CURRENT` and `LATEST`,
`src/query-cues.ts:257-259`; `order` at `:332`). Recall then adds a list that favours the newest
matching facts, at half a list's weight (`src/hybrid-retriever.ts:239`). For "what is X now", that
helps. For a question whose answer is a total, a set or a history, it is wrong: *all* the events
count, and the cue pushes the older ones out.

- "What has the kitchen remodel cost **so far**?", "How much does Dan **still** owe me?" and "How
  much is in my Japan trip fund **now**?" are all totals.
- "since **last fall**" and "since **last September**" are periods. `LATEST`'s exclusions list
  week, month, year and weekdays, but not months or seasons, so "last fall" matches as "latest".

Measured by running recall again with only that list switched off (a throwaway copy of the built
retriever) and counting needed events in the first 10:

| Question | with the latest list | without it |
|---|---|---|
| dan-sum, keyword-only (seeds 1 and 3) | 3 of 4 | 4 of 4 |
| japan-sum, keyword-only (seed 3) | 3 of 4 | 4 of 4 |
| kitchen-sum, keyword-only (seed 1) | 2 of 3 | 3 of 3 |

These are the losses to stemmed BM25 at 10 for keyword-only recall: kitchen-sum on seed 1 and
japan-sum on seed 3, plus kitchen-sum at 5 on seed 2. They are why `HybridRetriever` without an
embedder (5–6) does worse than the plain store search (7).

With the embedder (seed 1), the same switch-off shows the list costing history and set questions,
though not to BM25:
- cars-history: 1 of 3 needed events in the first 10 without the list, 0 with it
- hair-history: 3 of 3 without, 2 with (so the whole question is lost)
- plants-set: 1 of 4 without, 0 with
- streaming-set: 1 of 5 without, 0 with

It helps once: meds-set gets 3 of 4 with the list and 2 without.

Simply deleting the cue is not the fix. On seed 1, removing it entirely gained one history question
(14 → 15 at 10) but dropped current-value-first from 3/11 to 1/11.

**Fix (QUEUE 2):** keep the latest list for questions about one current value, and skip it when
the question derives across events:
- when `aggregation` is set ("how many", "how much", "total");
- when the question asks for a set or a history ("which … do I have", "what … am I taking", "who
  have … been", "since …");
- when "so far", "to date" or "still" sits in a how-much or how-many question.

Also add months and seasons ("last fall", "last September") to `LATEST`'s exclusions. They are
periods, and the period reader could take them as a window instead.

Gates: this bench's al-buddy and al-buddy-keyword rows; currentFirst on the latest family does not
drop; LongMemEval knowledge-update and temporal-reasoning in the 50-question sweeps do not regress.

### Not a loss to BM25, not queued

- **team-set**, one needed event, seeds 1 and 2: "Priya transferred to the payments **team**" is 10th
  for stemmed BM25 and for keyword-only recall, but 19th for al-buddy on seed 1, because events
  found by both the keyword and the vector list outrank one found by words alone. That is one event on one question, inside the noise. Halving the keyword list's
  weight was measured on LongMemEval on 2026-10-15 and failed, so nothing is queued.
- **japan-sum at 5, seed 2**: al-buddy has the four events at 6, 7, 4 and 5, against stemmed BM25's
  1, 11, 2 and 3. That is one event fewer in the first 5. Its cause was not traced, and it does not
  repeat on seeds 1 or 3.
- **Everyone fails on sets.** No system has the full history of any set question in its first 20.
  The adds and removes rarely share words with the question ("We hired Marco as our product
  designer" for *who is on my team*). Stemming does not help this, and neither does BM25.
- **Current value first** is 3/11 for al-buddy and 0–1/11 for both BM25s. Plain facts carry no
  "replaced by". The library's answer is `recordState`, which closes the old value, and the
  stale-facts bench measures that. This bench stores every event as a plain fact, as the MCP
  `remember` tool does.

## Method

- **Dataset**: [`bench/memderive/cases.json`](../../bench/memderive/cases.json), written by hand on
  2026-10-21. It has one person over one year (2025-09 → 2026-08): 112 events, 37 near-miss
  distractors and 36 questions. Each question lists the events it needs, which is the whole history
  of what it asks about, so a reader given them can always work the answer out. That is strict:
  some answers could be derived from fewer. For latest-value questions, it also lists the values
  each needed event replaced.
- **Filler**: 1,500 distinct user turns of 40–800 characters, drawn from LongMemEval_S
  (pinned SHA-256 matched) with a fixed seed. They are dated evenly across the same year, so time
  cues cannot separate them from the evidence.
- **One store, one index**: every item is a plain fact in `SqliteMemoryStore(':memory:')`, with
  `validFrom` set to when it was said, told in date order and embedded with MiniLM. The BM25 index
  is built over the same texts.
- **Systems**:
  - al-buddy: `HybridRetriever.recall(q, { validAt: now, expand: true })`, as the MCP recall tool
    calls it.
  - al-buddy-keyword: the same with no embedder.
  - fts: `searchNodes`.
  - bm25 / bm25-stem: Okapi, k1 1.2, b 0.75. bm25-stem uses the Porter stemmer
    (`bench/memderive/porter.mjs`, checked against the paper's examples).
- **Score**: `full@k`, all needed events in the first k. Also the share of needed events found,
  and current-value-first. Retrieval only: no model reads or answers.
- **Run**: 180 of 180 recalls succeeded on each seed, about 2.5 minutes each, most of it embedding.
  `npm run build && node bench/memderive/run.mjs` (add `--seed 2` for another filler sample).

### What this cannot say

- It is not the paper's benchmark, its systems or its scoring. The paper's systems may be ones that
  summarise or overwrite (which would lose the events themselves), and we keep raw facts. Our "no"
  is about our recall on our questions.
- One question is 2.8 points. The differences that matter here are question-level and repeat
  across seeds; differences of one or two questions do not.
- Retrieval is necessary, not sufficient: a reader still has to count, add and drop the removed
  items correctly.
- The questions were written by the same team that wrote the code. They were written before any
  run, and none were changed afterwards.

## Steward items

These are written into the commit message as `QUEUE` lines.

- **QUEUE 1 — stemmed keyword search, all stores** (Loss 1). Porter in SQLite FTS5 with an index
  rebuild migration; the same stems for Postgres and the in-memory store; `mentionsAny` and
  `visibleRelevance` agree with them. Gates as above.
- **QUEUE 2 — the latest cue stays off derived questions** (Loss 2). No latest list for
  aggregation, set or history questions; "so far", "to date" and "still" in how-much and how-many
  questions are cumulative; months and seasons after "last" are periods. Gates as above.
- **PARK — re-score against MemDerive itself.** This needs the paper or its code where a job can
  read it (owner action, see "Read this first"). Then map tests 4–6 onto cases and re-run.
