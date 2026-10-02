// Re-grade a LongMemEval hypotheses file with the OFFICIAL judge: gpt-4o-2024-08-06 over the
// OpenAI API, temperature 0, max_tokens 10, the official prompts (judge-prompts.mjs) — exactly
// what xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py does. A one-time founder exception
// (2026-10-02) to the rule that the OpenAI API key is for products only; it reads OPENAI_API_KEY
// from the environment and stops before spending more than --max-usd (default $8).
// Usage: OPENAI_API_KEY=… node bench/longmemeval/regrade-openai.mjs <hypotheses.jsonl> [--concurrency 4] [--max-usd 8]
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

import { prompt } from "./judge-prompts.mjs";

const MODEL = "gpt-4o-2024-08-06";
// Published gpt-4o-2024-08-06 prices, USD per 1M tokens.
const USD_IN = 2.5;
const USD_OUT = 10;

const args = process.argv.slice(2);
const hypPath = args[0];
const opt = (name, dflt) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt);
const conc = opt("--concurrency", 4) || 4;
const maxUsd = opt("--max-usd", 8);
const key = process.env.OPENAI_API_KEY;
if (!hypPath || !key) {
  console.error("usage: OPENAI_API_KEY=… node bench/longmemeval/regrade-openai.mjs <hypotheses.jsonl>");
  process.exit(2);
}

const data = JSON.parse(readFileSync(new URL("./data/longmemeval_s_cleaned.json", import.meta.url), "utf8"));
const byId = new Map(data.map((q) => [q.question_id, q]));
const hyps = readFileSync(hypPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const outPath = hypPath.replace(/\.jsonl$/, "") + `.eval-${MODEL}.jsonl`;
const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).question_id) : []);

let spent = 0;
let stopped = false;

async function judge(p) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: p }], temperature: 0, max_tokens: 10, n: 1 }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const j = await res.json();
    if (!res.ok) return { ok: false, err: `${res.status} ${j?.error?.message ?? ""}`.slice(0, 200) };
    const u = j.usage ?? {};
    spent += ((u.prompt_tokens ?? 0) * USD_IN + (u.completion_tokens ?? 0) * USD_OUT) / 1e6;
    return { ok: true, text: String(j.choices?.[0]?.message?.content ?? "").trim() };
  }
  return { ok: false, err: "rate limited after 4 tries" };
}

const queue = hyps.filter((h) => !done.has(h.question_id));
async function worker() {
  while (queue.length && !stopped) {
    if (spent >= maxUsd) {
      stopped = true;
      console.log(`stopping: spend reached $${spent.toFixed(2)} (cap $${maxUsd})`);
      break;
    }
    const h = queue.shift();
    const q = byId.get(h.question_id);
    const abst = h.question_id.endsWith("_abs");
    const res = await judge(prompt(q.question_type, q.question, q.answer, h.hypothesis, abst));
    if (!res.ok) {
      console.log(`[${h.question_id}] judge failed: ${res.err}`);
      continue;
    }
    // evaluate_qa.py: label = 'yes' in response.lower()
    const label = res.text.toLowerCase().includes("yes");
    appendFileSync(outPath, JSON.stringify({ question_id: h.question_id, question_type: q.question_type, abstention: abst, label, judge: res.text.slice(0, 50), model: MODEL }) + "\n");
  }
}
await Promise.all(Array.from({ length: conc }, worker));

const rows = readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = {};
let tot = 0;
for (const r of rows) {
  by[r.question_type] ??= [0, 0];
  by[r.question_type][0] += r.label ? 1 : 0;
  by[r.question_type][1] += 1;
  tot += r.label ? 1 : 0;
}
const typeAvg = Object.values(by).reduce((s, [c, n]) => s + c / n, 0) / Math.max(1, Object.keys(by).length);
console.log(`\nOfficial judge (${MODEL}) over ${rows.length}/${hyps.length}: overall ${((100 * tot) / rows.length).toFixed(1)}% · task-averaged ${(100 * typeAvg).toFixed(1)}% · this run spent ~$${spent.toFixed(2)}`);
for (const [k, [c, n]] of Object.entries(by)) console.log(`  ${k}: ${((100 * c) / n).toFixed(1)}% (${c}/${n})`);
writeFileSync(
  outPath.replace(/\.jsonl$/, ".summary.json"),
  JSON.stringify({ model: MODEL, judgedWith: "OpenAI API, official LongMemEval judge prompts, temperature 0, max_tokens 10", n: rows.length, overall: tot / rows.length, taskAveraged: typeAvg, byType: Object.fromEntries(Object.entries(by).map(([k, [c, n]]) => [k, { correct: c, n }])) }, null, 2),
);
