# al-buddy-memory on OmniMemEval

[OmniMemEval](https://github.com/MemTensor/OmniMemEval) runs every memory backend through one
harness with one reader (`gpt-4.1-mini-2025-04-14`) and one judge (`gpt-4o-mini-2024-07-18`), on
five user-memory boards: LoCoMo, LongMemEval-S, BEAM, PersonaMem v2 and HaluMem. Its tables have
contributor-run rows. This directory contains the adapter and runner for al-buddy-memory.

Pinned to OmniMemEval **`ff13e4a5b12e3c406a81c32bb0834c7e8d73f38e`** (2026-11-17), in `pin.mjs`.

## How it fits together

| Piece | What it does |
|---|---|
| `adapter/al_buddy_client.py` | OmniMemEval's `al_buddy` client: `add`, `search`, `delete` over HTTP to the sidecar (standard library only) |
| `adapter/env.al_buddy`, `adapter/test_al_buddy_client.py` | its env template and offline test, in the harness's own conventions |
| `harness.mjs` | clones the harness, checks out the pin (and refuses any other commit), copies the three files in and patches five registrations: the client registry, the shared search dispatch (`al_buddy_search`, which passes the question's date), LoCoMo's search dispatch (one search per question) and ingestion branch (one store per conversation, photo captions kept), and the libs that take `chat_time`. Every patch is anchored on text that occurs exactly once at the pin; a moved anchor stops it before any file is written |
| `server.mjs` | the sidecar: one `SqliteMemoryStore` file per benchmark user, per board |
| `meter.mjs` | the OpenAI-compatible endpoint every reader and judge call goes through: a ledger per board and model, a hard spend cap, and a stub reader and judge for the dry run |
| `run.mjs` | prepares the harness, starts both, runs each board's own runner script, reads back its grades and the ledger, writes `<date>-omnimemeval[-dry].json` to the results folder ([where results go](../README.md#where-results-go)) |

**Settings a submitted row has to disclose.** Write: every non-empty message is one memory, as
said (`UserInput` for the user's turn, `AIInferred` for an assistant's), valid from its
`chat_time`; nothing is extracted or rewritten and no model is called; memories are embedded on
the device (all-MiniLM-L6-v2). Search: `HybridRetriever.recall` with a pool of 100 and `expand`
read against the question's date (LongMemEval passes one) or else the last date the user's memory
holds; the first `top_k` = 20 come back best first, each as `[YYYY-MM-DD HH:MM] <speaker>: <text>`.
LoCoMo runs in the harness's batch mode (its only mode); the other four in its streaming mode,
one conversation's store at a time, deleted after.

## Running it

```sh
npm ci && npm run build
node bench/omnimemeval/run.mjs --dry-run                    # stub reader and judge, 2 conversations a board, $0
echo 'OPENAI_API_KEY=sk-...' > bench/.env.omnimemeval      # gitignored; read only by the meter
node bench/omnimemeval/run.mjs --max-usd 20                 # the five boards, paid
```

The runner builds a Python venv in the harness from its own `requirements_user_memory.txt`
(Python 3.12 or 3.11, or `uv`), takes LoCoMo and LongMemEval from our pinned, checksummed copies
(`bench/locomo`, `bench/longmemeval`: the same bytes as upstream's), and lets the harness download
BEAM, PersonaMem v2 and HaluMem from Hugging Face; every data file's SHA-256 goes in the result.
`--serve` only prepares and serves, printing each board's harness command, and `--summarize` reads
a finished run back; `--boards`, `--limit`, `--to-step`, `--beam-scale 10m` and
`--halumem-variant long` narrow or widen a run.

**The cap is hard.** Before the meter forwards a call it reserves the call's worst case (every
prompt byte a token, the model's whole output limit) and refuses with HTTP 402 — which the harness
does not retry — any call that would not fit under `--max-usd` beside what is spent and reserved.
`--max-usd` can lower the approved $20, never raise it. The key goes only to the meter; the
harness gets a placeholder. Before each board the runner also skips a board whose expected cost
(×1.25) no longer fits in what is left, so the cap never stops a board part-way. PersonaMem v2 runs
last for that reason. The ledger is the cost: each board's line prints its calls and dollars.

## Expected cost per board

At OpenAI's Standard list prices (gpt-4.1-mini $0.40 / $1.60, gpt-4o-mini $0.15 / $0.60 per
million input / output tokens; not re-checked online from the job that wrote this). Reader prompts
for LoCoMo and LongMemEval are measured (dry run below); the other three are estimates — their data
could not be downloaded in that job — and `boards.mjs` says how each was made.

| Board | Questions | Reader calls | Judge calls | Reader prompt (tokens) | Expected |
|---|---:|---:|---:|---:|---:|
| LoCoMo (categories 1-4) | 1,540 | 1,540 | 1,540 | 1,400, measured | $1.24 |
| LongMemEval-S | 500 | 500 | 500 | 4,500, measured on 2 | $1.04 |
| BEAM 100K | 400 | 400 | ~1,600 (rubric items) | ~5,000, estimate | $1.21 |
| HaluMem medium | 3,467 | 3,467 | 3,467 | ~3,000, estimate | $4.99 |
| PersonaMem v2 | 5,000 | 5,000 | 0 (option matching) | ~4,500, estimate | $9.24 |
| **All five** | 10,907 | | | | **≈ $17.7** |

That is close to the $20 cap. If PersonaMem v2's prompts run longer than estimated, the runner
leaves it unstarted rather than spend on a board it cannot finish; the other four come to about
$8.50.

## Dry run, 2026-11-18

Its result is in the private run history. OmniMemEval's own `run_locomo_eval.sh` and
`run_lme_eval.sh` ran steps 1-3 (ingest, search, answer) on the first 2 conversations against the
sidecar and the stub meter: LoCoMo 233 questions searched and answered (233 success at each stage),
mean reader prompt 1,402 tokens; LongMemEval 2 questions, 4,507. No API call. Owed, because the job
sandbox could not install them or reach the data: the judge, metric and report steps (they need
nltk, rouge-score, bert-score and scipy; the stub judge's reply was checked against the pinned
parsers), and BEAM, PersonaMem v2 and HaluMem (Hugging Face). The paid run does all of it.

**Time.** Ingesting one LongMemEval history (about 500 messages) took about 3 minutes in that
sandbox, under load; the whole run is hours, mostly embedding on the CPU.

Submitting the rows upstream (the adapter, its docs in both languages, and the per-question
records) is a separate, public step, not done here.
