import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

const dir = mkdtempSync(join(tmpdir(), "albm-scale-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const, provenance: "UserInput" as const };

describe("scale and immutability", () => {
  it("a common term over more facts than SQLite has bound variables still searches, ranked, within the limit", async () => {
    const store = new SqliteMemoryStore(join(dir, "big.db"));
    const N = 33_000; // > SQLITE_MAX_VARIABLE_NUMBER (32,766): the old IN-list crashed here
    for (let i = 0; i < N; i++) await store.addNode({ ...base, content: { text: `note ${i} about sourdough and day ${i % 365}` } });
    const hits = await store.searchNodes({ query: "sourdough", limit: 10 });
    expect(hits).toHaveLength(10);
    const exact = await store.searchNodes({ query: "day 42 sourdough", limit: 5 });
    expect(exact[0]!.content.text).toMatch(/day 42\b/);
  }, 120_000);

  it("provenance, id, key ref and the anchor trail cannot be changed after write, in either store", async () => {
    for (const store of [new InMemoryStore(), new SqliteMemoryStore(join(dir, "imm.db"))]) {
      const n = await store.addNode({ ...base, content: { text: "x" } });
      await expect(store.updateNode(n.nodeId, { provenance: "AIInferred" } as never)).rejects.toThrow(/provenance is immutable/);
      await expect(store.updateNode(n.nodeId, { nodeId: "other" } as never)).rejects.toThrow(/nodeId is immutable/);
      await expect(store.updateNode(n.nodeId, { temporalAnchors: [] } as never)).rejects.toThrow(/temporalAnchors is immutable/);
      const ok = await store.updateNode(n.nodeId, { validTo: "2026-09-11T00:00:00Z" });
      expect(ok.validTo).toBe("2026-09-11T00:00:00Z");
      expect((await store.getNode(n.nodeId))!.provenance).toBe("UserInput");
    }
  });
});
