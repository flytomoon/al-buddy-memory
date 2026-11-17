# LoCoMo, run against this library

[LoCoMo](https://github.com/snap-research/locomo) (Maharana et al. 2024, arXiv 2402.17753) is the
board every memory vendor quotes: ten long conversations between two people, each 19 to 32
sessions over several months (5,882 turns in all), and 1,986 questions about them. The 1,540 in
categories 1 to 4 are the ones published tables score. The 446 in category 5 are adversarial: they
ask about something the conversation never says, and the right answer is that it was not
mentioned. No published result scores them; this harness reports them **beside** the 1,540, never
inside them.

An independent audit ([`dial481/locomo-audit`](https://github.com/dial481/locomo-audit) at
`9493fb4`) found that 99 of the 1,540 answers in the key are wrong, so the honest ceiling on the
published key is 93.57%. This harness scores every answer twice: against the **published** key, and
against the **corrected** key, which takes the audit's `correct_answer` for those 99 questions
(every audit entry whose `error_type` is not `WRONG_CITATION`; the 57 citation-only entries change
the evidence, not the answer). A question the audit leaves alone keeps its first verdict; one it
corrects is judged again against the corrected answer.

Vendors label the categories differently (the same 282 questions are "multi-hop" in one table and
"single-hop" in another), so results here give each category's **number and size** (4: 841,
1: 282, 2: 321, 3: 96, 5: 446) and no name. Compare by size.

## Run it

```sh
npm ci && npm run build               # the benchmark measures the built package
node bench/locomo/download.mjs        # once: the data and the audit key, each checked by SHA-256
node bench/locomo/run.mjs --expand --conversations 1 --answerer none   # smoke: retrieval only, no model
node bench/locomo/run.mjs --expand --wait-on-limit 60 --resume   # full run: 1,986 questions, about 4,070 model calls
```

Both files go to `bench/locomo/data/`, which git and the npm package leave out (the data is
CC BY-NC 4.0). [`dataset.json`](dataset.json) pins each to a commit and a SHA-256:
`snap-research/locomo` `data/locomo10.json` at `3eb6f2c`
(SHA-256 `79fa87e9…ea698ff4`, the same file the audit verified), and the audit's `errors.json` at
`9493fb4` (SHA-256 `f298ef46…5b5fe55e`). `download.mjs` fetches from those commits only (GitHub's
contents API, then raw.githubusercontent.com) and keeps a file only if its SHA-256 matches;
`run.mjs` checks both again before every run and refuses either if it does not match
(`--allow-unpinned` runs anyway, and the result says so). `run.mjs` also checks every audit entry
against the data (same question, same golden answer, same category) before using it.

### What it costs

The same reader and judge conventions as [`bench/longmemeval`](../longmemeval/README.md#what-it-costs):
the Claude Code CLI in print mode on the subscription it is logged in with, `sonnet` for both by
default, with the API-key and cloud-provider variables removed from its environment by name, no
tools, no saved session, `--safe-mode` and `--strict-mcp-config`. No chat channel's variables reach
it: `TELEGRAM_STATE_DIR` and every other `TELEGRAM_*` name are removed from its environment. No
metered API spend.

A full run is about 4,070 calls: an answer and a verdict for each of the 1,986 questions, and a
second verdict for each of the 99 the audit corrects. A usage limit stops the run once the
questions in flight finish; the same command with `--resume` carries on. With `--wait-on-limit N`
the run instead waits N minutes and carries on by itself from its progress file, up to 12 times
(for a run nobody is watching); `--resume` on a run with no progress yet simply starts it. A question that fails is
recorded with its error, left out of every number and counted in the summary; three failures in a
row stop the run. The last line printed is always `RESULT: …`.

### Flags

| Flag | Default | |
|---|---|---|
| `--conversations N` | all 10 | The first N conversations, in file order. |
| `--categories a,b` | all five | Only these category numbers, e.g. `5` for the adversarial ones. |
| `--retrieval hybrid\|keyword` | `hybrid` | `hybrid` is the library's recall: keywords and on-device vectors, fused. `keyword` needs no model. |
| `--expand` | off | Recall reads the question's time and counting cues. LoCoMo's questions carry no date, so "now" is the date of the conversation's last session. |
| `--top-k N` | `40` | How many recalled turns the reader sees (about what 20 LongMemEval rounds of two turns are). Not tuned. |
| `--recall-pool N` | `100` | How many memories one recall returns, half from each list. |
| `--reading c25\|memos` | `c25` | The answer prompt (below). |
| `--answerer claude\|command:<cmd>\|none` | `claude` | `none` runs retrieval only. |
| `--answer-model`, `--judge-model` | `sonnet` | Passed to the CLI. |
| `--judge claude\|command:<cmd>\|none` | `claude` | |
| `--concurrency N` | `4` | Answers and verdicts in flight. Memory building and recall go one at a time. |
| `--wait-on-limit N` | `0` (stop) | At a usage limit, wait N minutes and carry on, at most 12 times. |
| `--out file.json`, `--resume`, `--fresh`, `--allow-unpinned` | | As in `bench/longmemeval`. |

## What it does

Each conversation goes into a fresh `SqliteMemoryStore(':memory:')` through the public API, one
memory per turn: `"<speaker>: <text>"`, plus `" [shares <caption>]"` when the turn shared a photo
(LoCoMo's own caption; the photos are not used). Both speakers are `UserInput`; each memory is a
`Conversation` valid from its session's date. Nothing is extracted, summarised or rewritten. Every
question of that conversation is then recalled against the same store, one at a time and timed,
and the reader is shown the top `--top-k` turns.

**The reader's prompt** is copied verbatim from the evaluation pipeline the audit pins
(`evaluation/config/prompts.yaml`, SHA-256 `ba4f668e…ba498ee9`, byte-identical to the one the
leaders' tables come from): `c25` is the first `online_api.default` answer prompt (the one [C25],
Chhikara et al. 2025, arXiv 2504.19413, ships), `memos` is `answer_prompt_memos`. Its `{context}` is
**ours**, as every system in that file has its own: a heading naming the two speakers, then one
line per shown turn in conversation order, `[<session date>] <speaker>: <text>`. Neither prompt
tells the reader it may say a thing was not mentioned; the adversarial score is what the reader
does without being told.

**The judge** for categories 1 to 4 is that file's `llm_judge` system and user prompt, verbatim: a
lenient judge ("as long as it touches on the same topic as the gold answer, it should be counted as
CORRECT"), which the audit found accepts 62.81% of deliberately vague wrong answers. Its verdict is
the last `{"label": …}` object it writes; with none, the one of CORRECT and WRONG it holds; a
response with neither or both is an error for that question, never a wrong answer.

**The adversarial questions** have no official grader. Each is graded twice: by LongMemEval's
official abstention judge prompt, verbatim, with an explanation naming the trap answer
(`adversarialExplanation` in [`prompts.mjs`](prompts.mjs)) and LongMemEval's yes/no rule; and by
LoCoMo's own rule from `task_eval/evaluation.py` (the answer contains "not mentioned" or "no
information available").

The tests in [`locomo.test.ts`](locomo.test.ts) pin each copied prompt by SHA-256.

## What a result reports

`bench/results/<date>-locomo-full.json` (every question of the ten conversations, answered and
judged; anything less is `<date>-locomo.json`) holds the commit, every setting, the reader and
judge as the CLI names them, and for every question its recall, the turns shown, the answer, both
verdicts and the tokens. Beside it, the same name with `.summary.json` holds the same header and
summary without the per-question rows, plus `table`: one row per category (4, 1, 2, 3, then the
four together) with its size, how many were judged, and accuracy against the published key and the
corrected one side by side; and category 5 on its own row, `inOverall: false`, by the abstention
judge and the keyword rule. Its `summary`:

- `scored`: accuracy on categories 1 to 4 against the published key and the corrected one, overall
  and per category with its size; `keyChanged` counts the verdicts the corrected key flipped, each
  way.
- `adversarial`: category 5 by the abstention judge and by the keyword rule. Not in `scored`.
- `retrieval`, no model involved: whether the turns the dataset cites as evidence are in the top k
  recall returned (`any@k`, `all@k` for k = 5, 10, 20, 50) and in what the reader was shown
  (`shownAllEvidence`), per category. The dataset's evidence has typos (`D30:05`, `D:11:26`,
  `D8:6; D9:17`); every `D<session>:<turn>` in a string is read, and what names no turn is kept on
  the row as `evidenceUnresolved`. Four questions cite no turn at all and are skipped here.
- `reader.inputTokensPerQuestion`: the input tokens the CLI reports for each answer (including its
  short system prompt), mean, p50 and p95. Published systems quote from about 700 to 36,000.
- `recall`: how long the recall call alone took.

## The smoke run

[`2026-11-17-locomo-retrieval-smoke.json`](../results/2026-11-17-locomo-retrieval-smoke.json):
all 1,986 questions, hybrid recall with `--expand`, top 40 turns, retrieval only (no model call; run
in a sandbox, so its `commit` is null: it ran this harness as first committed). Every evidence turn
was among the 40 shown for 70.6% of the 1,536 scored questions that cite one; by category:
category 4 (841) 85.9%, category 2 (321) 79.4%, category 3 (96; 92 cite a turn) 40.2%, category 1 (282) 24.8%. The 446 adversarial: the turn each one is built on was shown for 81.2%. The low one is category 1 (282), whose questions
cite several turns each: the reader gets all of them for one question in four. Recall took 7.9 ms at p50 and 27.6 ms at p95 (on the sandbox's `node:sqlite` stand-in, not the release build). It says what the
reader will be shown, not what it will answer; that is the full run's job.

## What it does not show

- An answer score until the full run lands; the README's benchmark table gets a LoCoMo row only
  then.
- How this library compares under another reader: published LoCoMo numbers mostly use gpt-4o-mini
  or gpt-4.1-mini, with a gpt-4o-mini judge, and this harness uses Claude for both. The audit's
  point stands: gpt-4.1-mini reading the whole conversation scores 92.62% with no memory system, so
  a LoCoMo number above about 92 is measuring the prompt and the judge.
- Category 3 (96 questions) needs a gap of about 15 points to tell two systems apart (the audit's
  Wilson intervals).
