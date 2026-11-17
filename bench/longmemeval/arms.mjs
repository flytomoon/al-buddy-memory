/**
 * What one `recall-sweep.mjs --arm` spec asks for, read without loading
 * anything: no model, no build, no file. The sweep does the loading.
 *
 * `none` is the raw-retrieval baseline: `HybridRetriever.recall` over the raw
 * messages, nothing else — no `expand`, no cross-encoder, no recall options,
 * and nothing consolidated or derived (the benchmark never stores either).
 * `expand` is the recall the MCP `recall` tool runs by default
 * (`GovernanceDeps.expand`, default true), so `--arm none --arm expand` puts
 * the raw baseline and the shipped default side by side over the same memory.
 */
import { fastPathOptions } from "./memory.mjs";
import { percentile } from "./metrics.mjs";

export const RERANK_MODELS = { minilm: "Xenova/ms-marco-MiniLM-L-6-v2", bge: "Xenova/bge-reranker-base" };

/** The parts an arm can be made of, for error messages. */
const PARTS = `none, expand, content-words, build:<dir>, ${Object.keys(RERANK_MODELS).join(", ")} or a Hugging Face cross-encoder id`;

/**
 * One `--arm` spec, parsed. Throws an Error naming the spec on anything it
 * does not know. `globalExpand` is the sweep's own `--expand`: with it every
 * arm already expands, so an `expand` part would be a second arm that is the
 * same as the first, and is refused.
 *
 * Returns `{ name, expand, contentWords, build, rerank }`: `build` is the
 * directory as written (the sweep resolves and imports it), `rerank` is null
 * or `{ short, model, dtype, depth, depthSpec, when, part }`.
 */
export function parseArm(spec, { globalExpand = false } = {}) {
  const arm = { name: "none", expand: false, contentWords: false, build: null, rerank: null };
  if (spec === "none") return arm;
  const bad = (why) => new Error(`--arm ${spec}: ${why}`);
  const names = [];
  for (const part of spec.split("+")) {
    const [kind, ...rest] = part.split(":");
    if (part === "none") throw bad(`"none" is an arm on its own, not a part`);
    if (part === "expand") {
      if (globalExpand) throw bad("--expand already expands every arm; drop one of them");
      if (arm.expand) throw bad("expand twice");
      arm.expand = true;
    } else if (part === "content-words") {
      if (arm.contentWords) throw bad("content-words twice");
      arm.contentWords = true;
    } else if (kind === "build") {
      if (arm.build !== null) throw bad("one build per arm");
      const dir = rest.join(":");
      if (dir === "") throw bad("build: needs a directory");
      arm.build = dir;
    } else {
      if (arm.rerank) throw bad("one cross-encoder per arm");
      const [short, dtype = "fp32", depthSpec = "all", gate, ...extra] = part.split(":");
      // A Hugging Face id is always owner/name, so anything else is a typo or an arm that is gone.
      if (!RERANK_MODELS[short] && !short.includes("/")) throw bad(`unknown part "${part}" (have: ${PARTS})`);
      const depth = depthSpec === "all" ? null : Number(depthSpec);
      if (depth !== null && (!Number.isInteger(depth) || depth < 1)) throw bad(`depth must be an integer >= 1 or "all"`);
      if ((gate !== undefined && gate !== "window") || extra.length > 0) throw bad(`after the depth, only ":window" (rerank only questions that name a period)`);
      const rerankPart = `${short}:${dtype}:${depthSpec}${gate ? ":window" : ""}`;
      arm.rerank = { short, model: RERANK_MODELS[short] ?? short, dtype, depth, depthSpec, when: gate ?? "always", part: rerankPart };
      names.push(rerankPart);
      continue;
    }
    names.push(part);
  }
  // An older build may not know the newer options; it would read them as a scope.
  if (arm.build !== null && (arm.expand || arm.contentWords)) throw bad("a build arm recalls as that build does; give it no recall options");
  arm.name = names.join("+");
  return arm;
}

/**
 * What `recallRounds` is given for this arm: `expand` when the arm or the
 * whole sweep asks for it, and the arm's recall options. A cross-encoder's
 * per-question gate (`rerankGate`) is the sweep's to add on top.
 */
export function armRecallSettings(arm, { globalExpand = false } = {}) {
  return { expand: globalExpand || arm.expand, recallOptions: fastPathOptions({ contentWords: arm.contentWords }).options };
}

/**
 * How much text the reader would be handed for these rounds: the characters
 * of every turn in them. Tokens are about a quarter of that for English; the
 * sweep reports both, and says the tokens are an estimate.
 */
export function shownChars(rounds) {
  let chars = 0;
  for (const r of rounds) for (const t of r.turns) chars += t.content.length;
  return chars;
}

/**
 * The sweep's `--gain-bar N`: does each arm after the first show every
 * evidence turn in at least N more questions than the first arm does, net of
 * the questions where it stops showing it? A reranker that only trades one
 * question's evidence for another's does not pass. `summary` is the sweep's
 * per-arm summary (its `allEvidenceVs` is against the first arm).
 */
export function gainBarCheck(summary, armNames, min) {
  if (!Number.isInteger(min) || min < 1) throw new Error(`gain bar must be an integer >= 1 (got ${min})`);
  if (armNames.length < 2) throw new Error("a gain bar needs a second arm to hold to it");
  const [against, ...others] = armNames;
  const arms = Object.fromEntries(
    others.map((name) => {
      const { gained, lost } = summary[name].allEvidenceVs;
      const net = gained.length - lost.length;
      return [name, { gained: gained.length, lost: lost.length, net, pass: net >= min, recallMsP50: summary[name].recall?.ms?.p50 ?? null }];
    }),
  );
  return { min, against, rule: "net questions newly shown every evidence turn (gained minus lost) >= min", arms };
}

/** One clause per arm of a gain bar, for the sweep's RESULT line. */
export function gainBarSentence(bar, { questions, againstMsP50 = null } = {}) {
  const parts = Object.entries(bar.arms).map(
    ([name, a]) => `${name} newly showed every evidence turn in ${a.gained} and stopped in ${a.lost} (net ${a.net >= 0 ? "+" : ""}${a.net}; bar +${bar.min}: ${a.pass ? "PASS" : "FAIL"}), recall p50 ${a.recallMsP50 ?? "—"} ms`,
  );
  return `over ${questions} questions against ${bar.against}${againstMsP50 === null ? "" : ` (recall p50 ${againstMsP50} ms)`}, ${parts.join("; ")}`;
}

/** p50, p95 and mean of the shown characters over the rows that have them, and the same as estimated tokens (chars / 4). */
export function summarizeShownChars(values) {
  const xs = values.filter((x) => typeof x === "number");
  if (xs.length === 0) return null;
  const stats = (ys) => ({ p50: Math.round(percentile(ys, 0.5)), p95: Math.round(percentile(ys, 0.95)), mean: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) });
  return { n: xs.length, chars: stats(xs), approxTokens: stats(xs.map((x) => x / 4)) };
}

/**
 * The bar a recall option clears before it is switched on by default (review
 * 2026-11-17, build list item 8, for `contentWords`): over the full run, the
 * option's arm against the first arm must
 *
 *   - hold the gain: show every evidence turn in at least `minNet` more
 *     questions than the first arm, net of the ones it stops showing. The
 *     default, +2, is what the option earned on its gain set (+3 / −1,
 *     2026-10-15 and again 2026-10-18), and those questions are inside the 500;
 *   - lose little anywhere: in no question type stop showing every evidence
 *     turn in more than `maxLostPerType` questions. Lost questions, not net,
 *     so a type's losses are never hidden by its gains.
 *
 * Only questions both arms were scored on count (the official metric skips
 * abstention and assistant-only evidence). `rows` are the sweep's per-question
 * rows (`arms[name].retrieval.shown.all`).
 */
export const DEFAULT_BAR = { minNet: 2, maxLostPerType: 1 };

export function defaultBarCheck(rows, armNames, { minNet = DEFAULT_BAR.minNet, maxLostPerType = DEFAULT_BAR.maxLostPerType } = {}) {
  if (armNames.length !== 2) throw new Error(`the default bar holds one arm against the first: give exactly two arms (got ${armNames.length})`);
  if (!Number.isInteger(minNet) || !Number.isInteger(maxLostPerType) || maxLostPerType < 0) throw new Error("the default bar's minNet and maxLostPerType must be integers, maxLostPerType >= 0");
  const [against, arm] = armNames;
  const all = (r, name) => r.arms?.[name]?.retrieval?.shown?.all;
  const byType = {};
  let gained = 0;
  let lost = 0;
  let scored = 0;
  for (const r of rows) {
    const a = all(r, arm);
    const b = all(r, against);
    if (a === undefined || b === undefined) continue;
    scored += 1;
    const t = (byType[r.question_type] ??= { n: 0, gained: 0, lost: 0 });
    t.n += 1;
    if (a === 1 && b === 0) {
      t.gained += 1;
      gained += 1;
    } else if (a === 0 && b === 1) {
      t.lost += 1;
      lost += 1;
    }
  }
  const overLimit = Object.entries(byType).filter(([, t]) => t.lost > maxLostPerType).map(([type]) => type);
  const net = gained - lost;
  return {
    against,
    arm,
    rule: `net questions newly shown every evidence turn >= ${minNet}, and no question type losing more than ${maxLostPerType}`,
    minNet,
    maxLostPerType,
    questions: scored,
    gained,
    lost,
    net,
    byType,
    typesOverLimit: overLimit,
    pass: scored > 0 && net >= minNet && overLimit.length === 0,
  };
}

/** The default bar in one sentence, for the sweep's RESULT line. */
export function defaultBarSentence(bar) {
  const types = Object.entries(bar.byType).map(([t, v]) => `${t} +${v.gained}/-${v.lost}`).join(", ");
  const why = bar.questions === 0 ? "no question scored on both arms" : [bar.net < bar.minNet ? `net ${bar.net >= 0 ? "+" : ""}${bar.net} is under +${bar.minNet}` : null, bar.typesOverLimit.length ? `${bar.typesOverLimit.join(", ")} lost more than ${bar.maxLostPerType}` : null].filter(Boolean).join("; ");
  return `${bar.arm} against ${bar.against} over ${bar.questions} scored questions: +${bar.gained} / -${bar.lost} (net ${bar.net >= 0 ? "+" : ""}${bar.net}; ${types || "no types"}); default bar ${bar.pass ? "PASS: it may be switched on by default" : `FAIL (${why}): it stays opt-in`}`;
}
