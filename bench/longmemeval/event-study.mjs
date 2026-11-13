#!/usr/bin/env node
/** Three complete, subscription-only runs over the 133 multi-session questions. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR, isoDate } from "../lib/run-info.mjs";

const base = join(RESULTS_DIR, `${isoDate()}-event-study`);
const cache = join(RESULTS_DIR, ".progress", `${isoDate()}-event-study.cache.jsonl`);
const scores = [];
let attempted = 0;
let succeeded = 0;
for (let run = 1; run <= 3; run += 1) {
  attempted += 1;
  const out = `${base}-${run}.json`;
  if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
  const result = spawnSync(process.execPath, ["bench/longmemeval/run.mjs", "--types", "multi-session", "--extract-events", "--events-cache", cache, "--out", out, "--concurrency", "1"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.log(`RESULT: attempted ${attempted} run(s), succeeded ${succeeded}; run ${run} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status}`}.`);
    process.exitCode = 1;
    break;
  }
  const data = JSON.parse(readFileSync(out, "utf8"));
  const qa = data.summary.qa;
  if (data.settings.selection.questions !== 133 || qa.questions !== 133 || data.summary.errors !== 0 || typeof qa.overallAccuracy !== "number") {
    console.log(`RESULT: attempted ${attempted} run(s), succeeded ${succeeded}; run ${run} is incomplete.`);
    process.exitCode = 1;
    break;
  }
  scores.push(qa.overallAccuracy * 100);
  succeeded += 1;
}
if (succeeded === 3) {
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const spread = Math.max(...scores) - Math.min(...scores);
  const summary = { attempted, succeeded, scores, mean, spread, baseline: 83.5, note: "83.5% used the official API judge; this subscription-only study uses the Claude judge. The scores are not directly comparable. Changes within ±3 percentage points are noise, not a gain." };
  writeFileSync(`${base}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`RESULT: attempted ${attempted} runs, succeeded ${succeeded}; multi-session mean ${mean.toFixed(1)}%, range ${Math.min(...scores).toFixed(1)}–${Math.max(...scores).toFixed(1)}% (spread ${spread.toFixed(1)} points); 83.5% used a different judge, so no gain claim.`);
}
