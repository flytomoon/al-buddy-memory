/**
 * {@link LocalEmbedder}'s model, off the event loop: the same model, tag and
 * vectors, computed in a worker thread (`embed-worker.js`) so a server keeps
 * answering while the model loads and while it embeds an existing memory.
 * The shipped servers use this; a library caller can too.
 */
import { Worker } from "node:worker_threads";

import type { Embedder } from "./embedder.js";

export interface WorkerEmbedderOptions {
  /** Where the model is kept after its one-time download (as for LocalEmbedder). */
  cacheDir?: string;
  /** The worker module (default: the shipped `embed-worker.js`). Tests pass their own. */
  workerUrl?: URL;
}

export class WorkerEmbedder implements Embedder {
  // The same tag as LocalEmbedder: vectors from either are interchangeable.
  readonly model = "xenova/all-MiniLM-L6-v2";
  readonly modelVersion = "1";
  readonly dimensions = 384;

  private worker: Worker | undefined;
  private nextId = 0;
  private dead: string | undefined;
  private readonly pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

  constructor(private readonly options: WorkerEmbedderOptions = {}) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const url = this.options.workerUrl ?? new URL("./embed-worker.js", import.meta.url);
    const worker = new Worker(url, { workerData: { cacheDir: this.options.cacheDir } });
    // Never the reason a process stays alive: the server's own handles do that.
    worker.unref();
    worker.on("message", (msg: { id: number; vectors?: number[][]; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined || !msg.vectors) p.reject(new Error(msg.error ?? "the embedding worker returned nothing"));
      else p.resolve(msg.vectors);
    });
    const fail = (reason: string) => {
      this.dead ??= reason;
      this.worker = undefined;
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    };
    worker.on("error", (err) => fail(`the embedding worker failed: ${err.message}`));
    worker.on("exit", (code) => fail(`the embedding worker exited (code ${code})`));
    this.worker = worker;
    return worker;
  }

  embed(texts: string[]): Promise<number[][]> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    if (texts.length === 0) return Promise.resolve([]);
    const worker = this.start();
    const id = this.nextId++;
    // A pending request holds the process open until it answers; the idle worker does not.
    const settle = () => {
      if (this.pending.size === 0) this.worker?.unref();
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => {
          resolve(v);
          settle();
        },
        reject: (e) => {
          reject(e);
          settle();
        },
      });
      worker.ref();
      worker.postMessage({ id, texts });
    });
  }

  /** Stop the worker. Pending embeds reject; a later embed refuses. */
  async close(): Promise<void> {
    const w = this.worker;
    this.dead ??= "the embedder was closed";
    if (w) await w.terminate();
  }
}
