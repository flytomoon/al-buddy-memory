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
