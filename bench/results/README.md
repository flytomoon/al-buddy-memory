# Benchmark results

One JSON file per run, written by the runner and never edited by hand:
`<date>-longmemeval.json` (with `<date>-longmemeval.hypotheses.jsonl` beside it, the answers in
LongMemEval's official hypothesis format) and `<date>-stale-facts.json`. A second run on the same
day gets `-2`, then `-3`; nothing is overwritten.

Every file carries the commit it ran and whether the working tree was clean (`dirty`), the library
version, Node, and every setting — for LongMemEval also the dataset file's SHA-256 and the model ids
that answered and judged. A result from a dirty tree, or from a dataset file that did not match
`longmemeval/dataset.json`, says so; quote those with that said.

`.progress/` holds a LongMemEval run in flight (for `--resume`) and is not committed.

## Side by side: 2026-09-29 all levers vs 2026-09-30 without the reranker

Both runs: all 500 LongMemEval_S questions, `--expand --aggregate-top-k 40 --chain-of-note`, Claude
Sonnet answering and judging. The second drops `--rerank minilm`.

| | all levers (`2026-09-29-lme-full-all`) | no reranker (`2026-09-30-lme-full-fast`) |
|---|---|---|
| Overall | 92.6% | 92.6% |
| Task-averaged | 94.3% | 94.4% |
| single-session-user | 98.6% | 100.0% |
| single-session-preference | 100.0% | 96.7% |
| single-session-assistant | 94.6% | 96.4% |
| multi-session | 85.0% | 82.0% |
| temporal-reasoning | 94.0% | 94.0% |
| knowledge-update | 93.6% | 97.4% |
| Recall time (the recall call alone) | not timed | p50 11.7 ms, p95 33.5 ms, max 91.8 ms |

Without the reranker the overall score holds and recall stays far inside a 300 ms budget; the one
type that loses ground is multi-session (−3.0 points).
