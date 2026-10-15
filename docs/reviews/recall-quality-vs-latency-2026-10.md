# Recall: quality vs latency, 2026-10

Review only: no product code changed. The founder's brief (Telegram 7737, 2026-10-14): not a
perfect score that takes 5 minutes, but high scores with lightning-quick recall. This reads the
committed LongMemEval runs and the recall path in `src/`, puts a price in milliseconds and in
score points on every stage, and picks one plan.

It builds on [the 2026-10-13 research](2026-10-13-recall-performance-research.md), which
profiled recall stage by stage and swept candidate changes retrieval-only. That review is
not repeated here. What is new here: every stage's points, taken from the committed runs, a
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
   points**, recall −3 ms.
2. **One job: read only the page, batched lookups** (change 3). Rank-identical by test. Expected
   recall **~6–7 ms p50**, roughly half of today.
3. **One job: the window gate** (change 5). Bench flag first. The reranker ships behind the gate
   only if the gain set shows the coverage gain again, the other questions keep the same rounds,
   and escalated recalls stay ≤ 300 ms p95. If they don't, leave it off: steps 1–2 stand alone.
4. **Then, and only then, re-measure the reader's context** (30 rounds for counting questions):
   diversity may have made the last 10 rounds redundant, which would cut a quarter of the
   largest prompts.

The whole plan keeps **no model in recall except behind the gate, and nothing stored but raw
text**. It aims at **~93.5–94.5% at ~6–7 ms p50**, against today's 92.6% at 11.7 ms. The top of
the field is at 94–95% for about a second per recall.
