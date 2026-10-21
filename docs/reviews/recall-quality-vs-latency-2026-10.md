# Recall: quality vs latency, 2026-10

Review only: no product code changed. The founder's brief (Telegram 7737, 2026-10-14): not a
perfect score that takes 5 minutes, but high scores with lightning-quick recall. This reads the
committed LongMemEval runs and the recall path in `src/`, puts a price in milliseconds and in
score points on every stage, and picks one plan.

Earlier research profiled recall stage by stage and swept candidate changes retrieval-only.
What is new here: every stage's points, taken from the committed runs, a
**gate for escalation** (a cheap test that decides when a slower stage runs) found in the same
data, and a measurement protocol that `--limit 50` can actually resolve.

## The answer in five lines

1. **Recall is already lightning-quick: 11.7 ms p50, 33.5 ms p95** (published run, all 500).
   The minute a benchmark question takes is the reader (a Claude call over 17–34K tokens) and
   embedding the history at write time, not recall. The only way to make *recall* slow is to put
   a model in it (reranker, LLM expansion), and none of those has paid for itself yet.
2. **Of the 4.2 points our levers earn, recall earns 1.2 and the reader's context earns 2.0.**
   `expand` costs ~4.7 ms per extra query it runs; showing 40 rounds instead of 20 to counting
   questions costs no recall time and doubles their reader prompt.
3. **Three changes make recall better and no slower, or faster:** search the question by its
   content words, take at most a few rounds per conversation first, and turn only the page's
   rows into nodes. Together: an expected **+1 to +2 points at ~6–7 ms p50**.
4. **Escalate only on a time window.** The reranker is ±0 when it always runs. Run only on
   questions that name a period (68 of 500), it is **+3 questions (+0.6 points)**, and it raises
   shown-all-evidence on those questions by about 9 points. Everywhere else it breaks more than
   it fixes. `RecallOptions.rerank: false` already lets a caller skip it per recall.
5. **Plain `--limit 50` cannot see any of this.** It holds none of the 18 questions recall loses
   and 3 window questions. Measure on `--limit 50 --types multi-session,temporal-reasoning`
   (6 of the 18, 12 window questions), retrieval-only first, which is free.

**Recommended plan (§ 7):** fast path by default (content words, session diversity, read only
the page), and the reranker only behind the window gate, at depth 30, if its escalated p95 stays
under 300 ms.

## 1. Where the numbers come from

- **Committed runs, all 500 LongMemEval_S questions, Claude Sonnet reading and judging:**
  [`2026-09-29-longmemeval-full`](../../bench/results/2026-09-29-longmemeval-full.json) (no
  levers, 88.4%), [`2026-09-29-lme-full-all`](../../bench/results/2026-09-29-lme-full-all.json)
  (`--expand --aggregate-top-k 40 --chain-of-note --rerank minilm`, 92.6%) and
  [`2026-09-30-lme-full-fast`](../../bench/results/2026-09-30-lme-full-fast.json) (the same
  without the reranker, 92.6%; **92.8% with the official gpt-4o judge**; the published number).
  Only the last one timed recall: 11.7 ms p50, 33.5 ms p95, 91.8 ms max, at an average machine
  load of 32 on an M1 Pro.
- **Stage shares of recall time** are the 2026-10-13 profile (24 questions, `expand` on, median
  of 3 cold recalls), scaled to the published 11.7 ms p50.
- **Everything else is computed today from those three files and the dataset** (no model calls,
  no recall run): which evidence turns each question was shown and at what rank, the cues
  `analyzeQuery` read, the recall time per question, and the labels. Rules used throughout:
  - A question **lost to recall** was answered wrong and not shown every evidence turn
    (18 of the 37 lost). A question **lost by the reader** was shown everything.
  - Shown every evidence turn, the reader is right **96.7%** of the time (n = 390); shown less,
    **37.9%** (n = 29). So a change that newly shows all the evidence is worth ~0.9 of a question,
    and one that hides evidence the reader had costs ~0.6 of one.
  - **Reader noise floor:** in the 81 questions where the no-levers run and the published run
    showed the identical rounds in the identical order, 1 label flipped (1.2%). Over 500
    questions, expect ~6 flips between two runs from the reader alone. Two or three questions
    either way is noise.

## 2. Each stage, in milliseconds and in points

The recall path is `HybridRetriever.recall` ([src/hybrid-retriever.ts](../../src/hybrid-retriever.ts)):
`analyzeQuery` reads cues, every query `expand` derives is embedded in one batch, then each gets
a keyword list (`searchNodes`, FTS5 BM25) and a vector list (a cosine scan over the cached
matrix, then `getNode` per candidate), all fused by reciprocal rank, then the time lists.
Everything after that is the benchmark's reader, listed because it is where most of the points
and nearly all the end-to-end time are.

| Stage | Recall ms (published p50 11.7) | Points it earns | Evidence for the points |
|---|---|---|---|
| `analyzeQuery` (rules, no model) | < 0.1 | gates everything below: 0 by itself | regex over the question |
| Embedding the question(s), one batch | **~4.3** (37%) | the vector side as a whole: **−2 to −4 if removed** (est.) | 10-13 sweep: keyword-only broke 2 of 24 sampled, recovered 2 of 18 lost |
| Keyword search, FTS5 BM25, ≥ 1 per query | **~4.0** (34%); ~60% of it turns rows that cannot make the page into nodes | the keyword side as built: **−3 to +1 if removed**, roughly even on LongMemEval | vector-only recovered 8 of the 18 but broke 2 of 24 sampled |
| `getNode` per vector candidate (50–300) | ~1.2 (10%) | 0 (bookkeeping) | |
| Vector matrix read, cosine scan, fusion, sort | ~1.2 (10%) | part of the vector side | scan is 0.3 ms at 500 vectors; 6.4 ms at 7k; 142 ms at 100k |
| `expand`: each derived query (without its time words; each thing a counting question names), 2× pool when counting | **+4.7 ms per extra query** (p50 9.7 / 14.0 / 18.6 / 24.0 ms at 1 / 2 / 3 / 4 queries); ≈ +2 ms at the overall p50, most of the p95 | **+1.2** (9 fixed, 3 broken) | fixed = all evidence newly in the first 20 rounds; broken = evidence lost |
| `expand`: in-period list, earliest/latest list | ~0 | small: 2× / 3× weight recovered 1 of 18 | 10-13 sweep |
| Cross-encoder rerank, MiniLM-L6, all 100 candidates (off) | **+0.1 to +3 s** (no committed timing; 12 pairs/s at load 160; Hindsight 0.12 s at 30 candidates) | **±0** always on (12 fixed, 12 broken); **+0.6 behind the window gate** (§ 3) | all vs published run |
| Reader: 40 rounds instead of 20 for counting questions (`--aggregate-top-k 40`) | 0 recall; reader input **16.6K → 34K tokens** p50 on 310 of 500 questions | **+2.0** (10 fixed) | every one had its last evidence turn in rounds 21–40 |
| Reader: chain-of-note for counting questions | 0 recall; output 348 → 390 tokens p50 | **+0.8** (8 fixed, 4 broken; near the noise floor) | all evidence shown in both runs, label changed |

The four bold point rows add up to the measured +4.2 (88.4% → 92.6%: 28 fixed, 7 broken, one
abstention fixed). **The cheapest points we have are the reader's context (+2.0 for 0 recall ms);
the most expensive are the reranker's (0 for seconds).** `expand` is a fair trade: +1.2 for
~2 ms at p50.

### What the reader's context costs, round by round

Rounds are where end-to-end latency lives (~2,350 characters each). Reading the published
ranking at a smaller cut-off shows what fewer rounds would cost:

| Cut-off | Counting questions (n = 273 scored) | Plain questions (n = 146) |
|---|---|---|
| Today | 40 rounds: all evidence shown for 254 | 20 rounds: 136 |
| One step fewer | **35**: 3 right answers lose evidence (≈ −0.4 pts), prompt −12% | **15**: 7 (≈ −0.8 pts), prompt −25% |
| Two steps fewer | **30**: 8 (≈ −1.0 pts), prompt −25% | **10**: 15 (≈ −1.8 pts), prompt −50% |
| More | **50**: 4 of the 19 not covered would be (≈ +0.5 pts), prompt +25% | **30**: 3 of the 10 (≈ +0.35 pts), prompt +50% |

So the reader's context is already close to its knee. Trimming it costs points now. It may stop
costing them once session diversity puts more distinct evidence in the first rounds; that is
the order to try it in (§ 7).

## 3. A gate for escalation: the time window

A fast-path-plus-escalation design needs a test that is cheap, needs no model, and flags the
questions where a slow stage pays. The published run shows that `analyzeQuery` already finds
one: **whether the question names a period** ("last Saturday", "in April", "two weeks ago").

| Cue profile (published run) | n | Accuracy | Lost | Lost to recall | Shown all evidence: published → +rerank | Accuracy +rerank | Recall p50 |
|---|---|---|---|---|---|---|---|
| plain | 134 | 97.8% | 3 | 1 | 96.7% → 94.6% | 97.0% | 10.4 ms |
| plain + order | 32 | 93.8% | 2 | 1 | 93.3% → 96.7% | 90.6% | 9.6 ms |
| **plain + window** | 24 | **83.3%** | 4 | 4 | **79.2% → 87.5%** | **91.7%** | 11.6 ms |
| counting | 196 | 93.4% | 13 | 4 | 96.4% → 98.2% | 93.4% | 11.3 ms |
| counting + order | 70 | 95.7% | 3 | 2 | 92.1% → 95.2% | 94.3% | 19.8 ms |
| **counting + window** | 39 | **69.2%** | **12** | 6 | **81.1% → 91.9%** | **74.4%** | 15.3 ms |
| counting + window + order | 5 | 100% | 0 | 0 | 80.0% → 80.0% | 80.0% | 25.4 ms |

- **Window questions are 13.6% of the set and 43% of the losses** (16 of 37), and 10 of the 18
  lost to recall. "Counting + window" is the worst cell in the benchmark: 69.2%.
- **The reranker helps exactly there.** On window questions it fixed 6 and broke 3. On all the
  others it fixed 6 and broke 9. Its evidence coverage, which does not depend on the reader's
  noise, moves the same way: +8 to +11 points on window questions, −2 on plain ones.
- **Gated on the window cue, the reranker takes the run from 92.6% to 93.2%** (+3 questions),
  and it runs on 68 recalls in 500. p50 is untouched, and so is everything up to about p85. p90
  and p95 become the reranker's time. That is why depth and dtype must be measured (§ 5, change 5).
- **Caveat.** That is 9 label flips on 68 questions, from runs on two different days. The
  coverage gain is the sturdier half of the evidence. It must be re-measured before adoption,
  and the protocol below does that without spending a model call first.

A second gate, weaker: **how much the keyword and vector lists agree.** For plain questions,
recall fills its 100 slots from two (sometimes more) top-50 lists, so it returns fewer than 100
memories only when they overlap. With ≥ 10
shared (`memoriesRecalled` ≤ 90), 1 of 101 questions was lost (1%). With fewer shared, 8 of 89
(9%). The overlap costs nothing to count inside `recall`. It is worth logging as a confidence
signal, but no escalation has been tested behind it.

**Session concentration is not a gate.** How many distinct conversations the first 10 rounds
come from does not predict a loss: 4.5–6.5% loss rate at every cut against 7.4% overall. Session
diversity is worth doing for every question (it costs nothing), not as an escalation.

## 4. The Pareto options

Score deltas are against the published 92.6% (Claude judge; 92.8% official). Recall times are at
the published run's load. "est." means projected from the rules in § 1, not run end-to-end.

| Option | LongMemEval | Recall p50 / p95 | Reader prompt | Status |
|---|---|---|---|---|
| Keyword only, no `expand` | ~86–89 (est.) | ~5 ms p50 (est.) | as today | dominated: −4 to −7 points for −7 ms |
| No levers (the 2026-09-29 baseline) | 88.4 (measured) | ~10 ms p50 (not timed; one-query recalls today) | 20 rounds | dominated by today's |
| **Today** (`expand`, 40 rounds and chain-of-note when counting) | **92.6** (measured) | **11.7 / 33.5 ms** | 47K / 95K chars | the published point |
| Today + reranker always on | 92.6 (measured) | +0.1 to +3 s | as today | dominated: same score, 10–250× slower |
| **Fast path**: today + content words + read only the page + session diversity | **~93.5–94.5** (est.) | **~6–7 / ~20 ms** (est.) | as today | recommended, step 1–2 |
| **Fast path + escalate on window**: + MiniLM rerank, depth 30, only when a period is named | **+~0.6** on top (to confirm) | p50 unchanged; p90–p95 = the reranker's time on 14% of recalls | as today | recommended, step 3, if p95 ≤ 300 ms |
| Fast path + 30 rounds when counting | −1.0 now; to re-measure after diversity | as fast path | **−25%** on 62% of questions | later, only if diversity pays for it |
| LLM in recall (query rewriting, HyDE) or LLM extraction at write | unknown; the field's 94–95% use it | **+0.3 to +2 s** per recall, or a model call per write | — | out: breaks "no model in recall" and the raw-text rule |

## 5. The changes with the best points per millisecond

All five are read-time changes over raw text: nothing is stored, merged or dropped. Change 1–4
are briefed in full in the 2026-10-13 review (its Jobs 1–3). Change 5 is new.

| # | Change | Points (est.) | Recall ms | Points per ms |
|---|---|---|---|---|
| 1 | **Search the question's keyword list by its content words** (stopwords out; fall back to the query when nothing is left) | **+0.4 to +0.8** (4 of 18 recovered, 0 of 28 broken) | **−3 to −4 p50** (−29% measured) | **better and faster: dominant** |
| 2 | **Session-diverse selection**: at most N memories per conversation first, then rank order (a permutation, never a subset) | **+0.8 to +1.4** (7–8 of 18, 0 of 52 broken) | 0 | free points |
| 3 | **Keyword search reads only the page; one batched lookup for vector candidates** | 0 (must be rank-identical) | **−4 to −6 p50**, ~−10 p95 | free milliseconds |
| 4 | **Keyword lists fused at ½ weight** | +0.2 to +0.4 on top of 2 | 0 | free points, small |
| 5 | **Reranker only when the question names a period** (MiniLM-L6, q8, depth 30) | **+0.6** (+3 net on 68; coverage +9 pts on them) | 0 at p50; +~0.1–0.4 s on 14% of recalls (to measure) | ~0.01–0.04 pts per mean ms: the only one that buys points with time |

Changes 1 and 3 overlap: content words shrink the keyword match set from ~445 of ~490 messages,
which is most of what change 3 saves. Together the 10-13 review expects **11.7 → ~6–7 ms p50**.

### How to measure each with `run.mjs --limit 50`

**Which 50.** Plain `--limit 50` is the stratified first 50: it holds **0** of the 18 questions
recall loses and 3 window questions, and the published run got 47 of them right. It is the
**breakage check**, not the gain check. `--limit 50 --types multi-session,temporal-reasoning`
holds **6 of the 18**, **12 window questions** and 11 losses. That is the **gain check**.

**What 50 can resolve.** One question is 2 points. The standard error of a 50-question accuracy
is ±3.6 points at 93% and ±5.9 at 78%. Read a `--limit 50` run by **evidence shown and by
question id** (`compare.mjs` prints fixed/broken and same-rounds counts), never by its
percentage. Claim points only from a full 500.

**Order, cheapest first.** Retrieval-only (`--answerer none`) calls no model: it is free and
records `shown` and recall time per question. Spend subscription calls (~100 per run) only on
arms that pass it. Run the baseline on the same machine and commit as the arm, since recall time
follows load.

```sh
npm ci && npm run build
B="--expand --aggregate-top-k 40 --chain-of-note"
GAIN="--limit 50 --types multi-session,temporal-reasoning"
BREAK="--limit 50"
D=$(date +%F); R=bench/results
# baselines, once per commit and machine (retrieval-only, free)
node bench/longmemeval/run.mjs $GAIN  $B --answerer none --out $R/$D-lme50-gain-base.json
node bench/longmemeval/run.mjs $BREAK $B --answerer none --out $R/$D-lme50-break-base.json
```

Then, per change: the same two commands with the change's flag, and
`node bench/longmemeval/compare.mjs <base>.json <arm>.json`. None of these flags exist yet:
each change's job adds its flag to `run.mjs` and `recall-sweep.mjs`. **Pass** means all of:

- shown-all-evidence on the gain set is not lower, and on the break set no question goes from
  shown to not shown;
- recall p50/p95 within the change's row below;
- then the answered `--limit 50` (drop `--answerer none`): fixed ≥ broken on both sets.

| # | Arm flag (to add) | Expect on the gain set (retrieval-only) | Recall time |
|---|---|---|---|
| 1 | `--content-words` | shown-all up ~1–2 questions | p50 −2 ms or better |
| 2 | `--diversify 3` (first try 2, 3, 4 in `recall-sweep.mjs`, where one memory build serves every arm) | shown-all up ~2–3 questions | unchanged (±0.5 ms) |
| 3 | none: run at the commit before and after | `compare.mjs` reports **the same rounds in 50 of 50** on both sets | p50 −3 ms or better |
| 4 | `--keyword-weight 0.5`, with `--diversify` | shown-all up ≥ change 2 alone | unchanged |
| 5 | `--rerank minilm --rerank-dtype q8 --rerank-depth 30 --rerank-when window` (`RecallOptions.rerank` already skips per recall; the flag only passes `rerank: cues.windows.length > 0`) | shown-all up on the 12 window questions; the other 38 have **the same rounds** as base | non-window recalls unchanged; window recalls p95 ≤ **300 ms** (the budget `recall-sweep.mjs --budget-ms` already reports) |

For change 5, time the reranker on its own first, free:
`node bench/longmemeval/recall-sweep.mjs $GAIN --expand --aggregate-top-k 40 --arm none --arm minilm:q8:30 --arm minilm:fp32:30`.
It reranks every question in the sweep, so read only the time and the window questions' rows.

A finalist then gets the free full 500 (`--answerer none`) and, only if that holds, an answered
full 500. Both run for hours, so each goes on a `LONG RUN:` line, not into a session. Every
change must also leave `node bench/stale-facts/run.mjs` unmoved.

## 6. Memory-research ideas: in, out, worth trying

Citations are from memory. arxiv.org and huggingface.co are not reachable from this session,
so none was re-checked today. The 10-13 review's survey has the dated sources.

**Already in.**

| Idea | Source | Where |
|---|---|---|
| Hybrid BM25 + dense retrieval, reciprocal-rank fusion (k = 60) | Cormack et al. 2009 | `HybridRetriever.recall` |
| Rounds (user turn + reply) as the unit read; raw messages, no lossy compression | LongMemEval paper (Wu et al. 2024) | bench ingestion; library stores raw text |
| Time-aware query expansion, by rules instead of an LLM | LongMemEval paper | `expand` (`analyzeQuery` windows) |
| Query decomposition for counting/multi-hop, by rules | multi-query / decomposition RAG | `expand` parts, 2× pool |
| Chain-of-note reading; history as JSON | Yu et al. 2023; LongMemEval paper | bench reader, counting questions |
| Rule-gated adaptive retrieval (spend more on harder questions) | Adaptive-RAG (Jeong et al. 2024) | the counting cue already escalates pool, rounds and reader |
| Bi-temporal validity, invalidate never delete | Zep / Graphiti | `validFrom`, `validAt` |
| ADD-only memory | Mem0 (April 2026 algorithm) | the library's premise |
| Decay of confidence; reinforcement of duplicates | MemoryBank (Ebbinghaus curve) | `decay.ts`, `findDuplicate` / `reinforce` |
| Cross-encoder reranking | MS MARCO cross-encoders | built, **off** (±0 always on) |
| Recency as a fused list | — | `freshness`, built, off by default |

**Worth trying, in order of points per millisecond.**

| Idea | Source | Why here | Cost |
|---|---|---|---|
| Diversity in the result set (MMR's idea, capped per source) | Carbonell & Goldstein 1998 | change 2 | 0 ms |
| Query cleanup before BM25 | standard IR | change 1 | −3 ms |
| Retrieval-evaluator gating: run the slow stage only when a cheap test says the fast one is weak | CRAG (Yan et al. 2024), Adaptive-RAG | change 5, with the window cue as the evaluator; list agreement next | 0 ms when not escalated |
| **Vector pseudo-relevance feedback** (Rocchio: move the query vector toward its top hits, scan again) | Rocchio 1971; dense PRF (ANCE-PRF, 2021) | aims at the vocabulary gap ("doctors" vs "dermatologist") that loses 5 of the 18, with no new model | ~0.3 ms (a second scan, no second embedding); untested, one `recall-sweep` arm |
| Same-size, stronger embedder (arctic-embed-xs, bge-small) | MTEB | the only other lever for those 5 | 0 to +5 ms; a one-time re-embed |
| int8 vectors with float re-score | HF / mixedbread 2024 | memory and cold read at 50k+ facts | 0 at our size |

**Not now.** LLM extraction or consolidation at write (Mem0, Hindsight, A-Mem): the field's top
scores use it, but it adds a model call per write and puts derived text where raw text should be.
LLM query rewriting or HyDE: +0.3–2 s per recall. Graph retrieval (HippoRAG's personalized
PageRank over an entity graph): it needs entity extraction at write, and its gain on
LongMemEval is unknown. Late interaction (ColBERT) and large embedders: 10–25× the write-time
embedding. Prompt compression (LLMLingua): it saves reader tokens but adds a model before the
reader.

## 7. Recommendation: one plan

**Fast by default, slow only when the question names a period.**

1. **One job: content words + session diversity** (changes 1, 2 and 4 as arms). It is the
   only step that raises the score and lowers recall time together. Expected **+1 to +2
   points**, recall −3 ms. *Measured in § 8: content words pass and are kept as an option;
   diversity and the ½ keyword weight fail and are removed.*
2. **One job: read only the page, batched lookups** (change 3). Rank-identical by test. Expected
   recall **~6–7 ms p50**, roughly half of today. *Measured in § 8: the same rounds in 100 of 100
   questions, and faster; done in the same job as step 1.*
3. **One job: the window gate** (change 5). Bench flag first. The reranker ships behind the gate
   only if the gain set shows the coverage gain again, the other questions keep the same rounds,
   and escalated recalls stay ≤ 300 ms p95. If they don't, leave it off: steps 1–2 stand alone.
   *Measured in § 9: the gate leaves every other question untouched, but a window recall takes
   1.5 s at p50 and 2.9–4.0 s at p95 at depth 30, ten times the budget. Left off; the bench flag
   stays.*
4. **Then, and only then, re-measure the reader's context** (30 rounds for counting questions):
   diversity may have made the last 10 rounds redundant, which would cut a quarter of the
   largest prompts.

The whole plan keeps **no model in recall except behind the gate, and nothing stored but raw
text**. It aims at **~93.5–94.5% at ~6–7 ms p50**, against today's 92.6% at 11.7 ms. The top of
the field is at 94–95% for about a second per recall.

## 8. Steps 1–2, measured (2026-10-15, job #1003)

All four changes were built behind options and measured retrieval-only (free, no model call) on
both § 5 sets. **Kept: change 1 (`contentWords`, opt-in) and change 3 (on; rank-identical).
Dropped: change 2 (session diversity) and change 4 (keyword lists at ½ weight).** Each failed
its bar, and neither is in the library any more. Commit `4d72e2e` has both options, so the runs
below can be reproduced from it.

**How.** `recall-sweep.mjs`, not `run.mjs --answerer none`: the same recall and the same
`shown` per question, but every arm reads one memory build, so the arms differ only in recall.
Settings `--expand --aggregate-top-k 40`, as published. A new `build:<dir>` arm recalled with the
commit before this job (`8845101`, compiled) over an exact copy of each memory, with the same ids,
anchors and vectors. The base arm agrees with the published run's shown-all-evidence on **50 of 50**
gain questions and **42 of 42** scored break questions, so the harness reproduces it. Result
files: [`2026-10-15-lme50-gain-sweep.json`](../../bench/results/2026-10-15-lme50-gain-sweep.json),
[`2026-10-15-lme50-break-sweep.json`](../../bench/results/2026-10-15-lme50-break-sweep.json) and
the timing run [`2026-10-15-lme50-gain-timed.json`](../../bench/results/2026-10-15-lme50-gain-timed.json).
SQLite ran through `node:sqlite` (the sandbox cannot load better-sqlite3's binding). **The machine
was far busier than in any earlier run: load 140–440 on 10 cores**, so absolute times are inflated
several-fold. Read the paired differences (the median, over questions, of arm minus base for the
same question). They are steadier than the gap between two p50s.

**Evidence shown.** Questions where the reader would see every evidence turn (gain set: 50
scored; break set: 42 scored, the 8 abstentions have no evidence). "+ / −" counts the questions
against base, by id.

| Arm | Gain: all evidence | + / − | of the 6 lost-to-recall | Break: all evidence | + / − | recall_all@10 gain / break |
|---|---|---|---|---|---|---|
| base (this branch, change 3 in) | 42 | | 0 | 40 | | 0.58 / 0.881 |
| commit before (`8845101`) | 42 | +0 / −0, **same rounds 50 of 50** | 0 | 40 | +0 / −0, **same rounds 50 of 50** | 0.58 / 0.881 |
| **1: content words** | **44** | **+3 / −1** | **2** (gpt4_a56e767c, gpt4_7fce9456) | **40** | **+0 / −0** | **0.68 / 0.905** |
| 4: keyword lists at ½ | 43 | +3 / −2 | 2 | 39 | +0 / **−1** (b46e15ed) | 0.62 / 0.905 |
| 2: diversify, 1 per session | 13 | +0 / −29 | 0 | 19 | +0 / −21 | 0.22 / 0.524 |
| 2: diversify, 2 | 18 | +0 / −24 | 0 | 24 | +0 / −16 | 0.36 / 0.714 |
| 2: diversify, 3 | 24 | +0 / −18 | 0 | 27 | +0 / −13 | 0.46 / 0.762 |
| 2: diversify, 4 | 31 | +0 / −11 | 0 | 31 | +0 / −9 | 0.50 / 0.833 |
| 4 + 2 (½ weight, diversify 2 / 3) | 18 / 24 | | 0 | 24 / 28 | | |
| 1 + 2 (diversify 2) | 19 | | 0 | 23 | | |
| 1 + 4 + 2 (diversify 2 / 3) | 19 / 22 | | 0 | 24 / 28 | | |

**Recall time** (first sweeps, one recall per arm and question):

| | Gain p50 / p95 | Paired wall / CPU vs base | Faster than base in | Break p50 / p95 | Paired wall / CPU vs base | Faster in |
|---|---|---|---|---|---|---|
| commit before | 37.5 / 200 ms | +7.7 / +11.6 ms | — | 26.3 / 88.5 ms | +3.4 / +12.5 ms | — |
| base (change 3) | 29.7 / 139 ms | 0 | 39 of 50 vs before | 21.4 / 89.1 ms | 0 | 32 of 50 vs before |
| content words | 22.3 / 157 ms | −0.6 / −7.2 ms | 25 of 50 | 18.6 / 76.8 ms | −2.6 / −10.5 ms | 32 of 50 |
| content words vs before | | **−10.6 / −26.0 ms** | | | **−5.2 / −24.6 ms** | |

**The timing run** settles what one recall per arm could not. It covers the gain set again, with
the arms that survived the evidence check plus content words with ½ weight, and `--repeat 5`:
each time is the median of 5 recalls per question, in rotating order. The load was 63–420,
207 on average. Its evidence numbers match the first sweep's exactly.

| Gain set, median of 5 | p50 / p95 | Paired wall vs base | Paired CPU vs base | Faster than base in | All evidence (+ / −) |
|---|---|---|---|---|---|
| commit before (`8845101`) | 22.4 / 48.6 ms | +6.5 ms | +14.4 ms | — | 42 (same rounds 50 of 50) |
| **base: change 3** | **15.3 / 31.2 ms** | 0 | 0 | 48 of 50 vs before | 42 |
| **change 1 + 3: content words** | **13.4 / 32.6 ms** | **−2.1 ms** | **−20.6 ms** | 38 of 50 | **44 (+3 / −1)** |
| content words + ½ weight | 12.8 / 40.4 ms | −2.3 ms | −12.8 ms | 43 of 50 | 44 (+5 / **−3**) |
| ½ weight alone | 15.6 / 35.3 ms | 0.0 ms | +0.1 ms | 22 of 50 | 43 (+3 / −2) |

Against the commit before, content words and change 3 together are **−8.1 ms paired (wall) and
−37.8 ms of CPU per recall, faster in 48 of 50 questions, p50 22.4 → 13.4 ms (−40%)**. That is
about the −40 to −50% the 10-13 review expected (11.7 → 6–7 ms), at a load where every number is
inflated.

**Each against its bar (§ 5).**

- **Change 3, keyword search reads only the page + batched lookups: pass.** The same rounds in
  50 of 50 questions on both sets (the bar). Against the commit before: p50 22.4 → 15.3 ms in the
  timing run, paired −6.5 ms wall and −14.4 ms CPU, faster in 48 of 50 (bar: p50 −3 ms or
  better). Also held by test: the
  conformance suite now checks every limited and paged read against the unlimited one on random
  tie-heavy stores, with decay on and off (limits 1–100, cursors at 0, 49 and 120). And a recall
  over a store without `getNodes` returns exactly what one with it does. Postgres was left as it
  is: its search has no candidate pool to trim, and every read there goes through the audit
  callback. It falls back to `getNode`.
- **Change 1, content words: pass, kept as an option (off by default).** Gain set +3 / −1 (bar:
  up about 1–2) and 2 of the 6 lost-to-recall questions recovered. On the break set no question
  goes from shown to not shown (the bar). Recall time on top of change 3, in the timing run:
  p50 15.3 → 13.4 ms, paired −2.1 ms wall and −20.6 ms CPU (bar: −2 ms or better). One recall
  per arm had read −0.6 / −2.6 ms wall: too noisy at this load to decide. It changes the rounds shown in 47 of 50
  gain and 48 of 50 break questions, mostly where the evidence count does not move, so the reader sees a different context
  almost everywhere. That is why it stays opt-in until an answered run says the reader agrees.
- **Change 2, session diversity: fail, removed.** It never raised shown-all-evidence on a single
  question, and it lost 9 to 29 per set at every cap. The prototype's +7 of 18 does not reproduce
  at the message level, and the cause is in the data. A haystack holds about 50 conversations,
  and recall's 100 candidates touch most of them. With a cap of 1, the 40 rounds a counting
  question shows come from 40 different conversations, against 15–18 without the cap (the three
  lost questions checked by hand): each filler
  conversation's best weak match goes ahead of the second and third evidence turns of the
  conversation that holds the answer (0a995998: 3 of 3 evidence turns shown without the cap,
  1 of 3 with it). LongMemEval's evidence is clustered within sessions, not spread one per
  session. The 2026-10-13 prototype capped rounds in the harness, after recall. Whatever it did
  differently, the library option as briefed loses evidence.
- **Change 4, keyword lists at ½ weight: fail, removed.** +3 / −2 on the gain set, and on the break
  set it hides evidence the base showed (b46e15ed, temporal-reasoning). That breaks the "no
  question goes from shown to not shown" rule. On top of content words it adds 2 questions and
  hides 2 more (+5 / −3 against +3 / −1). Content words fix the same noise at its source without
  that cost.

**What this does to the plan.** The fast path is change 1 + change 3. The +0.8 to +1.4 points
expected from diversity (§ 5) are not there, so the step 1–2 expectation drops to change 1's
share: **+0.4 to +0.8 points (est.)**, at **about −40% recall time against the commit before**
(p50 22.4 → 13.4 ms at load ~200; on the published run's machine that would be ~11.7 → ~7 ms,
est.). Step 3 (the window gate) is unaffected, and so is step 4. Step 4 was to
re-measure the reader's context "once diversity puts more distinct evidence in the first rounds",
and that premise is gone, so it needs content words' full-500 numbers instead.

**Still owed.** (a) The free full 500 for content words, on the `LONG RUN:` line of this job's
last commit: `recall-sweep.mjs` over all 500 with arms `none` and `content-words`. (b) Only if (a)
holds, the answered `--limit 50` on both sets (about 200 subscription calls), then an answered
full 500, before `contentWords` is switched on in the shipped server. (c) `node bench/bench.mjs`
for keyword recall at 100,000 facts against the README's "Limits, measured", which change 3
should lower. It was not run here: the README's numbers come from a quiet machine, and this one
was at load 300.

## 9. Step 3, the window gate, measured (2026-10-15, job #1004)

**Verdict: not shipped.** The gate does what it should for every other question: the same rounds,
the same time. But a recall that runs the reranker takes **1.5 s at p50 and 2.9–4.0 s at p95**,
against a 300 ms budget. None of the 68 came in under budget; the fastest took 879 ms. The library
does not change: no reranker is on by default, and none is switched on. Steps 1–2 stand alone.
The bench now has the gate, so the real model can be measured
without new code (the `LONG RUN` below).

**What was built (bench only).** `run.mjs --rerank-when window` lets the cross-encoder read only
questions that name a period (`analyzeQuery`'s windows, read against the question's date). Every
other question recalls with `rerank: false`, exactly as with no reranker. `recall-sweep.mjs` takes
it as a `:window` suffix on an arm (`minilm:q8:30:window`). It holds such an arm to this step's
bar against the same arm without the cross-encoder, as `windowGateCheck` in `metrics.mjs`:
window recalls p95 ≤ `--budget-ms`, more window questions newly shown every evidence turn than
no longer, and every other question with the same rounds and no slower (paired median ≤ 1 ms).
The verdict is its `RESULT:` line. No library option was added: `RecallOptions.rerank` already
skips the reranker per recall, and there is nothing to ship behind the gate yet.

**How, and the one substitution.** `Xenova/ms-marco-MiniLM-L-6-v2` could not be downloaded in the
session that ran this (huggingface.co is blocked there). The cached `Xenova/all-MiniLM-L6-v2` has
the **identical encoder**: BERT, 6 layers, hidden size 384, 12 heads, feed-forward 1,536, 512
positions, the same uncased vocabulary. The cross-encoder only adds a 384-to-1 head on top. So
the same question–passage pairs, tokenized and batched (16 at a time) as `LocalReranker` does,
cost the same forward passes. Its scores are meaningless, so this measures **time** and the
**other questions' rounds**, not evidence gained. The sweep ran on 68 + 38 questions: every one
of the 500 that names a period (68), and the 38 gain-set questions that do not. Four arms each
recalled from one memory build: `none`, the gated stand-in at depth 30, `content-words`, and
`content-words` with the gated stand-in. Each time is the median of 3 recalls, `--expand
--aggregate-top-k 40`, fp32 (q8 is not cached). Load 28–279, p50 80, on 10 cores. File:
[`2026-10-15-lme-window-gate-standin.json`](../../bench/results/2026-10-15-lme-window-gate-standin.json).

| Gated arm (depth 30, fp32) | Window recall p50 / p95 / max | Without the reranker | Pairs scored p50 (range) | Within 300 ms | Other questions: same rounds | Paired time, other |
|---|---|---|---|---|---|---|
| none + gate | **1,527 / 4,021 / 7,330 ms** | 20.3 / 48.4 ms | 55 (37–88) | **0 of 68** | **38 of 38**, 0 pairs scored | **+0.4 ms** |
| content words + gate (the fast path) | **1,569 / 2,880 / 6,618 ms** | 16.3 / 54.1 ms | 54 (37–89) | **0 of 68** | **38 of 38**, 0 pairs scored | **−0.1 ms** |

**Against the bar (§ 5, change 5).**

- **Window recalls p95 ≤ 300 ms: fail, by 10–13×.** Even at load under 40, close to the published
  run's 32, the 7 recalls timed there took 1,396 ms p50 and 1,988 ms p95.
- **Non-window recalls unchanged: pass.** The same rounds in 38 of 38 questions, the reranker
  read nothing, and the paired median moved +0.4 / −0.1 ms, which is noise. This holds by
  construction (`rerank: false` skips the whole branch), and a test holds it in
  `runner.test.ts`: the same memory, recalled with and without the gated reranker, gives the
  same rounds in the same order.
- **Coverage gain on the window questions: not measured.** It needs the real model's scores.
  § 3's +8 to +11 points came from the committed 2026-09-29 run (all 100 candidates, fp32).

**Why it is slow, and why no setting rescues it.** The 30 candidates are LongMemEval messages,
and an assistant reply runs to thousands of characters. `rerankTexts` scores each in
1,000-character windows, so 30 candidates make **37–89 pairs** of ~300 tokens each. A pair costs
**~27 ms** here (p50; 18 ms at best). That is ~7 GFLOP of encoder per pair, so roughly
0.4 TFLOP per recall and **6.6 s of CPU** across onnxruntime's threads. The 300 ms budget buys
about **11 pairs**: depth 6 as messages are windowed, or 11 at one window each. The README's "Reranking only the top
20 changes almost nothing the reader sees" applies there: below the 20 rounds the reader is
shown, the cross-encoder only reorders what is shown anyway. Depth 30 with the first window
only is still ~30 pairs, ~800 ms. q8 weights typically run 1.5–3× faster on CPU (not measured
here), which would leave the p95 at ~1–2 s. **The 0.12 s that § 2 quoted from Hindsight does
not carry over:** Hindsight reranks extracted facts, a sentence or two each, not raw turns
(from memory, not re-checked today).

**What this does to the plan.** The plan's slow path is out at this budget. The fast path (§ 8)
is the plan: change 3 on, content words pending its full-500 run. Two leads remain, neither
tested:

- **A much smaller cross-encoder:** a 2-layer, 128-wide MS MARCO TinyBERT is ~20× less
  encoder compute per pair on paper (~1.5 ms). That would put 55 pairs near 100 ms, before
  the fixed cost of each call. First check that an ONNX
  build exists for transformers.js, then add it as a sweep arm by its Hugging Face id. Its
  quality is lower, so it must win the coverage check on its own.
- **Spending the budget on window questions without a model:** they are 43% of the losses (§ 3).
  `expand`'s in-period list is one fused list today, and its 2× / 3× weight recovered 1 of 18
  in the 2026-10-13 sweep. It is free to sweep further.

**Still owed.** The real model's time and coverage, on the gain set, with q8 and fp32. That is the
`LONG RUN:` of this job's commit, which needs the one-time download this session could not do:

```sh
npm run build && node bench/longmemeval/recall-sweep.mjs --limit 50 --types multi-session,temporal-reasoning \
  --expand --aggregate-top-k 40 --arm none --arm minilm:fp32:30:window --arm minilm:q8:30:window \
  --arm content-words --arm content-words+minilm:q8:30:window --repeat 3 --resume \
  --out bench/results/2026-10-15-lme50-gain-window-gate.json
```

Its `RESULT:` is the fast path plus the q8 gate against the fast path, PASS or FAIL with the
checks it failed. If it unexpectedly passes the time check (q8 on a quiet machine), the coverage
check decides. Shipping then still needs a library option (`HybridRetriever`'s `rerankWhen`) and
a reranker configured in the server, a job of its own. On the evidence above, expect FAIL on
`windowP95`.
