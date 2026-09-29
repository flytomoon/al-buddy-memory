// Re-grade a LongMemEval hypotheses file with a GPT judge through the Codex CLI (ChatGPT seat —
// no OpenAI API key, per the founder's rule), using the OFFICIAL judge prompts from
// xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py verbatim. The official judge model is
// gpt-4o-2024-08-06 via the API; this substitutes the Codex default model and records which.
// Usage: node bench/longmemeval/regrade-codex.mjs <hypotheses.jsonl> [--concurrency 4] [--model gpt-6-sol]
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function prompt(task, q, a, r, abstention) {
  const base = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ";
  if (abstention) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q}\n\nExplanation: ${a}\n\nModel Response: ${r}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  if (["single-session-user", "single-session-assistant", "multi-session"].includes(task)) return `${base}\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "temporal-reasoning") return `${base}In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "knowledge-update") return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "single-session-preference") return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q}\n\nRubric: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  throw new Error(`unknown task ${task}`);
}

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
