/**
 * Semantic recall for the shipped servers, switched on without holding the
 * server hostage to it.
 *
 * The stdio server used to start with no embedder at all, so the server people
 * actually install answered with keyword recall only — not the hybrid
 * keyword-plus-vector recall the LongMemEval result was measured on (founder
 * question, 2026-10-03). The on-device model is an optional dependency and a
 * one-time download, and either can be missing: no `@huggingface/transformers`,
 * a platform onnxruntime has no binary for, no network on first run. So:
 *
 * - The server starts at once on keyword recall; the model loads beside it.
 * - When the model answers a probe, recall becomes hybrid from the next call.
 * - When it cannot load, recall stays keyword and stderr says so ONCE, with why.
 * - Facts written before the model was there (or by a host without one) are
 *   embedded in the background, a bounded number per start.
 *
 * Nothing here can fail the server: every path ends in "keyword recall".
 */
import type { Embedder } from "../embedder.js";
import { indexMissingEmbeddings } from "../hybrid-retriever.js";
import type { MemoryStore } from "../types/memory.js";

/** How many facts one start embeds in the background; the rest wait for the next start. */
export const DEFAULT_INDEX_LIMIT = 5_000;
/** Facts per embedding call in the background pass; writes between calls are time-sliced. */
const INDEX_BATCH = 16;

export type SemanticStatus =
  | { state: "loading" }
  | { state: "ready"; model: string; indexed: number }
  | { state: "off"; reason: string };

export interface SemanticRecall {
  /** The embedder once it has answered its probe; undefined while loading or when unavailable. */
  current(): Embedder | undefined;
  status(): SemanticStatus;
  /** Settles when loading and the background index pass are both done (never rejects). */
  settled: Promise<SemanticStatus>;
  /** A recall that used the embedder failed: stop using it, and say so once. */
  disable(reason: string): void;
}

export interface SemanticOptions {
  /** Builds the embedder (default: the on-device model in a worker thread — WorkerEmbedder — kept in `modelCacheDir`). */
  load?: () => Promise<Embedder> | Embedder;
  /** Where the default embedder keeps its downloaded model (default: transformers.js's own cache). */
  modelCacheDir?: string;
  /** The RAW store to backfill vectors into (vectors are a cache; what recall may SEE is decided at read time). */
  indexStore?: MemoryStore;
  /** Facts embedded per start; 0 skips the backfill. */
  indexLimit?: number;
  /** Where the one-line notices go (default stderr — stdout is the MCP channel). */
  log?: (line: string) => void;
  /** Set to switch it off by configuration: recall stays keyword, nothing loads. */
  disabledBy?: string;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);

export function startSemanticRecall(opts: SemanticOptions = {}): SemanticRecall {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let embedder: Embedder | undefined;
  let status: SemanticStatus = { state: "loading" };
  let announcedOff = false;
  const off = (reason: string) => {
    embedder = undefined;
    status = { state: "off", reason };
    if (!announcedOff) {
      announcedOff = true;
      log(`al-buddy-memory: semantic recall is off (${reason}); recall is keyword-only.`);
    }
    return status;
  };

  const settled = (async (): Promise<SemanticStatus> => {
    if (opts.disabledBy) return off(opts.disabledBy);
    let candidate: Embedder;
    try {
      // The default runs the model in a worker thread: loading it and embedding
      // with it are synchronous native work that would otherwise stall every
      // request the server is answering (2026-10-03: seconds, on the connector).
      candidate = opts.load ? await opts.load() : new (await import("../worker-embedder.js")).WorkerEmbedder(opts.modelCacheDir ? { cacheDir: opts.modelCacheDir } : {});
      // The probe is what proves the optional dependency, the native runtime and
      // the model are all there — constructing the embedder proves none of them.
      const [probe] = await candidate.embed(["al-buddy-memory warm-up"]);
      if (!probe || probe.length !== candidate.dimensions) throw new Error(`the model returned ${probe?.length ?? 0} dimensions, expected ${candidate.dimensions}`);
    } catch (err) {
      return off(`the on-device embedder could not load: ${reasonOf(err)}`);
    }
    if ((status as SemanticStatus).state === "off") return status; // disable() ran while it loaded
    embedder = candidate;
    status = { state: "ready", model: candidate.model, indexed: 0 };
    log(`al-buddy-memory: semantic recall is on (${candidate.model}).`);
    const limit = opts.indexLimit ?? DEFAULT_INDEX_LIMIT;
    if (opts.indexStore && limit > 0) {
      try {
        const indexed = await indexMissingEmbeddings(opts.indexStore, candidate, INDEX_BATCH, { limit });
        const now = status as SemanticStatus;
        if (now.state === "ready") status = { ...now, indexed };
        if (indexed > 0) log(`al-buddy-memory: embedded ${indexed} fact(s) for semantic recall${indexed >= limit ? ` (the next start continues past ${limit})` : ""}.`);
      } catch (err) {
        // A failed backfill leaves facts keyword-findable only; recall itself still works.
        log(`al-buddy-memory: background indexing stopped: ${reasonOf(err)}`);
      }
    }
    return status;
  })();

  return {
    current: () => embedder,
    status: () => status,
    settled,
    disable: (reason: string) => {
      off(reason);
    },
  };
}
