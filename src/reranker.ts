/**
 * Reranking recall with a cross-encoder — LOCAL-FIRST and free, like the embedder.
 *
 * The embedder turns the query and each memory into vectors separately, so a
 * memory's vector was made without ever seeing the question. A cross-encoder
 * reads the question and one memory together and scores how well the memory
 * answers it: much better at "which of these twenty mentions of baking is the
 * one that says how often", much slower per pair. So it only reorders the few
 * dozen candidates hybrid recall already found (`HybridRetriever`'s `reranker`
 * option), and it never brings in a memory recall did not.
 *
 * A score is a judgement made at read time over the raw text and is never
 * stored: nothing about a memory changes when it is reranked, and swapping the
 * model changes only the order of the next recall.
 */

export interface Reranker {
  /** The model that scores, e.g. "Xenova/ms-marco-MiniLM-L-6-v2". */
  readonly model: string;
  /**
   * One relevance score per passage for this query, in passage order; higher
   * is more relevant. Scores are comparable within one call, not across calls
   * or models.
   */
  score(query: string, passages: string[]): Promise<number[]>;
}

/** Deterministic test reranker — the score comes from an injected function. */
export class FakeReranker implements Reranker {
  constructor(
    readonly model: string,
    private readonly scoreOf: (query: string, passage: string) => number,
  ) {}

  async score(query: string, passages: string[]): Promise<number[]> {
    return passages.map((p) => this.scoreOf(query, p));
  }
}

/**
 * Passage length the cross-encoder sees at once. The models read 512 tokens of
 * query and passage together; 1,000 characters is ~250 tokens of English, which
 * leaves room for a long question. Scripts that spend a token per character
 * (Chinese, Japanese) can overrun it, and the model then reads the start of the
 * window only: pass a smaller `maxChars` to `rerankTexts` for such text.
 */
export const PASSAGE_CHARS = 1000;
/** A memory longer than this many windows is scored on its first ones (a pasted document, say). */
export const MAX_WINDOWS = 8;

/**
 * A long text in windows the cross-encoder can read whole. Windows break
 * between sentences where they can, and each one after the first repeats the
 * sentence before it, so a fact stated across a boundary is read in one piece.
 * A text that fits is one window: itself.
 */
export function passageWindows(text: string, { maxChars = PASSAGE_CHARS, maxWindows = MAX_WINDOWS }: { maxChars?: number; maxWindows?: number } = {}): string[] {
  // A window that holds no character would never move forward.
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error(`passageWindows: maxChars must be an integer >= 1 (got ${maxChars})`);
  if (!Number.isInteger(maxWindows) || maxWindows < 1) throw new Error(`passageWindows: maxWindows must be an integer >= 1 (got ${maxWindows})`);
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];
  // Sentences (or lines), each no longer than a window: an over-long one is cut between words.
  const units: string[] = [];
  for (const sentence of trimmed.match(/[^.!?\n]*(?:[.!?]+["')\]]*|\n+|$)\s*/g) ?? [trimmed]) {
    if (sentence === "") continue;
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(" ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      units.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (rest.trim() !== "") units.push(rest);
  }
  const windows: string[] = [];
  let i = 0;
  while (i < units.length && windows.length < maxWindows) {
    let window = "";
    let j = i;
    while (j < units.length && (window === "" || window.length + units[j]!.length <= maxChars)) window += units[j++];
    windows.push(window.trim());
    // Step back one sentence for the overlap — when the window held more than
    // that sentence, and it fits beside the next one (else the step is wasted).
    const overlap = j - 1 > i && j < units.length && units[j - 1]!.length + units[j]!.length <= maxChars;
    i = overlap ? j - 1 : j;
  }
  return windows;
}

/**
 * Score every text for the query and return them best first, as
 * `{ index, score }` into `texts`. A text's score is its best window's. Ties
 * keep the order the texts came in, so what recall already ranked first stays
 * first when the cross-encoder cannot tell two memories apart.
 */
export async function rerankTexts(
  reranker: Reranker,
  query: string,
  texts: readonly string[],
  windowOptions: { maxChars?: number; maxWindows?: number } = {},
): Promise<{ index: number; score: number }[]> {
  const passages: string[] = [];
  const owner: number[] = [];
  texts.forEach((text, index) => {
    for (const w of passageWindows(text, windowOptions)) {
      passages.push(w);
      owner.push(index);
    }
  });
  const scores = passages.length === 0 ? [] : await reranker.score(query, passages);
  if (scores.length !== passages.length) throw new Error(`reranker ${reranker.model} returned ${scores.length} scores for ${passages.length} passages`);
  const best = texts.map(() => -Infinity);
  scores.forEach((s, k) => {
    const i = owner[k]!;
    // NaN never wins: a model that failed on one window leaves the others to decide.
    if (Number.isFinite(s) && s > best[i]!) best[i] = s;
  });
  return best.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * On-device cross-encoder via transformers.js — no API key, no per-call cost,
 * no text leaving the machine. The default, `Xenova/ms-marco-MiniLM-L-6-v2`,
 * is the reranking counterpart of the embedder's MiniLM: ~23 M parameters,
 * trained on MS MARCO question/passage pairs, one relevance logit per pair.
 * `Xenova/bge-reranker-base` is a larger (278 M) alternative with the same
 * interface. The model downloads once to the HF cache on first use, then runs
 * offline. Loaded lazily, so importing this module costs nothing.
 */
export class LocalReranker implements Reranker {
  readonly model: string;
  readonly dtype: string;
  private readonly batchSize: number;
  private loaded: Promise<{ tokenizer: PairTokenizer; classify: PairClassifier }> | undefined;

  constructor({ model = "Xenova/ms-marco-MiniLM-L-6-v2", dtype = "fp32", batchSize = 16 }: { model?: string; dtype?: string; batchSize?: number } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`LocalReranker: batchSize must be an integer >= 1 (got ${batchSize})`);
    this.model = model;
    this.dtype = dtype;
    this.batchSize = batchSize;
  }

  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    const { tokenizer, classify } = await this.load();
    const out: number[] = [];
    for (let i = 0; i < passages.length; i += this.batchSize) {
      const batch = passages.slice(i, i + this.batchSize);
      const inputs = tokenizer(batch.map(() => query), { text_pair: batch, padding: true, truncation: true });
      const { logits } = await classify(inputs);
      if (!logits) throw new Error(`${this.model} returned no logits: is it a sequence-classification (cross-encoder) model?`);
      out.push(...relevanceOfLogits(logits.tolist(), this.model));
    }
    return out;
  }

  private load(): Promise<{ tokenizer: PairTokenizer; classify: PairClassifier }> {
    this.loaded ??= (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
      const [tokenizer, classify] = await Promise.all([
        AutoTokenizer.from_pretrained(this.model),
        AutoModelForSequenceClassification.from_pretrained(this.model, { dtype: this.dtype as "fp32" }),
      ]);
      return { tokenizer: tokenizer as unknown as PairTokenizer, classify: classify as unknown as PairClassifier };
    })();
    // A failed load (no network on first use, say) is not cached: the next call tries again.
    this.loaded.catch(() => {
      this.loaded = undefined;
    });
    return this.loaded;
  }
}

/**
 * One relevance score per row of a cross-encoder's logits. Rerankers have one
 * output (the relevance logit); a two-class model's is "relevant" minus "not".
 */
export function relevanceOfLogits(rows: number[][], model = "reranker"): number[] {
  return rows.map((row) => {
    if (row.length === 1) return row[0]!;
    if (row.length === 2) return row[1]! - row[0]!;
    throw new Error(`${model}: expected one or two logits per pair, got ${row.length}`);
  });
}

type PairTokenizer = (text: string[], options: { text_pair: string[]; padding: boolean; truncation: boolean }) => unknown;
type PairClassifier = (inputs: unknown) => Promise<{ logits?: { tolist(): number[][] } }>;
