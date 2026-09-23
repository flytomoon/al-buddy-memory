import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode, runMemoryStoreConformance } from "./memory-store-conformance.spec.js";
import { runDerivedConformance } from "./derived-conformance.spec.js";

runMemoryStoreConformance("InMemoryStore", () => new InMemoryStore());
runDerivedConformance("InMemoryStore", () => new InMemoryStore());

describe("InMemoryStore — specifics", () => {
  it("reports its node count via `size`", async () => {
    const store = new InMemoryStore();
    expect(store.size).toBe(0);
    await store.addNode(makeNode());
    await store.addNode(makeNode());
    expect(store.size).toBe(2);
  });
});
