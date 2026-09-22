import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { exportPortable, importPortable } from "./memory-portability.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

/**
 * Review 2026-09-22: a clock stepped back between two changes to one fact made
 * the store's own export unimportable — "version … is dated before its fact was
 * learned". A backup you could take but could not restore, again.
 */
describe("a clock that steps back cannot break the store's own round trip", () => {
  afterEach(() => vi.useRealTimers());

  for (const [label, make] of [
    ["InMemoryStore", () => new InMemoryStore()],
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
  ] as [string, () => MemoryStore][]) {
    it(`${label}: export → import after an update and a re-import made while the clock was behind`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-22T10:00:05.000Z"));
      const src = make();
      const fact = await src.addNode(makeNode({ content: { text: "clock fact" } }));
      vi.setSystemTime(new Date("2026-09-22T10:00:01.000Z"));
      await src.updateNode(fact.nodeId, { confidenceWeight: 0.5 });
      // A second store refreshed from the first while its own clock is behind:
      // the `restored` version it writes must still come after what it held.
      const dst = make();
      vi.setSystemTime(new Date("2026-09-22T10:00:10.000Z"));
      await importPortable(await exportPortable(new Map([["p", src]])), () => dst);
      await src.updateNode(fact.nodeId, { confidenceWeight: 0.3 });
      await importPortable(await exportPortable(new Map([["p", src]])), () => dst);
      vi.setSystemTime(new Date("2026-09-22T10:00:02.000Z"));
      await dst.updateNode(fact.nodeId, { confidenceWeight: 0.2 });

      vi.setSystemTime(new Date("2026-09-22T10:00:20.000Z"));
      for (const store of [src, dst]) {
        const fresh = make();
        await expect(importPortable(await exportPortable(new Map([["p", store]])), () => fresh)).resolves.toBeDefined();
        expect((await fresh.getNode(fact.nodeId))?.confidenceWeight).toBe((await store.getNode(fact.nodeId))?.confidenceWeight);
      }
    });
  }
});
