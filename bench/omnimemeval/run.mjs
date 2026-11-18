#!/usr/bin/env node
/**
 * al-buddy-memory on OmniMemEval's five user-memory boards, with OmniMemEval's
 * own harness (pinned; `pin.mjs`), reader (gpt-4.1-mini) and judge
 * (gpt-4o-mini).
 *
 * It prepares the harness (`harness.mjs`), starts our sidecar (`server.mjs`:
 * one fresh SqliteMemoryStore per conversation, hybrid recall) and the
 * metering proxy every reader and judge call goes through (`meter.mjs`:
 * prices each call, hard spend cap), then runs each board's own runner
 * script and reads back its grades, the proxy's ledger and its cost.
 *
 *   node bench/omnimemeval/run.mjs --dry-run            # stub reader and judge, 2 conversations a board, no API call
 *   node bench/omnimemeval/run.mjs --max-usd 20         # the paid run: OPENAI_API_KEY from bench/.env.omnimemeval
 *
 * `--serve` only prepares and serves (writes one env file per board and
 * prints the harness commands), for running the boards by hand; `--summarize`
 * only reads a finished run's results and ledger back.
 *
 * The key is read from `--env-file` (default bench/.env.omnimemeval, which
 * is gitignored) and handed only to the proxy; the harness gets a
 * placeholder. Without `--dry-run` and with no key, nothing runs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, round4, runInfo, writeJson } from "../lib/run-info.mjs";
import { BOARD_ORDER, ESTIMATE_MARGIN, at, boardSpec, expectedCost } from "./boards.mjs";
import { prepareHarness } from "./harness.mjs";
import { serveMeter } from "./meter.mjs";
import { ANSWER_MODEL, EVAL_MODEL, LIB, OMNIMEMEVAL } from "./pin.mjs";
import { createSidecar, loadLibrary, serveSidecar } from "./server.mjs";

/** The approved budget for the paid run (queue item #3371): `--max-usd` may lower it, never raise it. */
export const MAX_USD_CEILING = 20;
/** Stop after this many boards fail in a row. */
const MAX_CONSECUTIVE_FAILURES = 3;
const PLACEHOLDER_KEY = "metered-by-al-buddy-proxy";

function fail(message) {
  console.error(message);
  console.log(`RESULT: OmniMemEval run did not start: ${message.split("\n")[0]}`);
  process.exit(1);
}

/** Read `KEY=value` lines (dotenv syntax: optional quotes, # comments). */
export function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const raw = m[2];
    // A quoted value ends at its closing quote (a comment may follow); an unquoted one at " #".
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    out[m[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
  }
  return out;
}

/**
 * Hold `path` as this process's lock: refuse while another live process
 * holds it (two runs in one harness would overwrite each other's data
 * files and results), take it over from a dead one. Returns the release.
 */
export function takeLock(path, { pid = process.pid, isAlive = processAlive } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const holder = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) throw new Error(`another run (pid ${holder}) is using this harness: ${path}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not take ${path}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** The harness env file for one board: our sidecar and the proxy, with the shared baseline models. */
export function boardEnv({ board, sidecarUrl, meterUrl, topK, llmWorkers }) {
  return [
    `# Written by bench/omnimemeval/run.mjs for board ${board}. No secret: the proxy holds the key.`,
    `AL_BUDDY_URL="${sidecarUrl}/b/${board}"`,
    `LLM_WORKERS=${llmWorkers}`,
    `TOPK=${topK}`,
    `ANSWER_MODEL="${ANSWER_MODEL}"`,
    `ANSWER_BASE_URL="${meterUrl}/b/${board}/v1"`,
    `ANSWER_API_KEY="${PLACEHOLDER_KEY}"`,
    `EVAL_MODEL="${EVAL_MODEL}"`,
    `EVAL_BASE_URL="${meterUrl}/b/${board}/v1"`,
    `EVAL_API_KEY="${PLACEHOLDER_KEY}"`,
    "",
  ].join("\n");
}

/** The harness command for one board, as argv (run with cwd = the harness). */
export function boardCommand(spec, { envFile, version, topK, workers, llmWorkers, limit, toStep }) {
  const argv = ["bash", spec.script, "--lib", LIB, "--env", envFile, "--version", version, "--top-k", String(topK), "--workers", String(workers), "--llm-workers", String(llmWorkers), ...spec.extra];
  if (spec.streaming) argv.push("--streaming", "1", ...(limit ? ["--end-idx", String(limit - 1)] : []));
  if (toStep) argv.push("--to-step", String(toStep));
  return argv;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** SHA-256 of every data file the board's prepare step left (not its scripts or docs). */
function dataChecksums(harnessDir, board) {
  const dir = join(harnessDir, "data", board === "longmemeval" ? "longmemeval" : board);
  if (!existsSync(dir)) return {};
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!/\.(py|md)$/.test(name) && !name.endsWith(".full.json")) out[p.slice(dir.length + 1)] = sha256File(p);
    }
  };
  walk(dir);
  return out;
}

/** LoCoMo's data: our pinned locomo10.json (same bytes as upstream's), the first `limit` conversations when limited. */
function stageLocomo(harnessDir, { source, limit }) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "bench", "locomo", "dataset.json"), "utf8")).files.data;
  const src = source ?? join(REPO_ROOT, "bench", "locomo", "data", manifest.repo.split("/")[0], manifest.path);
  if (!existsSync(src)) throw new Error(`LoCoMo data missing at ${src}: run \`node bench/locomo/download.mjs\` (or pass --locomo-data)`);
  const sha = sha256File(src);
  if (sha !== manifest.sha256) throw new Error(`${src} is not the pinned locomo10.json (SHA-256 ${sha}, pinned ${manifest.sha256})`);
  const samples = JSON.parse(readFileSync(src, "utf8"));
  const dest = join(harnessDir, "data", "locomo", "locomo10.json");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(limit ? samples.slice(0, limit) : samples));
  return { file: "data/locomo/locomo10.json", sourceSha256: sha, conversations: limit ? Math.min(limit, samples.length) : samples.length };
}

/** LongMemEval-S: our pinned copy when there is one (same file as upstream's), else the harness's own download. */
function stageLongMemEval(harnessDir, { source, python, env }) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "bench", "longmemeval", "dataset.json"), "utf8"));
  const pinned = Object.values(manifest.files ?? manifest).find((f) => f?.path === "longmemeval_s_cleaned.json");
  const ours = source ?? join(REPO_ROOT, "bench", "longmemeval", "data", "longmemeval_s_cleaned.json");
  const dest = join(harnessDir, "data", "longmemeval", "longmemeval_s_cleaned.json");
  if (existsSync(ours)) {
    if (!existsSync(dest) || statSync(dest).size !== statSync(ours).size) copyFileSync(ours, dest);
  } else if (!existsSync(dest)) {
    runChecked([python, "data/longmemeval/prepare_longmemeval.py", "--variant", "s"], { cwd: harnessDir, env });
  }
  const sha = sha256File(dest);
  return { file: "data/longmemeval/longmemeval_s_cleaned.json", sourceSha256: sha, matchesPinned: pinned ? sha === pinned.sha256 : null };
}

function runChecked(argv, { cwd, env }) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: "inherit" });
  if (r.error) throw new Error(`${argv.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${argv.join(" ")} exited ${r.status ?? r.signal}`);
}

/**
 * The Python the harness runs on: `--python`, or a venv in the harness built
 * from its own requirements file (OmniMemEval asks for 3.11 or 3.12).
 */
function ensurePython(harnessDir, given) {
  if (given) return { python: resolve(given), how: "given" };
  const venv = join(harnessDir, ".venv");
  const python = join(venv, "bin", "python");
  const reqs = join(harnessDir, "requirements_user_memory.txt");
  const stamp = join(venv, ".al-buddy-requirements.sha256");
  const want = sha256File(reqs);
  if (existsSync(python) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want) return { python, how: "venv (cached)" };
  const tryRun = (argv) => spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status === 0;
  let made = null;
  for (const exe of ["python3.12", "python3.11"]) {
    if (spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0 && tryRun([exe, "-m", "venv", venv])) {
      made = exe;
      break;
    }
  }
  if (!made && spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0 && tryRun(["uv", "venv", "--seed", "-p", "3.12", venv])) made = "uv (3.12)";
  if (!made) throw new Error("no Python 3.11 or 3.12 found (python3.12, python3.11 or uv): install one, or pass --python");
  if (!tryRun([python, "-m", "pip", "install", "--quiet", "-r", reqs])) throw new Error(`pip install -r ${reqs} failed`);
  writeFileSync(stamp, `${want}\n`);
  return { python, how: `venv from ${made}` };
}

/** The board's grades, its headline and how far its pipeline got, read from the harness's results. */
export function readBoardResult(harnessDir, spec, version) {
  const rel = `${spec.results}/${LIB}-${version}`;
  const dir = join(harnessDir, rel);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  // The harness's own per-stage counts (search, answer, judge …): how many questions each stage got through.
  const stages = {};
  for (const f of files.filter((f) => /^al_buddy_.*_status\.json$/.test(f)).sort()) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      stages[s.stage ?? f] = { counts: s.status_counts ?? null, failed: [...(s.failed_users ?? []), ...(s.failed_groups ?? [])].length, skipped: (s.skipped_records ?? []).length };
    } catch (e) {
      stages[f] = { unreadable: e.message };
    }
  }
  const out = { resultsDir: `<harness>/${rel}`, files: files.filter((f) => !f.startsWith(".")).sort(), stages };
  const gradesPath = join(dir, spec.grades);
  if (!existsSync(gradesPath)) return { ...out, grades: null, score: null, why: `no ${spec.grades}: the metric stage did not run or did not finish` };
  const grades = JSON.parse(readFileSync(gradesPath, "utf8"));
  const score = at(grades, spec.score);
  const categories = grades.category_scores ?? null;
  const questions = grades.metrics?.total_questions ?? (categories ? Object.values(categories).reduce((n, c) => n + (Number(c?.total) || 0), 0) || null : null);
  return {
    ...out,
    score: typeof score === "number" ? score : null,
    scoreKey: spec.score.join("."),
    ...(typeof score === "number" ? {} : { why: `${spec.score.join(".")} not in ${spec.grades} (top-level keys: ${Object.keys(grades).join(", ")})` }),
    questions,
    contextTokens: grades.metrics?.context_tokens ?? null,
    pipelineStatus: grades.pipeline_status ?? null,
    metrics: grades.metrics ?? grades.overall ?? null,
    categories,
  };
}

/** The meter's view of one board: reader and judge calls, tokens, USD. */
export function meterView(snapshot, board) {
  const models = snapshot?.boards?.[board] ?? {};
  const reader = models[ANSWER_MODEL] ?? null;
  const judge = models[EVAL_MODEL] ?? null;
  const usd = Object.values(models).reduce((s, r) => s + r.usd, 0);
  return {
    readerCalls: reader?.calls ?? 0,
    readerPromptTokensMean: reader?.calls ? Math.round(reader.promptTokens / reader.calls) : null,
    judgeCalls: judge?.calls ?? 0,
    refused: Object.values(models).reduce((s, r) => s + r.refused, 0),
    upstreamErrors: Object.values(models).reduce((s, r) => s + r.upstreamErrors, 0),
    usd,
    byModel: models,
  };
}

function fmtUsd(x) {
  return `$${x.toFixed(x < 1 ? 4 : 2)}`;
}

/** One printed line per board. */
export function boardLine(row, { stub }) {
  const m = row.meter;
  const cost = stub ? `would cost ${fmtUsd(m.usd)} at list prices (stub: $0 billed)` : `cost ${fmtUsd(m.usd)}`;
  const score = row.score == null ? `no score (${row.why ?? row.status})` : `${row.scoreKey} ${(row.score * (row.score <= 1 ? 100 : 1)).toFixed(2)}`;
  const stages = Object.entries(row.stages ?? {}).map(([stage, s]) => `${stage} ${Object.entries(s.counts ?? {}).map(([k, n]) => `${n} ${k}`).join("/") || "?"}`).join(", ");
  return `${row.board}: ${row.status}${stages ? ` (${stages})` : ""}; ${score}; reader ${m.readerCalls} calls (mean prompt ${m.readerPromptTokensMean ?? "-"} tokens), judge ${m.judgeCalls} calls; ${cost}`;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      boards: { type: "string", default: BOARD_ORDER.join(",") },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      "max-usd": { type: "string", default: String(MAX_USD_CEILING) },
      "env-file": { type: "string", default: "bench/.env.omnimemeval" },
      "harness-dir": { type: "string", default: "bench/omnimemeval/.harness" },
      python: { type: "string" },
      version: { type: "string" },
      "top-k": { type: "string", default: "20" },
      workers: { type: "string", default: "2" },
      "llm-workers": { type: "string", default: "10" },
      "beam-scale": { type: "string", default: "100k" },
      "halumem-variant": { type: "string", default: "medium" },
      retrieval: { type: "string", default: "hybrid" },
      "model-cache": { type: "string" },
      "locomo-data": { type: "string" },
      "lme-data": { type: "string" },
      "to-step": { type: "string" },
      serve: { type: "boolean", default: false },
      summarize: { type: "boolean", default: false },
      "sidecar-port": { type: "string", default: "0" },
      "meter-port": { type: "string", default: "0" },
      out: { type: "string" },
      note: { type: "string" },
    },
  });
  const abs = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
  const dry = args["dry-run"];
  const boards = args.boards.split(",").map((b) => b.trim()).filter(Boolean);
  if (!boards.length) fail("--boards is empty");
  const opts = { beamScale: args["beam-scale"], halumemVariant: args["halumem-variant"] };
  const specs = boards.map((b) => boardSpec(b, opts));
  const maxUsd = Number(args["max-usd"]);
  if (!(maxUsd > 0) || maxUsd > MAX_USD_CEILING) fail(`--max-usd must be above 0 and at most ${MAX_USD_CEILING} (the approved budget), not ${args["max-usd"]}`);
  const limit = args.limit ? Number(args.limit) : dry ? 2 : null;
  if (limit !== null && !(Number.isInteger(limit) && limit >= 1)) fail(`--limit must be a whole number from 1, not ${args.limit}`);
  const toStep = args["to-step"] ? Number(args["to-step"]) : null;
  const topK = Number(args["top-k"]);
  const workers = Number(args.workers);
  const llmWorkers = Number(args["llm-workers"]);
  const version = args.version ?? `omnimemeval_${isoDate().replaceAll("-", "")}${dry ? "_dry" : ""}`;
  // It names directories (results, stores): letters, digits, _ and - only, never "." or "..".
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(version)) fail(`--version may hold only letters, digits, _ and -, led by a letter or digit: ${version}`);
  const harnessDir = abs(args["harness-dir"]);
  const ledgerPath = join(harnessDir, "results", `${LIB}_meter-${version}.json`);
  const servePath = join(harnessDir, "results", `${LIB}_serve-${version}.json`);
  const info = runInfo();

  console.log(`OmniMemEval ${OMNIMEMEVAL.commit.slice(0, 7)} · boards ${boards.join(", ")} · ${dry ? "DRY RUN: stub reader and judge, no API call" : `reader ${ANSWER_MODEL}, judge ${EVAL_MODEL}`} · cap $${maxUsd} · version ${version}${limit ? ` · first ${limit} conversation(s) a board` : ""}`);
  console.log("Expected cost of each full board at list prices (planning figures; the ledger is what a run costs):");
  let expectedTotal = 0;
  for (const s of specs) {
    const e = expectedCost(s.board, { questions: s.questions });
    if (!e) {
      console.log(`  ${s.board}: no estimate`);
      continue;
    }
    expectedTotal += e.usd;
    console.log(`  ${s.board}: ${e.questions} questions, ${e.readerCalls} reader + ${e.judgeCalls} judge calls ≈ ${fmtUsd(e.usd)} (reader ${fmtUsd(e.readerUsd)}, judge ${fmtUsd(e.judgeUsd)}; ${e.source})`);
  }
  console.log(`  all: ≈ ${fmtUsd(expectedTotal)}`);

  const summarize = (rows, extra = {}) => {
    const snapshot = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;
    const out = [];
    for (const s of specs) {
      const prior = rows?.find((r) => r.board === s.board);
      const result = readBoardResult(harnessDir, s, version);
      const meter = meterView(snapshot, s.board);
      // Run to a step: its outputs are there (and, from the answer step on, the reader was called). Run whole: it has a headline score.
      const reachedEnd = toStep ? result.files.length > 0 && (toStep < 3 || meter.readerCalls > 0) : result.score !== null;
      const status = prior?.status && prior.status !== "ran" ? prior.status : reachedEnd ? (toStep ? `ran to step ${toStep}` : "scored") : "failed";
      out.push({ board: s.board, label: s.label, ...prior, ...result, status, ok: reachedEnd && (!prior || prior.exit === 0 || prior.exit === undefined), meter, expected: expectedCost(s.board, { questions: s.questions }) });
    }
    const succeeded = out.filter((r) => r.ok).length;
    const spent = snapshot?.spentUsd ?? 0;
    const file = {
      benchmark: "OmniMemEval user-memory boards",
      dryRun: dry,
      ...(args.note ? { note: args.note } : {}),
      harness: { ...OMNIMEMEVAL, patches: "bench/omnimemeval/harness.mjs", lib: LIB },
      reader: dry ? "stub (bench/omnimemeval/meter.mjs, no model called)" : ANSWER_MODEL,
      judge: dry ? "stub (bench/omnimemeval/meter.mjs, no model called)" : EVAL_MODEL,
      settings: { version, topK, workers, llmWorkers, limit, toStep, retrieval: args.retrieval, beamScale: opts.beamScale, halumemVariant: opts.halumemVariant, recall: "HybridRetriever.recall, limit max(top_k, 100), expand against the question's date (else the user's last memory date); one memory per message, as said" },
      run: info,
      capUsd: maxUsd,
      spentUsd: spent,
      billedUsd: dry ? 0 : spent,
      capTripped: snapshot?.tripped ?? null,
      attempted: out.length,
      succeeded,
      boards: out,
      ...extra,
    };
    const path = args.out ? abs(args.out) : resultPath(RESULTS_DIR, isoDate(), `omnimemeval${dry ? "-dry" : ""}`);
    writeJson(path, file);
    console.log("");
    for (const r of out) console.log(boardLine(r, { stub: dry }));
    console.log(`Wrote ${path}`);
    const scored = out.filter((r) => r.ok && r.score !== null).map((r) => `${r.board} ${(r.score * (r.score <= 1 ? 100 : 1)).toFixed(2)}`);
    let result;
    if (succeeded === 0) result = `OmniMemEval ${dry ? "dry run" : "run"} failed: 0 of ${out.length} boards completed (${out.map((r) => `${r.board}: ${r.why ?? r.status}`).join("; ")}); ${dry ? "nothing billed" : `${fmtUsd(spent)} spent of the $${maxUsd} cap`}.`;
    else if (dry) result = `OmniMemEval dry run (stub reader and judge, no API call, $0 billed): ${succeeded} of ${out.length} boards ran${toStep ? ` to step ${toStep}` : ""}${limit ? ` on ${limit} conversation(s) each` : ""}, ${out.reduce((n, r) => n + r.meter.readerCalls, 0)} reader calls metered (would cost ${fmtUsd(spent)} at list prices).`;
    else result = `OmniMemEval with al-buddy-memory: ${succeeded} of ${out.length} boards scored (${scored.join(", ") || "no headline read"}); ${fmtUsd(spent)} spent of the $${maxUsd} cap${snapshot?.tripped ? " (cap reached: later calls refused)" : ""}.`;
    console.log(`RESULT: ${result}`);
    return succeeded;
  };

  if (args.summarize) {
    const ok = summarize(null);
    process.exit(ok > 0 ? 0 : 1);
  }

  let apiKey = null;
  if (!dry) {
    const envFile = abs(args["env-file"]);
    if (!existsSync(envFile)) fail(`no ${args["env-file"]}: put OPENAI_API_KEY=... in it (the file is gitignored), or pass --dry-run`);
    apiKey = readEnvFile(envFile).OPENAI_API_KEY ?? null;
    if (!apiKey) fail(`${args["env-file"]} has no OPENAI_API_KEY`);
  }

  // Beside the harness, not in it: a fresh clone needs its directory absent.
  try {
    process.on("exit", takeLock(`${harnessDir}.lock`));
  } catch (e) {
    fail(e.message);
  }

  let prepared;
  try {
    prepared = prepareHarness(harnessDir, { log: (l) => console.log(l) });
  } catch (e) {
    fail(`could not prepare OmniMemEval in ${harnessDir}: ${e.message}`);
  }
  console.log(`Harness at ${prepared.commit}: ${prepared.files.map((f) => `${f.file} ${f.status}`).join(", ")}`);

  let lib;
  let embedder;
  try {
    ({ lib, embedder } = await loadLibrary(REPO_ROOT, { retrieval: args.retrieval, modelCache: args["model-cache"] }));
  } catch (e) {
    fail(e.message);
  }
  const stateRoot = join(harnessDir, "results", `${LIB}_state`, version);
  mkdirSync(join(harnessDir, "results"), { recursive: true });
  const sidecar = await serveSidecar((board) => createSidecar(lib, { stateDir: join(stateRoot, board), embedder }), { port: Number(args["sidecar-port"]), health: { retrieval: args.retrieval, embedder: embedder?.model ?? null }, log: (m) => console.error(m) });
  const meter = await serveMeter({ mode: dry ? "stub" : "forward", capUsd: maxUsd, apiKey, answerModel: ANSWER_MODEL, ledgerPath, port: Number(args["meter-port"]) });
  const envFiles = {};
  for (const s of specs) {
    envFiles[s.board] = join(harnessDir, `.env.${LIB}.${s.board}`);
    writeFileSync(envFiles[s.board], boardEnv({ board: s.board, sidecarUrl: sidecar.url, meterUrl: meter.url, topK, llmWorkers }), { mode: 0o600 });
  }
  writeJson(servePath, { sidecar: sidecar.url, meter: meter.url, version, envFiles, ledgerPath });
  const closeAll = async () => {
    await meter.close();
    await sidecar.close();
  };

  if (args.serve) {
    console.log(`Sidecar ${sidecar.url} · meter ${meter.url} (${dry ? "stub" : "forward"}, cap $${maxUsd}) · ledger ${ledgerPath}`);
    console.log("Run each board from the harness directory (python on PATH = the harness's environment):");
    for (const s of specs) {
      try {
        if (s.board === "locomo") console.log(`  data: ${JSON.stringify(stageLocomo(harnessDir, { source: args["locomo-data"] ? abs(args["locomo-data"]) : undefined, limit }))}`);
        else if (s.board === "longmemeval" && (args["lme-data"] || existsSync(join(REPO_ROOT, "bench", "longmemeval", "data", "longmemeval_s_cleaned.json")))) console.log(`  data: ${JSON.stringify(stageLongMemEval(harnessDir, { source: args["lme-data"] ? abs(args["lme-data"]) : undefined }))}`);
        else console.log(`  cd ${harnessDir} && python ${s.prepare.join(" ")}`);
      } catch (e) {
        console.log(`  data for ${s.board} not staged: ${e.message}`);
      }
      console.log(`  cd ${harnessDir} && ${boardCommand(s, { envFile: envFiles[s.board], version, topK, workers, llmWorkers, limit, toStep }).join(" ")}`);
    }
    console.log(`Then: node bench/omnimemeval/run.mjs --summarize${dry ? " --dry-run" : ""} --boards ${boards.join(",")} --version ${version} --harness-dir ${args["harness-dir"]}${toStep ? ` --to-step ${toStep}` : ""}${limit ? ` --limit ${limit}` : ""}`);
    const stop = () => closeAll().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  let python;
  try {
    python = ensurePython(harnessDir, args.python);
  } catch (e) {
    await closeAll();
    fail(e.message);
  }
  const env = { ...process.env, PATH: `${dirname(python.python)}:${process.env.PATH}`, OPENAI_API_KEY: "" };
  const rows = [];
  let consecutiveFailures = 0;
  for (const s of specs) {
    const row = { board: s.board };
    rows.push(row);
    const expected = limit ? null : expectedCost(s.board, { questions: s.questions });
    const left = maxUsd - meter.ledger.spentUsd;
    if (meter.ledger.tripped) {
      Object.assign(row, { status: "not started: spend cap reached", exit: null });
      consecutiveFailures += 1;
    } else if (expected && expected.usd * ESTIMATE_MARGIN > left) {
      // A board the cap would stop part-way is money spent on no score: leave it for a run with budget.
      Object.assign(row, { status: `not started: expected ${fmtUsd(expected.usd)} (×${ESTIMATE_MARGIN} margin) does not fit the ${fmtUsd(left)} left of the cap`, exit: null });
    } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      Object.assign(row, { status: `not started: ${MAX_CONSECUTIVE_FAILURES} boards failed in a row`, exit: null });
    } else {
      try {
        if (s.board === "locomo") row.data = stageLocomo(harnessDir, { source: args["locomo-data"] ? abs(args["locomo-data"]) : undefined, limit });
        else if (s.board === "longmemeval") row.data = stageLongMemEval(harnessDir, { source: args["lme-data"] ? abs(args["lme-data"]) : undefined, python: python.python, env });
        else runChecked([python.python, ...s.prepare], { cwd: harnessDir, env });
        row.dataChecksums = dataChecksums(harnessDir, s.board);
        const argv = boardCommand(s, { envFile: envFiles[s.board], version, topK, workers, llmWorkers, limit, toStep });
        console.log(`\n== ${s.label}: ${argv.join(" ")}`);
        const started = Date.now();
        const r = spawnSync(argv[0], argv.slice(1), { cwd: harnessDir, env, stdio: "inherit" });
        row.seconds = Math.round((Date.now() - started) / 1000);
        row.exit = r.status ?? null;
        row.status = r.error ? `failed: ${r.error.message}` : r.status === 0 ? "ran" : `failed: ${s.script} exited ${r.status ?? r.signal}`;
      } catch (e) {
        Object.assign(row, { status: `failed: ${e.message}`, exit: null });
      }
      const ok = row.status === "ran" && (toStep || readBoardResult(harnessDir, s, version).score !== null);
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
      const view = meterView(meter.ledger.snapshot(), s.board);
      console.log(`== ${s.label}: ${row.status}; ${view.readerCalls} reader + ${view.judgeCalls} judge calls, ${dry ? "would cost" : "cost"} ${fmtUsd(view.usd)} (run total ${fmtUsd(meter.ledger.spentUsd)} of $${maxUsd})`);
    }
  }
  const sidecarStats = sidecar.stats();
  await closeAll();
  const ok = summarize(rows, { python: python.how, sidecar: sidecarStats, harnessFiles: prepared.files });
  process.exit(ok > 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.stack ?? e);
    console.log(`RESULT: OmniMemEval run crashed: ${e?.message ?? e}`);
    process.exit(1);
  });
}
