/**
 * Embeddings for semantic recall — LOCAL-FIRST and free.
 *
 * Per the memory architecture decision, embeddings are a disposable,
 * model-tagged cache over raw text (the source of truth). The default
 * embedder runs entirely on-device via transformers.js — no API key, no
 * per-call cost, no data leaving the machine. Upgrading models later is a
 * re-index, not a migration.
 */

export interface Embedder {
  /** Model tag stored with every vector (e.g. "xenova/all-MiniLM-L6-v2"). */
  readonly model: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity of two equal-length vectors ([-1, 1]; 1 = same direction). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Deterministic test embedder — vector comes from an injected function. */
export class FakeEmbedder implements Embedder {
  readonly modelVersion = "test";

  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly vectorize: (text: string) => number[],
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }
}

/**
 * On-device embedder via transformers.js (all-MiniLM-L6-v2, 384 dims).
 * The model (~25 MB) downloads once to the HF cache on first use, then runs
 * offline forever. Loaded lazily so importing this module costs nothing.
 */
export class LocalEmbedder implements Embedder {
  readonly model = "xenova/all-MiniLM-L6-v2";
  readonly modelVersion = "1";
  readonly dimensions = 384;

  private pipelinePromise: Promise<FeatureExtractor> | undefined;

  async embed(texts: string[]): Promise<number[][]> {
    const extract = await this.loadPipeline();
    const output = await extract(texts, { pooling: "mean", normalize: true });
    // Output tensor is (texts.length x dims) — tolist() gives number[][].
    return output.tolist();
  }

  private loadPipeline(): Promise<FeatureExtractor> {
    this.pipelinePromise ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "fp32",
      })) as unknown as FeatureExtractor;
    })();
    return this.pipelinePromise;
  }
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;
