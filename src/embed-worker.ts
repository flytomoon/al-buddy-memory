/**
 * The on-device embedding model, run in a worker thread.
 *
 * Loading the model and running it are synchronous native work: about 360 ms
 * of a blocked event loop to load, and about 60 ms per batch of 32 facts. On
 * the main thread of a server that is time no request is answered — the HTTP
 * connector took seconds to answer /health while it embedded an existing
 * memory after start (founder's Mac, 2026-10-03). Here it blocks only this
 * thread. Protocol: `{ id, texts }` in, `{ id, vectors }` or `{ id, error }` out.
 */
import { parentPort, workerData } from "node:worker_threads";

import { loadFeatureExtractor, type FeatureExtractor } from "./embedder.js";

const { cacheDir } = (workerData ?? {}) as { cacheDir?: string };
let extractor: Promise<FeatureExtractor> | undefined;

parentPort?.on("message", async (msg: { id: number; texts: string[] }) => {
  try {
    extractor ??= loadFeatureExtractor(cacheDir);
    const output = await (await extractor)(msg.texts, { pooling: "mean", normalize: true });
    parentPort!.postMessage({ id: msg.id, vectors: output.tolist() });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
  }
});
