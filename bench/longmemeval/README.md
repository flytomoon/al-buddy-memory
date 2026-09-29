# LongMemEval, run against this library

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) is the recall benchmark
people recognise: 500 questions, each with its own chat history of about 50 timestamped sessions
(~115k tokens in `LongMemEval_S`), across six question types — single-session user, assistant and
preference, multi-session, temporal reasoning, knowledge update — plus 30 questions that should
be declined because the history never says.

It measures what a memory **recalls**. It does not measure where a fact came from, whether it is
still true, or whether it survives leaving the vendor: that is what the
[conformance score](../../docs/SCORING.md) and the [stale-fact benchmark](../README.md#stale-facts)
are for. This harness puts a recall number beside them, not in their place.

## Run it

```sh
npm ci && npm run build                      # the benchmark measures the built package
node bench/longmemeval/download.mjs          # once: fetches the data, checks its SHA-256
node bench/longmemeval/run.mjs --limit 50    # smoke run: 50 questions, every type, ~100 model calls
node bench/longmemeval/run.mjs               # full run: 500 questions, ~1,000 model calls
```

The data goes to `bench/longmemeval/data/`, which git ignores; it is never committed or published.
`download.mjs` fetches it from the dataset commit named in [`dataset.json`](dataset.json) and keeps
a file only if its SHA-256 matches the one recorded there. **The first time**, `dataset.json` has no
commit or checksum yet: run `node bench/longmemeval/download.mjs --pin`. It asks the Hugging Face
API which commit `main` is and for the SHA-256 Hugging Face holds for each file, records both, and
downloads against them. Check the change and commit `dataset.json`, and every later download is
verified against it. `run.mjs` checks the file again before every run and refuses one that does not
match (`--allow-unpinned` runs it anyway, and the result says so).

Network: `huggingface.co` for the data and, on the first hybrid run, the 25 MB on-device embedding
model; the Claude Code CLI for answers and judging.

### What it costs

The default answerer and judge are the Claude Code CLI in print mode (`claude -p`), on the Claude
subscription it is logged in with. There is no metered API spend. The CLI is started with
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock, Vertex and Foundry switches removed
from its environment, by name (their values are never read), so it cannot fall back to billing a
key. It is also started with no tools, no saved session, a one-line system prompt in place of the
CLI's own, and `--safe-mode`, so none of your CLAUDE.md files, hooks, MCP servers or plugins join
the conversation.

A run does count against the subscription's usage limits: two calls per question (answer, then
judge). When a limit is hit the run stops once the questions in flight finish, keeps its progress,
and the same command with `--resume` carries on. A question that fails for any other reason after
its retries is recorded with its error, left out of the accuracy, and counted in the summary;
`--resume` retries just those. The result file records the token usage the CLI reports, and what
the same tokens would have cost at API prices (`notionalCostUsd` — not billed on a subscription).

### Flags

| Flag | Default | |
|---|---|---|
| `--limit N` | all 500 | A stratified subset: each question type in turn, in file order. Deterministic. |
| `--types a,b` | all | Only these question types, e.g. `multi-session,knowledge-update`. A name that is not one of the six is refused. |
| `--variant s\|oracle` | `s` | `oracle` holds only the evidence sessions — a ceiling for the reader, not a memory test. |
| `--retrieval hybrid\|keyword` | `hybrid` | `hybrid` is the library's recall: FTS5 keywords and on-device vectors, fused. `keyword` needs no model. |
| `--top-k N` | `20` | How many recalled rounds the reader sees. The official scripts default to 50. |
| `--recall-pool N` | `100` | How many messages recall returns (half from the keyword list, half from the vector list). 100 gives about 60 rounds; more gives `--rerank` more to choose from. |
| `--freshness X` | `0` | `HybridRetriever`'s recency weight. It orders by when a memory was *recorded*, which here is ingestion order, not session date: 211 of the 500 histories are not in date order, so this flag measures little on LongMemEval. `--expand` orders by session date instead. |
| `--rerank none\|minilm\|bge\|<model>` | `none` | Rerank recall with an on-device cross-encoder (`LocalReranker`): `minilm` is `Xenova/ms-marco-MiniLM-L-6-v2` (~23 M parameters), `bge` is `Xenova/bge-reranker-base` (278 M, about ten times slower), or any Hugging Face cross-encoder id. Downloaded once to the transformers.js cache, like the embedder. About 200 question–passage pairs per question (100 messages, long ones in windows); a MiniLM-L6 forward pass managed 12 pairs a second on a machine at load 160, so expect seconds per question on an idle one with `minilm`, and about ten times that with `bge`. |
| `--rerank-dtype fp32\|q8\|…` | `fp32` | The cross-encoder's weights. `q8` is a quarter of the download and faster, at some cost in accuracy. |
| `--expand` | off | Recall with `expand`: the library reads the question's time and counting cues (`analyzeQuery`), resolving "last week" against the question's date. |
| `--aggregate-top-k N` | off | How many rounds the reader sees for a question `analyzeQuery` marks as counting across memories ("how many", "total", "A and B", "which … first"). Other questions still see `--top-k`. |
| `--chain-of-note` | off | Questions marked as counting get the chain-of-note reader: a dated note for every relevant session, then the answer, in the same single call. **Not an official template**; the result file and each row say which reader a question got. |
| `--reading con\|direct` | `con` | The official reader templates; `con` (reason step by step) is the one the LongMemEval README recommends. |
| `--answerer claude\|command:<cmd>\|none` | `claude` | `command:` pipes the prompt into any command (a local model, say) and reads the answer from stdout. `none` runs retrieval only: no model is called. |
| `--answer-model` / `--judge-model` | `sonnet` | Passed to `claude --model`. The model ids that actually answered are recorded. |
| `--judge claude\|command:<cmd>\|none` | `claude` | `none` writes the answers without judging them. |
| `--concurrency N` | `4` | Questions in flight. |
| `--resume` / `--fresh` | | Continue a partial run with identical settings, or discard it. |
| `--claude-bin` | `claude` | The CLI to run. |
| `--out file.json` | `bench/results/<date>-longmemeval.json` | An existing result is never overwritten by the default name (`-2`, `-3`, …). |

## What happens to one question

1. A fresh `SqliteMemoryStore(":memory:")`. Every message of the history goes in through `addNode`:
   the user's words as `UserInput`, the assistant's as `AIInferred`, a `Conversation` valid from its
   session's date. Nothing is extracted, summarised or rewritten, and no model is called to build
   the memory. With `hybrid`, `indexMissingEmbeddings` embeds every message on-device.
2. `HybridRetriever.recall(question, { limit: 100 })` — with `expand: { now: question_date }` under
   `--expand`, and reordered by the cross-encoder under `--rerank`. Each recalled message is
   grouped into its round — a user turn and the turn after it, which is what the official reader
   is shown — and named by the official corpus id of that user turn.
3. The official retrieval metrics are computed on that ranking.
4. The top `--top-k` rounds (`--aggregate-top-k` for a counting question), sorted by date, go into
   the official reader prompt (the chain-of-note one for a counting question under
   `--chain-of-note`); the answerer answers. Beside the official retrieval metrics, each row
   records `shown`: how many of the evidence turns were among the rounds the reader actually saw.
   It is not an official metric, and it is the one that explains most multi-session misses (below).
5. The official judge prompt for the question's type grades the answer; the verdict is correct
   when the reply contains "yes", exactly as the official script decides.

## How it maps to the official protocol

The prompts, the metrics and the averaging are copied from
[github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) at commit
`9e0b455f4ef0e2ab8f2e582289761153549043fc`: the judge prompts from `evaluate_qa.py`, the reader
prompt from `run_generation.py` (with Python's `json.dumps` formatting reproduced), the retrieval
metrics from `eval_utils.py` and `run_retrieval.py`, and the QA averages from `print_qa_metrics.py`.
The tests hold them there: the seven prompt strings to a SHA-256 taken from the Python sources, and
the retrieval metrics to numbers the official `eval_utils.py` produced for 40 random rankings
([`official-metrics.py`](official-metrics.py) regenerates them). Where this run differs, said plainly:

- **The judge is not the official one.** LongMemEval's numbers are judged by `gpt-4o-2024-08-06`;
  this harness uses the same prompts and the same yes/no rule with the Claude model it records.
  Beside every result is `<result>.hypotheses.jsonl`, in the official hypothesis format, so
  `python3 src/evaluation/evaluate_qa.py gpt-4o <that file> longmemeval_s_cleaned.json` in the
  LongMemEval repository re-judges the same answers with the official judge (it needs an OpenAI
  key; this harness never runs it).
- **No temperature or output cap.** The official calls use temperature 0 (and 10 tokens for the
  judge); the CLI exposes neither, so a rerun can differ by a few answers.
- **The reader is Claude**, not one of the paper's readers, and sees 20 rounds by default, not 50.
- **The index holds both sides of the conversation.** The official turn-level retrievers index user
  turns only; this memory holds every message, as a memory would. Rankings are still scored on the
  official user-turn ids: an assistant message counts as its round.
- **No context truncation.** The official reader truncates the history to fit 128k tokens; 20
  rounds never come near it.
- **A `--limit` run is a sample.** Its numbers are not comparable to a full run's, and its
  task-averaged accuracy is over the types it contains.

## Multi-session: where the questions are lost, and the options that go after them

The full run ([result](../results/2026-09-29-longmemeval-full.json)) got 101 of 133 multi-session
questions right (75.9%). Of the 32 it missed, **25 were missing at least one evidence turn from the
20 rounds the reader saw**; 7 were wrong with every piece in front of it. A multi-session question
needs every piece — "how many weddings this year" is wrong if one wedding is missing — and
`recall_any@10` (96%) says nothing about that. So four options, each off by default so a run can
A/B it, and none of which stores anything (they reorder, re-query, show more and re-prompt at read
time over the raw text):

1. **`--rerank`** — a local cross-encoder reads the question with each of the 100 recalled
   messages and reorders them (`LocalReranker`, the library's `reranker` option). Long messages are
   scored in 1,000-character windows, best window wins. Hindsight reports reranking as what took
   its multi-session score from 21% to 80%.
2. **`--expand`** — the library reads the question (`analyzeQuery`, rules, no model call): a
   period ("in April", "the past two weeks", "last Thursday") resolved against the question date
   favours sessions from then, and the question is searched again without it; a counting question
   searches each thing it names ("jogging *and* yoga") from a pool twice as deep; a question longer
   than the sixteen words keyword search reads is searched again by its content words; "currently"
   / "initially" nudge the latest / earliest session up. The question itself is always searched as
   it is without `--expand`, so expanding only adds candidates.
3. **`--aggregate-top-k 40`** — a counting question is shown 40 rounds instead of 20 (the official
   scripts show 50). Its own arm, because it is the one lever measured so far:
4. **`--chain-of-note`** — a counting question gets a reader prompt that asks for one dated note per
   relevant session before any arithmetic, then the answer, in the same single call. Not an
   official template, and the result says so.

Measured without a model (retrieval only, 2026-09-29, every multi-session question the official
retrieval metrics count — 121 of 133): the share of questions where the reader would see **every**
evidence turn, by how many rounds it is shown.

| Rounds shown | 20 | 30 | 40 | 50 |
|---|---|---|---|---|
| Recall as it is (hybrid, 100 messages) | 73.6% | 85.1% | 88.4% | 90.1% |
| An earlier revision of `expand` | 74.4% | 83.5% | 88.4% | 90.1% |

The first row is this code's recall exactly (recall without `expand` is unchanged). The second is
not the committed `expand`: it searched the question by its content words only, and the fix has
not been measured this way yet. Read the table for what it says: 20 rounds leave a
quarter of multi-session questions without all their evidence, and 40 recover most of them;
`expand` has not yet shown a gain at equal rounds, and 100 messages cap everything near 90%
(`--recall-pool` lifts the cap; `--rerank` is what decides whether the extra candidates rise). The
reranker could not be measured here — its model is a download away.

They need the Claude CLI and, for `--rerank`, a one-time download from huggingface.co. Each
multi-session + knowledge-update run is 211 questions, about 420 subscription calls; each full run
is 500 questions, about 1,000:

```sh
npm ci && npm run build && node bench/longmemeval/download.mjs
D=$(date +%F); R=bench/results; T=multi-session,knowledge-update
node bench/longmemeval/run.mjs --types $T                      --out $R/$D-lme-ms-ku-baseline.json
node bench/longmemeval/run.mjs --types $T --rerank minilm      --out $R/$D-lme-ms-ku-rerank.json
node bench/longmemeval/run.mjs --types $T --expand             --out $R/$D-lme-ms-ku-expand.json
node bench/longmemeval/run.mjs --types $T --aggregate-top-k 40 --out $R/$D-lme-ms-ku-top40.json
node bench/longmemeval/run.mjs --types $T --chain-of-note      --out $R/$D-lme-ms-ku-notes.json
node bench/longmemeval/run.mjs --types $T --rerank minilm --expand --aggregate-top-k 40 --chain-of-note --out $R/$D-lme-ms-ku-all.json
node bench/longmemeval/compare.mjs $R/$D-lme-ms-ku-{baseline,rerank,expand,top40,notes,all}.json
# optional: the reranker over twice the candidates
node bench/longmemeval/run.mjs --types $T --rerank minilm --recall-pool 200 --aggregate-top-k 40 --out $R/$D-lme-ms-ku-rerank200.json

node bench/longmemeval/run.mjs --out $R/$D-lme-full-baseline.json
node bench/longmemeval/run.mjs --rerank minilm --expand --aggregate-top-k 40 --chain-of-note --out $R/$D-lme-full-all.json
node bench/longmemeval/compare.mjs $R/$D-lme-full-{baseline,all}.json
```

`compare.mjs` prints accuracy per type side by side, how often the reader saw every evidence turn,
and, per option, the questions it fixed and broke against the baseline. A difference of two or three
questions out of 133 is inside the noise of a CLI that exposes no temperature; the fixed/broken
counts say more than the percentages.

## The result file

`bench/results/<date>-longmemeval.json` holds the commit and whether the tree was clean, the
library version, the dataset file's SHA-256 and whether it matched `dataset.json`, every setting,
the answerer and judge (CLI version, requested model, and every model id that answered, with call
counts), and a summary: overall, task-averaged and per-type accuracy, abstention accuracy, the
official retrieval averages at session and turn level, errors, token usage, and time. Then one row
per question: its retrieval metrics, the rounds the reader saw, the answer, the judge's reply and
the verdict.

`npm test` covers the pieces — dataset handling, the metrics, the prompts, ingestion and recall,
the answerers, the download checks — against the source, with hand-written fixtures. It never
runs the benchmark.
