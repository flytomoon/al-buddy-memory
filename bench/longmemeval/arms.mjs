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

/** p50, p95 and mean of the shown characters over the rows that have them, and the same as estimated tokens (chars / 4). */
export function summarizeShownChars(values) {
  const xs = values.filter((x) => typeof x === "number");
  if (xs.length === 0) return null;
  const stats = (ys) => ({ p50: Math.round(percentile(ys, 0.5)), p95: Math.round(percentile(ys, 0.95)), mean: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) });
  return { n: xs.length, chars: stats(xs), approxTokens: stats(xs.map((x) => x / 4)) };
}
