import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkerEmbedder } from "./worker-embedder.js";

// A stand-in for embed-worker.js speaking the same protocol. It burns CPU on
// purpose: the point is that the burn happens on ITS thread, not the caller's.
const FAKE = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, texts }) => {
  if (texts.includes("crash")) process.exit(3);
  if (texts.includes("fail")) return parentPort.postMessage({ id, error: "no model here" });
  const until = Date.now() + 150; while (Date.now() < until) {}
  parentPort.postMessage({ id, vectors: texts.map((t) => [t.length, 1]) });
});`;

let dir: string;
let url: URL;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abm-worker-"));
  writeFileSync(join(dir, "fake-worker.mjs"), FAKE);
  url = pathToFileURL(join(dir, "fake-worker.mjs"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WorkerEmbedder — the model off the event loop", () => {
  it("returns the worker's vectors, and the caller's loop keeps running while it computes", async () => {
    const e = new WorkerEmbedder({ workerUrl: url });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const vectors = await e.embed(["ab", "abcd"]);
    clearInterval(timer);
    expect(vectors).toEqual([[2, 1], [4, 1]]);
    // 150 ms of work in the worker: an in-thread embedder would allow zero ticks.
    expect(ticks).toBeGreaterThanOrEqual(10);
    await e.close();
  });

  it("carries the LocalEmbedder's model tag, so existing vectors stay valid", () => {
    const e = new WorkerEmbedder({ workerUrl: url });
    expect([e.model, e.modelVersion, e.dimensions]).toEqual(["xenova/all-MiniLM-L6-v2", "1", 384]);
  });

  it("rejects with the worker's reason, and keeps serving later calls", async () => {
    const e = new WorkerEmbedder({ workerUrl: url });
    await expect(e.embed(["fail"])).rejects.toThrow(/no model here/);
    expect(await e.embed(["x"])).toEqual([[1, 1]]);
    await e.close();
  });

  it("rejects what is pending when the worker dies, and refuses afterwards", async () => {
    const e = new WorkerEmbedder({ workerUrl: url });
    await expect(e.embed(["crash"])).rejects.toThrow(/exited/);
    await expect(e.embed(["x"])).rejects.toThrow(/exited/);
  });

  it("refuses after close", async () => {
    const e = new WorkerEmbedder({ workerUrl: url });
    await e.embed(["x"]);
    await e.close();
    await expect(e.embed(["x"])).rejects.toThrow(/closed/);
  });
});
