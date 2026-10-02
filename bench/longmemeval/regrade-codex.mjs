// Re-grade a LongMemEval hypotheses file with a GPT judge through the Codex CLI (ChatGPT seat —
// no OpenAI API key, per the founder's rule), using the OFFICIAL judge prompts from
// xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py verbatim. The official judge model is
// gpt-4o-2024-08-06 via the API; this substitutes the Codex default model and records which.
// Usage: node bench/longmemeval/regrade-codex.mjs <hypotheses.jsonl> [--concurrency 4] [--model gpt-6-sol]
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { prompt } from "./judge-prompts.mjs";
import { join } from "node:path";

const args = process.argv.slice(2);
const hypPath = args[0];
const conc = Number(args[args.indexOf("--concurrency") + 1] || 4) || 4;
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "gpt-6-sol";
const data = JSON.parse(readFileSync(new URL("./data/longmemeval_s_cleaned.json", import.meta.url), "utf8"));
const byId = new Map(data.map((q) => [q.question_id, q]));
const hyps = readFileSync(hypPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const outPath = hypPath.replace(/\.jsonl$/, "") + `.eval-codex-${model}.jsonl`;
const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).question_id) : []);

function judge(p) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "lme-judge-"));
    const out = join(dir, "out.md");
    const child = execFile("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-m", model, "-c", 'model_reasoning_effort="low"', "-c", "mcp_servers.figma_local.enabled=false", "-o", out, p], { cwd: dir, timeout: 180_000, maxBuffer: 10_000_000 }, (err, _so, se) => {
      let text = "";
      try { text = readFileSync(out, "utf8").trim(); } catch {}
      resolve({ ok: !!text, text, err: err ? String(se || err.message).slice(0, 300) : null });
    });
    child.stdin?.end();
  });
}

const todo = hyps.filter((h) => !done.has(h.question_id));
let i = 0, stop = false;
async function worker() {
  while (!stop && i < todo.length) {
    const h = todo[i++];
    const q = byId.get(h.question_id);
    const abst = h.question_id.endsWith("_abs");
    const res = await judge(prompt(q.question_type, q.question, q.answer, h.hypothesis, abst));
    if (!res.ok) {
      console.log(`[${h.question_id}] judge failed: ${res.err}`);
      if (/usage limit|out of credits/i.test(res.err || "")) stop = true;
      continue;
    }
    const label = /\byes\b/i.test(res.text) && !/^\s*no\b/i.test(res.text);
    appendFileSync(outPath, JSON.stringify({ question_id: h.question_id, question_type: q.question_type, abstention: abst, label, judge: res.text.slice(0, 50), model }) + "\n");
    console.log(`[${done.size + i}/${hyps.length}] ${h.question_id} ${q.question_type} ${label ? "yes" : "no"}`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
const rows = readFileSync(outPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const by = {};
for (const r of rows) { const k = r.abstention ? "abstention" : r.question_type; (by[k] ??= [0, 0]); by[k][0] += r.label ? 1 : 0; by[k][1]++; }
const tot = rows.filter((r) => r.label).length;
console.log(`\nCodex judge (${model}) over ${rows.length}/${hyps.length}: overall ${(100 * tot / rows.length).toFixed(1)}%`);
for (const [k, [c, n]] of Object.entries(by)) console.log(`  ${k.padEnd(26)} ${(100 * c / n).toFixed(1)}%  (n=${n})`);
writeFileSync(outPath.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ model, judgedWith: "codex exec (ChatGPT seat), official LongMemEval judge prompts", n: rows.length, overall: tot / rows.length, byType: Object.fromEntries(Object.entries(by).map(([k, [c, n]]) => [k, { correct: c, n }])) }, null, 2));
