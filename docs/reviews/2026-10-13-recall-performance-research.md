# Recall: where it can get faster and score higher, 2026-10-13

Research only: no product code changed. The question was where recall can get **both** faster
and higher-scoring, and where the balance lies, given that latency should not go up unless the
score goes up with it.

**Short answer.**

- **Where we stand.** 92.8% (official judge) with 11.7 ms recall is in the band of the best
  published LongMemEval numbers (89–95%). The systems at the top of that band take about a second
  per recall and call an LLM to build their memory. We do neither.
- **Where the points are.** Half of the 37 questions we lose are lost by recall, not the reader:
  18, almost all multi-session and temporal. In a retrieval-only test (no model calls), **picking
  at most one or two rounds per conversation before filling in rank order** put all the evidence
  in front of the reader for 7–8 of those 18, and broke none of 52 sampled questions. It costs
  no recall time. Expected **+0.8 to +1.4 points**.
- **The one change that is both faster and better:** search the question's keywords **without
  its stopwords**. Today the keyword query matches ~445 of ~490 messages. Content words recovered
  4 of the 18, broke none of 28 sampled, and cut recall p50 by **29%**.
- **Where the milliseconds go.** Embedding the question (~37%) and keyword search (~34%). Keyword
  search spends about 5 ms of its 8 turning rows into nodes that cannot make the page. Two
  rank-identical changes (read only the page; one batched lookup instead of 50–300) and the
  stopword change should take recall from **~11.7 to ~6–7 ms p50**, with no score change from the
  first two.
- **What not to do.** The cross-encoder reranker measured **±0 points** (12 questions fixed, 12
  broken) for seconds per recall. LLM query expansion, an ANN index, a deeper candidate pool and a
  stronger time-window weight add time or complexity and no points at our sizes.

Recommended order (§ 4): session-diverse selection; the keyword side; read-only-the-page; a
same-size embedder trial; a top-k vector scan for large stores. One self-contained brief per job
is at the end.

## 1. What the field publishes (checked 2026-10-13)

How this was gathered: the projects' own READMEs and blog posts, read through the GitHub API on
2026-10-13, with star counts taken the same day. arxiv.org, huggingface.co and the vendors' own
sites were not reachable from this session (network allowlist), so every row marked *recalled* is
from memory of the paper or post and has **not** been re-checked against its source. Check those
rows before quoting them.

| System | ★ (2026-10-13) | LongMemEval | LoCoMo | Latency they publish | How they retrieve | Source |
|---|---|---|---|---|---|---|
| **This library** | — | **92.8%** (LME-S, all 500; Claude Sonnet reads, official gpt-4o judge) | not run | **recall 11.7 ms p50 / 33.5 ms p95**, on device, on a laptop at load ~32 | FTS5 BM25 + on-device MiniLM vectors, RRF; rule-based time/counting cues; raw messages, no extraction | [bench/results/README.md](../../bench/results/README.md) |
| Mem0 (`mem0ai/mem0`) | 67,136 | **94.4** (was 67.8) | **92.5** (was 71.4) | **1.09 s p50** (LME), 0.88 s (LoCoMo); 6.8K tokens to the reader | "single-pass ADD-only extraction" (one LLM call per add, nothing overwritten); semantic + BM25 + entity matching fused; time-aware ranking; top-200 retrieval budget | README, "New Memory Algorithm (April 2026)". Managed platform: "proprietary optimizations not available in the open-source SDK". Reader and judge not named in the README |
| Hindsight (`vectorize-io/hindsight`) | 49,292 | **94.6%** (v0.4.19, single-query mode) | **92.0%** | Reranker stage alone: local MiniLM cross-encoder **0.12 s/query at 30 candidates, 0.41 s at 240** | LLM fact extraction and "observations" (consolidation) at write; semantic, BM25, graph and temporal arms fused, then a cross-encoder over up to 300 candidates | Blog 2026-03-23 (Agent Memory Benchmark); blog 2026-09-24 (reranker numbers, measured on LoCoMo); paper arXiv 2512.12818 (Dec 2025). README says its numbers were independently reproduced (Virginia Tech, The Washington Post) |
| MemOS (`MemTensor/MemOS`) | 11,850 | **89.20** | **88.83** | "millisecond-level" async ingestion; no recall latency given | Memory scheduler, hybrid FTS5 + vector in the local plugin | README news item 2026-07-02 |
| Supermemory (`supermemoryai/supermemory`) | 31,204 | Says "#1"; publishes **95% Recall@15** (a retrieval metric, not QA accuracy) with ~720 tokens of context | Says "#1" | "~50 ms user profiles" | Not described in the README | README. By category: knowledge update 99, assistant 100, user 97, multi-session 93, temporal 91, preference 90 (recall) |
| Zep / Graphiti (`getzep/graphiti`, `getzep/zep`) | 31,726 / 4,959 | *recalled:* gpt-4o 60.2% → 71.2% vs full context (Jan 2025 paper) | *recalled:* ~75% in Zep's rebuttal of Mem0's figure | Graphiti README: Zep retrieval "sub-200ms at scale"; *recalled:* ~90% lower response latency than full context | Temporal knowledge graph; semantic + BM25 + graph traversal | Graphiti README (2026-10-13); arXiv 2501.13956 (Jan 2025, recalled) |
| Letta (`letta-ai/letta`) | 25,124 | — | *recalled:* 74.0% (gpt-4o-mini) with plain file search | — | Agent with filesystem tools | Letta blog, Aug 2025 (recalled) |
| Mastra "observational memory" (`mastra-ai/mastra`) | 28,801 | *recalled:* ~94.9% (gpt-5-mini), ~84% (gpt-4o) | — | No retrieval step: observer/reflector models compress history into the context | Compression into context | Mastra post, early 2026 (recalled, low confidence) |
| Memobase (`memodb-io/memobase`) | 2,932 | — | Says SOTA | Profile read < 100 ms; `context` search 500–1,000 ms | User profile + event timeline | README |
| Cognee (`topoteretes/cognee`) | 32,218 | — | — | — | Publishes BEAM only | README |

Also: LongMemEval itself (`xiaowu0162/LongMemEval`) 1,148★; sqlite-vec 8,185★; model2vec 2,240★.

**What to read from it.**

- **The top published LongMemEval numbers sit at 89–95%, and we are inside that band.** Mem0
  94.4, Hindsight 94.6, MemOS 89.2, us 92.8 (official judge). None of these use the same reader,
  and reader and judge move LongMemEval by more than the gaps between systems: the paper's own
  baselines run from ~60% (gpt-4o, full history) to ~90% (oracle). Hindsight's own post says
  judge and answer prompts "can swing accuracy scores by double digits". Treat a 1–2 point
  difference between systems as noise.
- **Everyone above us calls an LLM to build the memory** (Mem0's extraction, Hindsight's
  observations, MemOS's scheduler, Mastra's observer). We call none: raw messages in, recall at
  read time. That is the moat, and it is why our recall is in milliseconds while theirs is in
  seconds: Mem0 publishes 1.09 s p50 and Hindsight's reranker alone takes 0.12–0.41 s. **Our
  latency lead is two orders of magnitude.** Spending it on points is the trade to weigh.
- **Mem0 converged on two of our rules**: "ADD-only … nothing is overwritten" and BM25 fused with
  vectors. Hindsight's reranker post makes our reranker finding from the other side: a MiniLM
  cross-encoder costs 0.12 s at 30 candidates and is the stage it most wants to replace.
- **The reader's context is the second latency axis.** Mem0 hands its reader 6.8K tokens;
  Supermemory says ~720. We hand ours about 76,000 characters (~19K tokens: 20 rounds, 40 for a
  counting question). That is reader time and cost, not recall time. It is where most of
  end-to-end latency lives, and it is the one axis where we are behind.

### Techniques, and what they cost

| Technique | What is reported | What it costs | Source (date; confidence) |
|---|---|---|---|
| Hybrid BM25 + vector, RRF | Usually +1–5 nDCG over either alone; RRF (k=60) is the robust untuned default, and a tuned weighted fusion can beat it with in-domain data | Two lists, one merge | Cormack et al. 2009; Bruch et al., TOIS 2023 (high) |
| Round (turn) granularity | The LongMemEval paper: rounds beat whole sessions as the retrieval value; compressing to extracted facts lost information | None (we already index messages and show rounds) | arXiv 2410.10813 (recalled, medium) |
| Time-aware query expansion | Helps temporal questions only. The paper used an LLM to extract the time range | An LLM call per query, unless done by rules (we do it by rules: `analyzeQuery`) | arXiv 2410.10813 (recalled, medium) |
| Fact-augmented keys | The paper: indexing each round under its text plus LLM-extracted facts raised recall and QA | An LLM call per write; more index | arXiv 2410.10813 (recalled; magnitude low confidence) |
| Cross-encoder rerank, MiniLM-L6 | Hindsight on LoCoMo: recall@1 0.80 at 30 candidates, 0.58 at 240 | **0.12 s / 0.41 s per query** (Hindsight); ours: seconds per question at load (bench README) | Hindsight blog 2026-09-24 (verified) |
| Larger rerankers (bge-reranker-v2-m3 568M, mxbai v2, jina v3 0.6B) | Several nDCG points on BEIR | 0.5–3 s per query on CPU | Vendor model cards (recalled, low on latency) |
| HyDE / LLM multi-query | Helps weak zero-shot retrievers most | One LLM generation per query: hundreds of ms to seconds | Gao et al. 2022 (medium) |
| Newer small embedders | bge-small-en-v1.5 (33M, 384-d) ~51.7 MTEB retrieval vs ~42 for all-MiniLM-L6-v2; snowflake-arctic-embed-xs (22M, 384-d) ~50; EmbeddingGemma-300M, Qwen3-Embedding-0.6B and nomic-embed v1.5/v2 lead the small sizes but are 5–25× larger | Same width (384) and similar time for the first two; the larger ones cost tens of ms per query on CPU, and 5–25× the write-time embedding | MTEB model cards (recalled, medium) |
| Static embeddings (model2vec, static-retrieval-mrl) | ~85–90% of MiniLM's retrieval quality | Sub-millisecond on CPU | HF blog, Jan 2025 (medium) |
| int8 / binary vectors | int8 keeps ~97–99% of retrieval quality; binary ~92–96% (with float rescoring) | 4× / 32× less memory | HF + mixedbread, Mar 2024 (medium-high) |
| HNSW vs flat | Flat is exact; HNSW gives ~95–99% recall | HNSW pays off somewhere between 10k and 100k vectors per index, depending on the budget; it costs RAM and build time | Faiss guidance; sqlite-vec is brute force (medium) |

## 2. Ours, profiled

Three committed full runs, all 500 LongMemEval_S questions, Claude Sonnet reading and judging:
`2026-09-29-longmemeval-full` (no levers), `2026-09-29-lme-full-all` (`--rerank minilm --expand
--aggregate-top-k 40 --chain-of-note`), and `2026-09-30-lme-full-fast` (the same without the
reranker, which is the published number). Everything in this section is computed from those files
unless it says *measured today*.

### Where the points go

The published run (no reranker) lost 37 of 500. For every lost question with evidence on the
user's side, the result row says whether the reader was shown **every** evidence turn. If it was,
the reader lost the question; if it wasn't, recall did.

| Type | n | Lost | Recall lost it (evidence not all shown) | Reader lost it (all shown) | Abstention or no user evidence |
|---|---|---|---|---|---|
| single-session-user | 70 | 0 | 0 | 0 | 0 |
| single-session-preference | 30 | 1 | 1 | 0 | 0 |
| single-session-assistant | 56 | 2 | — | — | 2 (assistant-side evidence, not scored) |
| multi-session | 133 | **24** | **12** | 9 | 3 abstention |
| temporal-reasoning | 133 | 8 | 5 | 3 | 0 |
| knowledge-update | 78 | 2 | 0 | 1 | 1 abstention |
| **All** | 500 | **37** | **18** | **13** | 6 |

So **about half the lost points are recall's to win, and they are almost all multi-session and
temporal.** Reading the 18 questions themselves shows two patterns:

1. **Evidence that never reaches the candidate pool** (12 of the 18 have `recall_all@50 = 0`:
   not every evidence turn is in the first 50 rounds). Most are counting questions whose evidence
   uses other words. "How many different doctors did I visit?" (2 of 5 found), "How many movie
   festivals…" (4 of 6), "How much total money did I spend on attending workshops…" (1 of 4),
   "How many magazine subscriptions do I currently have?" (2 of 3). Showing the reader more rounds
   does not reach them. That is a vocabulary gap: the question says "doctors" and the turn names a
   dermatologist. Keyword search cannot bridge it, and all-MiniLM-L6-v2 bridges it weakly.
2. **A narrow period ranked too low** (3 questions: "last Saturday", "two weeks ago", "on
   Monday"). The evidence *was* in the first 50 rounds but not in the first 20 the reader saw.
   `expand` resolved the period correctly. The obvious suspect, its in-period list weighing the
   same however narrow the period, turned out not to be the cause: a 2× or 3× weight recovered
   only one of them. Session diversity recovered all three (next section).

The 13 reader losses (all evidence shown) are arithmetic and counting slips over 40 rounds of
context. Recall cannot fix those. The levers there are the reader prompt (chain-of-note is already
on for counting questions) and showing *fewer, better* rounds.

### What the existing levers bought

Fixed / broken counts, per question, between the full runs (judge: Claude Sonnet):

| Change | Overall | Right only with it | Right only without it | Recall time | Verdict |
|---|---|---|---|---|---|
| `expand` + `aggregate-top-k 40` + chain-of-note, vs none | 88.4% → 92.6% (**+4.2**) | 28 (14 multi-session, 12 temporal, 2 knowledge-update) | 7 | `expand` adds a few ms: counting questions p50 13.6 ms vs 9.7 ms for plain ones (from the rows) | **Keep.** The best trade we have: +21 questions for single-digit ms. Most of the cost is the reader seeing 40 rounds instead of 20 for counting questions (prompt +63%: mean 46,688 → 76,190 chars) |
| `--rerank minilm` on top of that | 92.6% → 92.6% (**±0**) | 12 (8 multi-session, 3 temporal, 1 preference) | 12 (4 multi-session, 3 temporal, 3 knowledge-update, 1 user, 1 assistant) | Not timed in that run. The bench README measured MiniLM-L6 at 12 pairs/s on a loaded machine, so ~200 pairs is seconds per question; Hindsight publishes 0.12–0.41 s on its hardware | **Leave off** (as today). It reshuffles which questions are right and adds a second model and a 10–40× slower recall |

The official judge agreed with the Claude judge on 497 of 500 answers in the published run, so the
comparisons above are not judge artefacts.

### Where the 11.7 ms goes

From the published run's 500 rows: p50 11.8 ms, p90 26.2, p95 33.5, p99 62.4. That was on an M1
Pro whose 1-minute load averaged 32 during the run, because answering and judging ran beside it.
Recall time follows load: rows at load < 12 have p50 12.3 / p95 29.8, rows at load ≥ 30 have
13.6 / 58.3. It follows `expand`'s extra queries too: counting questions (310 of 500) 13.6 ms p50,
plain questions 9.7. History size barely matters at this scale (396–616 messages; p50 11.1 ms
under 450, 13.0 ms at 550+).

**Measured today.** A stage-by-stage profile of the same recall: 24 stratified questions, each
recalled cold three times (median kept), `expand` on as published. Built from this branch's
commit, SQLite through `node:sqlite` (the sandbox cannot load better-sqlite3's binding; same SQLite
engine), all-MiniLM-L6-v2 from the local model cache. The machine was busier than during the
published run (load 58–130 from other jobs on the same Mac), so every number is about 2.5× the
published one. Read the **shares**.

| Stage | p50 | p95 | Share of p50 | Calls per recall (p50 / p95) |
|---|---|---|---|---|
| Whole `recall` call | 30.1 ms | 62.7 ms | 100% | |
| Embedding the question (and `expand`'s derived queries, one batch) | 11.0 ms | 40.6 ms | **37%** | 1 query / 3 |
| Keyword search (FTS5, BM25) | 10.3 ms | 27.5 ms | **34%** | 2 searches / 4 |
| `getNode` per vector candidate | 3.0 ms | 9.7 ms | 10% | 50 / 300 lookups |
| Reading the vector table (float32 blobs) | 1.7 ms | 6.5 ms | 6% | 1 |
| Cosine scan, fusion, sorting | 1.3 ms | 4.7 ms | 4% | |

The vector side is cheap at this size; the vector table and the scan together are about 10%.
**Two thirds of a recall is embedding the question and keyword search.**

**Keyword search, taken apart** (12 stratified questions, keyword-only stores, median of 7 calls,
load ~39). The question as an FTS5 OR-query matches **445 of ~490 messages**: words like "I",
"did" and "the" are in almost every message. SQLite ranks those by BM25 in **2.5 ms**. But
`searchNodes` reads a candidate pool of `max(10 × limit, 200)` rows (500 for recall's 50, 1,000
for a counting question's 100), which is the whole store here. It turns every row into a node,
re-ranks them in JS, and then may read again to keep the page exact under decay. So
`searchNodes(limit 50)` takes **8.0 ms**, limit 100 7.1 ms, and limit 5 (pool 200) 4.9 ms. About
**5 ms of each keyword search is materialising rows that cannot make the page**, and recall does
at least two.

**Overlapping the embedding with keyword search: no gain measured.** Starting the question's
embedding and running the keyword searches while it computes was no faster: 0.4 ms *slower* at
p50 (best of 3, 24 questions). On a machine with no idle core there is nothing to overlap onto. It might help on an
idle machine, but it is not worth building on today's evidence.

**The vector scan at larger stores** (synthetic 384-d unit vectors, pure JS, median of 15, load
~38). Today's code: cosine with both norms recomputed, an object per row, full sort, then slice.
The alternative: dot product over one flat `Float32Array` (vectors stored normalised, norms
precomputed otherwise), keeping the best k as it goes.

| Vectors | Today | Dot product + top-k | int8 + top-k | int8 top-100 = float top-100 | Memory float32 → int8 |
|---|---|---|---|---|---|
| 500 (LongMemEval) | 0.33 ms | 0.27 ms | 0.27 ms | 99% | 0.7 → 0.2 MB |
| 7,000 (a personal store's size) | 6.4 ms | 3.4 ms | 3.1 ms | 99% | 10.3 → 2.6 MB |
| 20,000 | 22.6 ms | 11.4 ms | 10.8 ms | 100% | 29.3 → 7.3 MB |
| 100,000 | 141.8 ms | **61.1 ms** | 69.8 ms | 100% | 146.5 → 36.6 MB |

The README's measured warm semantic recall at 100,000 facts is 113 ms median, and first-of-session
is 1.6 s, mostly reading 154 MB. So at scale the scan is the warm cost and the read is the cold
cost. int8 does not speed the scan in JS, but it quarters the read and the memory. Random vectors
are a pessimistic case for int8 agreement; real embeddings must be checked before int8 ships (§ 3, row E).

### Which changes put the missing evidence in front of the reader (measured today)

**The test.** Retrieval only, no model calls. For each question: build its memory exactly as the
benchmark does, recall with each variant ("arm"), group into rounds, and ask whether the reader
would see **every** evidence turn at the benchmark's budget (20 rounds, 40 for a counting
question). A question's accuracy can only move when the rounds it is shown move. Arms ran in an
order rotating per question, each with a fresh retriever. Two sets:

- **The 18 lost to retrieval** in the published run. Base reproduces 0 of 18, which confirms the
  harness matches the run.
- **Two stratified samples nobody tuned on**, to catch breakage: 24 questions (first 8 of
  multi-session, temporal-reasoning and knowledge-update), then 28 scored different ones (the
  next 8 of each, plus 2 of each single-session type). An arm that "recovers" lost questions but
  breaks sampled ones is not a gain.

The arms that change what the reader sees (`diverse`, `kwHalf`, `content`, the time-window
weights) were prototyped against a copy of the built retriever or in the harness's round
selection. None is in the library.

| Arm | What it changes | Lost 18: now all shown | Sample 1 (24): fixed / broken | Sample 2 (28): fixed / broken | Recall p50 (sample 2) |
|---|---|---|---|---|---|
| base | as published (`expand`, 100 candidates) | 0 | — | — | 16.0 ms |
| **diverse2** | rounds picked at most 2 per session first, then the rest in rank order | **7** | **+0 / −0** | **+2 / −0** | 0 extra (post-processing) |
| diverse1 | the same, 1 per session first | **8** | not run | **+2 / −0** | 0 extra |
| diverse3 | 3 per session first | 1 | +0 / −0 | not run | 0 extra |
| **kwHalf** | keyword lists fused at half the weight of vector lists | 6 | not run | +2 / −0 | 0 extra |
| **kwHalf + diverse2** | both | **8** | not run | **+3 / −0** | 0 extra |
| **content** | the question's own keyword search by content words (stopwords out), as `expand` already does for its derived queries | 4 | not run | +2 / −0 | **11.4 ms (−29%)** |
| content + diverse2 | both | 6 | not run | +1 / −0 | 12.7 ms |
| pool200 | 200 candidates instead of 100 | 3 | +0 / **−1** | not run | +2–4 ms |
| pool200 + diverse2/3 | both | 4 | +0 / −1 | +2 / −0 | +4 ms |
| window ×2, ×3 | `expand`'s in-period list at 2× / 3× weight | 1 | +0 / −0 | not run | 0 extra |
| no `expand` | | 5 | +0 / **−3** | not run | −50% |
| keyword only | no vectors | 2 | +0 / −2 | not run | **6.9 ms** |
| vector only | no keyword search | 8 | +0 / −2 | not run | −40% |

Recall times are from the busy machine (load 59–130) and each arm was timed once per question, so
read only large differences. `content`'s is large and has a cause: the stopword-free query matches
far fewer messages (§ keyword search above).

**What it says.**

1. **The top of the ranking is crowded by one session.** One relevant conversation contributes
   many rounds, and they push a second or third conversation's single mention below the cut. A
   counting question needs every conversation, so it loses. Taking at most one or two rounds per
   session first recovers 7–8 of the 18. It broke nothing in 52 sampled questions and costs no
   recall time. It is a read-time ordering over raw text: nothing is stored, merged or dropped.
2. **The keyword side is noisy for long natural questions**, because the OR-query is mostly
   stopwords. Vector-only recovers 8 of the 18 but breaks 2 sampled ones, so the keyword list
   matters, just too much. Searching by content words fixes the noise at its source and makes
   recall about a third faster. Halving the keyword weight fixes it at fusion. Both are free.
3. **Five of the 18 are lost to every arm**: "doctors", "magazine subscriptions", "money spent on
   workshops", "how old was I when Alex was born", "the order of three trips". Their evidence is
   not among the 100 candidates at all. Only a better text matcher reaches those: a better
   embedder (§ 3, row F), not more candidates (pool200 recovers 3 and breaks 1).
4. **What does not help**: a deeper pool, a stronger time-window weight (1 of 18; the three
   narrow-period questions are recovered by diversity instead), and dropping `expand`.

**Caveat on size.** 18 + 52 questions is a prototype's evidence, not a result. A recovered
question is one the reader is *shown* all evidence for. The reader then gets ~91% of those right
(the published run's multi-session accuracy when every evidence turn was shown: 96 of 105).
Every job below starts with the free retrieval-only full 500 before it spends a single
subscription call.

## 3. The Pareto table

Deltas are against the published run (92.6% Claude judge / 92.8% official; recall 11.7 / 33.5 ms
at the published run's load). "Score" is the expected change in overall LongMemEval accuracy,
from the recovered questions × 0.91 reader accuracy minus breakage, with the range given by the
samples. **Nothing below has been run end-to-end.** Moat rules: raw text is the source of truth;
never summarise-and-discard; invalidate, never delete.

| # | Change | Score Δ (expected) | Recall p50 / p95 Δ | Memory / disk Δ | Cost | Effort | Moat risk |
|---|---|---|---|---|---|---|---|
| A | **Session-diverse selection** (recall option: at most N memories per conversation first, then rank order) | **+0.8 to +1.4 pts** (7–8 of the 18 shown everything, ≈ 6–7 answers at 0.91; 0 broken in 52; the range allows for breakage at 500) | **0 / 0** | none | none | S–M | none: read-time order over raw text |
| B | **Keyword side: search the question by content words, and/or fuse keyword lists at ½ weight** | **+0.6 to +1.0 alone** (content words 4 of 18, ½ weight 6 of 18); **+0.2 to +0.4 on top of A** (8 vs 7 of 18; +3 vs +2 sampled) | **content words: −3 to −5 ms p50 (−29% measured)**; weight: 0 | none | none | S | none |
| C | **Keyword search reads only the page** (rank in SQL, turn only the page's rows into nodes, keep the decay-exact widening) + **one batched lookup for the vector candidates** | **0** (must be rank-identical) | **−4 to −6 ms p50, −10 ms p95** at LongMemEval size; more at 100k | less garbage | none | M | none |
| D | **Vector scan: flat Float32Array, precomputed norms, top-k selection** | 0 (rank-identical, ties included) | ~0 at LongMemEval; **−3 ms at 7k vectors, −80 ms at 100k** (warm) | none | none | S–M | none (vectors are a disposable cache) |
| E | int8 vectors (with float re-score of the top 2×k) | ~0 (to confirm on real vectors) | ~0 warm; cold first-of-session read ~4× smaller at scale | **−75% vector bytes** (1,536 → 384 + scale per vector; 100k: 147 → 37 MB) | none | M (schema version, backfill) | none: re-index from raw text |
| F | **A better embedder of the same size**: snowflake-arctic-embed-xs (22M, 384-d, same 6-layer shape) first, then bge-small-en-v1.5 (33M, 384-d, 12 layers) | **unknown: the only lever aimed at the 5 lost-to-every-arm questions**; plausible +0.2 to +1.0 | xs: ~0; bge-small: +3 to +6 ms (2× layers) | same width: 0 | none | M (new model id/version → backfill re-embeds every store once) | none: re-index from raw text |
| G | Show fewer rounds when diversity makes them count (counting questions 40 → 30) | 0 to −0.4 (to measure) | 0 recall; **reader prompt −20 to −25%** | none | lowers reader tokens | S | none |
| ✗1 | Cross-encoder reranker (MiniLM, bge) | **±0 measured** (12 fixed / 12 broken) | **+0.1 to +3 s** | +90–1,100 MB model | CPU | — | none |
| ✗2 | LLM query expansion / HyDE / multi-query | unmeasured; our rule-based `expand` already gets +4.2 with the reader levers | **+0.3 to +2 s** and a model call per recall | — | per-call model cost | — | breaks "no model in recall" |
| ✗3 | HNSW / sqlite-vec / any ANN index | 0 at best (approximate) | 0 at 500; at 100k flat + D is ~61 ms | **+index RAM** | — | M–L | none |
| ✗4 | Deeper pool (200 candidates) | **−0.2 to +0.2** (3 recovered, 1 broken) | +2 to +4 ms | — | — | S | none |
| ✗5 | Stronger time-window weight | ~0 (1 of 18) | 0 | — | — | S | none |
| ✗6 | Overlapping question embedding with keyword search | 0 | **0 measured** on a loaded machine | — | — | S | none |
| ✗7 | Static embeddings (model2vec / static-retrieval-mrl) for speed | **negative**: ~85–90% of MiniLM's retrieval quality | −8 to −10 ms | smaller model | — | M | none |
| ✗8 | Large embedders (EmbeddingGemma-300M, Qwen3-Embedding-0.6B, nomic v2) | unknown | **+40 to +150 ms per query**, 10–25× write-time embedding | 2–3× vector width | — | M | none |
| ✗9 | LLM fact extraction or consolidation at write (Mem0, Hindsight style) | the field's top numbers use it; unknown for us | 0 at recall; **a model call per write** | extra derived rows | per-write model cost | L | **high**: derived text beside raw text is allowed, replacing it is not; it also ends "no model builds the memory" |

## 4. Recommendation

**Do, in this order:**

1. **A, session-diverse selection.** The biggest expected gain (+0.8 to +1.4), zero latency, zero
   storage, no moat risk.
2. **B, the keyword side** (content-word search, keyword weight ½; measure each and both, on top
   of A). The only change measured to make recall **both faster and better**.
3. **C, keyword search reads only the page; batched candidate lookups.** Pure speed, provably the
   same answers. Together with B's content words, expected recall **~11.7 → ~6–7 ms p50**.
4. **F, try a same-size embedder** (retrieval-only first). It is the only lever left for the
   questions no ordering can fix. Adopt it only if it recovers lost questions without breaking
   others, and the query embedding stays within 1.5× today's.
5. **D, the scan with top-k selection.** It does nothing at LongMemEval's size, but it halves warm
   semantic recall at 7k–100k facts, where long-lived stores end up (the README's "Limits,
   measured": 113 ms median warm at 100,000).

E (int8) and G (fewer rounds) are worth doing after these: E when stores pass ~50k facts, G once
A has landed and its retrieval-only numbers say 30 rounds hold.

**Do not do: they add latency without points.** The reranker (✗1: measured ±0 for seconds),
LLM query expansion (✗2), an ANN index at our sizes (✗3), a deeper candidate pool (✗4), the large
embedders before F says the embedder is the lever (✗8), and extraction at write (✗9: moat).
Two more were measured and gave nothing: the time-window weight (✗5) and overlapping embedding
with search (✗6).

## 5. How this was measured, and what is still owed

- **Survey:** GitHub API only (READMEs, repository blog files, star counts) on 2026-10-13.
  arxiv.org, huggingface.co and vendor sites were blocked by the session's network allowlist, so
  rows marked *recalled* need checking against their source.
- **Profile and sweeps:** throwaway scripts outside the repository, built on this branch's
  `dist/`, the benchmark's own `ingestHistory` / `recallRounds` / `shownEvidence`, and
  all-MiniLM-L6-v2 from the local model cache. SQLite ran through `node:sqlite` because the
  sandbox cannot load better-sqlite3's native binding. Same engine and the same SQL, but timings
  could differ slightly from better-sqlite3's. The machine was shared with other jobs (load
  38–190), so absolute times are inflated about 2.5×; shares and same-run comparisons are the
  evidence.
- **Not run:** any end-to-end LongMemEval answer (no subscription calls were spent); any newer
  embedder (huggingface.co blocked); any of the changes as library code. The jobs below do that.

## Jobs

Shared conventions for every job:

- Published settings, written `$P` below: `--expand --aggregate-top-k 40 --chain-of-note`.
  Baseline result: `bench/results/2026-09-30-lme-full-fast.json`.
- **Retrieval-only first, and it is free.** `--answerer none --judge none` calls no model and
  records `retrieval.shown` per question. Over all 500 it is **hours of CPU** (every history is
  embedded on device; about 10–50 s a question depending on load), so run it as a `LONG RUN`,
  not in a session.
- **Then a smoke run**, `--limit 50` (stratified, ~100 subscription calls), for both arms.
- **Then a full 500 only for a finalist**, about 1,000 subscription calls and several hours. Put
  it on its own `LONG RUN:` line, and make the command's last line `RESULT: <one sentence>`.
- **Compare with `node bench/longmemeval/compare.mjs <baseline.json> <arm.json>`**: per-type
  accuracy, shown-evidence, and the questions fixed and broken. Two or three questions either way
  is noise.
- **Moat checks for every job:** `node bench/stale-facts/run.mjs` must not move (`current@1`,
  `stale@1`, `clean@k` per strategy, against `bench/results/2026-09-29-stale-facts.json`). Nothing
  may store, merge, rewrite or drop a memory. Everything here happens at read time.

### Job 1: session-diverse selection (A)

**Goal.** More of the conversations a counting question needs reach the reader, at no recall
cost. Prototype: 7 of the 18 lost-to-retrieval questions recovered, 0 of 52 sampled broken.

**Build.** A `diversify` recall option on `HybridRetriever.recall`, off by default:
`{ by: (node) => string | undefined, perGroup: number }`, or a named key (`"session"` reads
`contextualMetadata.session`; fall back to the calendar day of `validFrom` when absent). After
fusion and the time lists, walk the fused order and take at most `perGroup` memories per group,
then append the rest in fused order. The output is a permutation of the input, never a subset.
The prototype capped *rounds* (user turn + reply) per session at 1 or 2. Memories are messages,
so tune `perGroup` at message level: try 2, 3, 4. Add `--diversify N` to `run.mjs` and
`recall-sweep.mjs`, and teach `recall-sweep.mjs` arms that are recall options as well as rerankers
(e.g. `--arm diversify:2`), so one memory build serves several arms. Unit tests: a permutation;
the cap honoured; a memory without the key treated as its own group; off by default leaves recall
unchanged.

**Prove it.**
```sh
npm ci && npm run build
P="--expand --aggregate-top-k 40 --chain-of-note"
node bench/longmemeval/recall-sweep.mjs --expand --aggregate-top-k 40 --limit 50 --arm none --arm diversify:2 --arm diversify:3 --arm diversify:4
node bench/longmemeval/run.mjs --limit 50 $P --out bench/results/$(date +%F)-lme-smoke-base.json
node bench/longmemeval/run.mjs --limit 50 $P --diversify 3 --out bench/results/$(date +%F)-lme-smoke-diversify.json
```
LONG RUN (free, hours): `node bench/longmemeval/run.mjs $P --diversify <best N> --answerer none --judge none`.
Finalist only (subscription, hours): `node bench/longmemeval/run.mjs $P --diversify <N>`.
**Accept** if the retrieval-only run raises shown-all-evidence on multi-session (published: 86.8%)
and breaks nothing net. Switch it on in the shipped server only after the full 500.

### Job 2: the keyword side (B)

**Goal.** The keyword list stops drowning vector hits on long natural questions, and recall gets
faster. Prototype: content-word search 4 of 18 recovered, +2 / −0 on 28 sampled, recall −29%;
keyword lists at ½ weight 6 of 18, +2 / −0; with Job 1's diversity, 8 of 18, +3 / −0.

**Build.** Two independent, opt-in recall options. (1) Search the question's own keyword list by
`keywordsOf(query)` (stopwords out; fall back to the query when nothing is left), in both the plain
and the `expand` path. (2) A `keywordWeight` for keyword lists in the reciprocal-rank fusion
(default 1). Keep `relevanceWeight` counting lists as today, so the time lists keep their scale.
Bench flags `--content-words` and `--keyword-weight X`, plus `recall-sweep.mjs` arms. Tests: an
all-stopword query still finds something; weight 1 and no content-words leave recall unchanged.

**Prove it.** The recall-sweep with arms `none`, `content-words`, `keyword-weight:0.5`, both, and
each with `diversify` if Job 1 has landed, `--limit 50`; then `--limit 50` smoke runs of the best
two against base. LONG RUN retrieval-only for the best; a full 500 only for the finalist. Also
re-run `node bench/stale-facts/run.mjs` and `--embedder local`: content words change keyword
ranking. **Accept** only if shown-all-evidence does not drop on any type, and record recall p50 /
p95 from the sweep.

### Job 3: keyword search reads only the page; batched candidate lookups (C)

**Goal.** The same answers, faster. Today `searchNodes(limit 50)` materialises a
`max(10 × limit, 200)`-row pool (the whole store at LongMemEval size: 445 matches of ~490), and
takes 8 ms where SQLite's BM25 ranking takes 2.5 ms. Each vector candidate is then fetched with
its own `getNode` (50–300 per recall).

**Build.** In `SqliteMemoryStore.searchNodes` (and the Postgres store where the same shape holds),
rank on the narrow columns first (`fts_rank`, `confidence_weight`, `decay_rate`, `created_at`,
`node_id`, enough for `effectiveConfidence` and `compareRecency`). Then turn only the page's rows
into nodes, keeping the decay-exact widening as it is. Add an optional `getNodes(ids)` to the
store interface, one statement per call, and use it in `vectorCandidatesFor` with the same filter
and tie-group rules. **Rank-identical**: a test over the conformance fixtures with decay on and
off asserts the same ids in the same order as before, for limits 1, 5, 50, 100 and paged reads.

**Prove it.** `node bench/longmemeval/recall-sweep.mjs --expand --aggregate-top-k 40 --limit 50 --arm none`
before and after, on the same machine. Compare the two files' recall p50/p95, and diff each
question's shown rounds: they must be identical. Then `node bench/bench.mjs` for keyword recall at 100,000 facts against the README's
"Limits, measured" (30–50 ms median). No LongMemEval answering run is needed: an unchanged
ranking cannot change a score. **Accept** at p50 −3 ms or better at LongMemEval size, with
identical rounds.

### Job 4: a same-size embedder, retrieval-only (F)

**Goal.** Find out whether the embedder is what loses the five questions no ordering recovers
("doctors", "magazine subscriptions", "money spent on workshops", "how old was I when Alex was
born", "the order of three trips"), at no more than 1.5× today's query-embedding time.

**Build.** No change to the default. Make `LocalEmbedder` take a model id, a model version and a
query prefix (bge models want "Represent this sentence for searching relevant passages: " on the
query side only). The pairs to try are `Snowflake/snowflake-arctic-embed-xs` (22M, 384-d, the same
6-layer shape as MiniLM) and `BAAI/bge-small-en-v1.5` (33M, 384-d, 12 layers), both through
their transformers.js ONNX ports. Add `--embedder <id>` to `run.mjs` and `recall-sweep.mjs`. The
`(model, modelVersion, dimensions)` triple already makes a new model a re-index, never a mixed
space.

**Prove it.** recall-sweep `--limit 50` per model, plus the 18 lost questions by id (add `--ids`).
Record `recall_all@50`, shown-all-evidence, and the query-embedding ms. Then LONG RUN
retrieval-only on all 500 for the better one. **Accept** for a full 500 only if it recovers lost
questions without net breakage. Adopting it changes every user's vectors once (a backfill on
first start). Measure that time on a 7k-memory store with `gaugeStore` and put it in the
changelog.

### Job 5: the vector scan with top-k selection (D)

**Goal.** Halve warm semantic recall on large stores with the same answers: measured 141.8 →
61.1 ms at 100,000 vectors and 6.4 → 3.4 ms at 7,000 (synthetic vectors, pure JS).

**Build.** In `HybridRetriever`, keep the cached vectors as one flat `Float32Array` plus a
norm per row (or verify unit length once and use the dot product). Score in one pass and keep the
best candidates with a bounded selection instead of `map` + full `sort`. Keep today's exact
semantics: a version/dimension mismatch is skipped, NaN is never compared, the similarity tie
group at the pool boundary is completed, and ties break by `nodeId`. Tests: identical output to
the current implementation on random stores with forced ties, mismatched versions and scoped
filters.

**Prove it.** `node bench/bench-vectors.mjs <tmp>/vec.db 100000` before and after: the README's
"thereafter" row (113 ms median) should drop by about half. The recall-sweep `--limit 50` must
show identical rounds. No answering run needed.
