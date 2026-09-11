import { describe, expect, it } from "vitest";

import type { MemoryEmbedding } from "./types/memory.js";

import type { Embedder } from "./embedder.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";

/** Review 2026-09-01, idea 6: one parse of the vectors per burst, not per recall. */
describe("HybridRetriever vector cache", () => {
  it("lists embeddings once per TTL window, and again after its own index write", async () => {
    const store = new InMemoryStore();
    let lists = 0;
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "listEmbeddings") {
          return async (model: string): Promise<MemoryEmbedding[]> => {
            lists += 1;
            return target.listEmbeddings(model);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const embedder: Embedder = { model: "test", dimensions: 3, embed: async (texts) => texts.map(() => [1, 0, 0]) };
    let clock = 1_000;
    const r = new HybridRetriever(counting, embedder, { cacheTtlMs: 1_000, now: () => clock });
    const node = await store.addNode(makeNode({ content: { text: "vectors everywhere" } }));
    await r.indexNode(node);
    await r.recall("vectors");
    await r.recall("vectors");
    await r.recall("vectors");
    expect(lists).toBe(1);
    await r.indexNode(node);
    await r.recall("vectors");
    expect(lists).toBe(2);
    clock += 5_000;
    await r.recall("vectors");
    expect(lists).toBe(3);
  });
});
