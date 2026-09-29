#!/usr/bin/env node
// Usage: node bench/longmemeval/compare.mjs baseline.json option-a.json [option-b.json …]
//
// Puts LongMemEval result files side by side: accuracy per question type,
// overall, and how much of the evidence the reader was shown; then, for each
// file after the first, the questions it got right that the first got wrong
// (fixed) and the reverse (broken), counted over the questions both judged.
// An A/B is only as good as its pairs: files over different questions or
// different judges say so rather than being averaged together.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { QUESTION_TYPES } from "./dataset.mjs";

/** What one result file says, reduced to what a comparison needs. */
export function digest(result, name = "result") {
  const labels = new Map(result.questions.filter((q) => typeof q.label === "boolean").map((q) => [q.question_id, { type: q.question_type, label: q.label }]));
  return {
    name,
    settings: result.settings,
    judge: result.judge?.requestedModel ?? null,
    labels,
    qa: result.summary.qa,
    shown: result.summary.retrieval.shown ?? null,
  };
}

/** Fixed and broken against the baseline, over the questions both judged. */
export function pairwise(base, other) {
  let fixed = 0, broken = 0, both = 0;
  const byType = {};
  for (const [id, b] of base.labels) {
    const o = other.labels.get(id);
    if (!o) continue;
    both += 1;
    const t = (byType[b.type] ??= { fixed: 0, broken: 0, n: 0 });
    t.n += 1;
    if (!b.label && o.label) (fixed += 1), (t.fixed += 1);
    if (b.label && !o.label) (broken += 1), (t.broken += 1);
  }
  return { both, fixed, broken, byType };
}

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(1)}%`);

export function report(digests) {
  const lines = [];
  const [base] = digests;
  const types = QUESTION_TYPES.filter((t) => digests.some((d) => d.qa.byType[t]));
  const w = Math.max(10, ...digests.map((d) => d.name.length));
  lines.push(`${"".padEnd(28)}${digests.map((d) => d.name.padStart(w + 2)).join("")}`);
  lines.push(`${"overall".padEnd(28)}${digests.map((d) => `${pct(d.qa.overallAccuracy)} (${d.qa.questions})`.padStart(w + 2)).join("")}`);
  for (const t of types) lines.push(`${t.padEnd(28)}${digests.map((d) => (d.qa.byType[t] ? `${pct(d.qa.byType[t].accuracy)} (${d.qa.byType[t].n})` : "—").padStart(w + 2)).join("")}`);
  lines.push(`${"shown all evidence".padEnd(28)}${digests.map((d) => pct(d.shown?.allEvidence).padStart(w + 2)).join("")}`);
  for (const t of types) lines.push(`${`  ${t}`.padEnd(28)}${digests.map((d) => pct(d.shown?.byType?.[t]?.allEvidence).padStart(w + 2)).join("")}`);
  for (const d of digests.slice(1)) {
    const p = pairwise(base, d);
    const warn = [];
    if (p.both !== base.labels.size || p.both !== d.labels.size) warn.push(`only ${p.both} questions judged in both`);
    if (d.judge !== base.judge) warn.push(`judge ${d.judge} vs ${base.judge}`);
    lines.push(`\n${d.name} vs ${base.name}: fixed ${p.fixed}, broke ${p.broken}, net ${p.fixed - p.broken >= 0 ? "+" : ""}${p.fixed - p.broken} of ${p.both}${warn.length ? `  [${warn.join("; ")}]` : ""}`);
    for (const t of types) if (p.byType[t]) lines.push(`  ${t.padEnd(26)} fixed ${p.byType[t].fixed}, broke ${p.byType[t].broken} (of ${p.byType[t].n})`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  if (files.length < 2) {
    console.error("Usage: node bench/longmemeval/compare.mjs baseline.json option.json [option.json …]");
    process.exit(1);
  }
  console.log(report(files.map((f) => digest(JSON.parse(readFileSync(f, "utf8")), basename(f).replace(/\.json$/, "")))));
}
