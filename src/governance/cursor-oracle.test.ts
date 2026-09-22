import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../in-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryStore } from "../types/memory.js";
import { govern } from "./governed-store.js";
import { personalDefaults } from "./samples.js";

/**
 * Review 2026-09-22: a paging cursor the actor cannot see must answer exactly as
 * a cursor that does not exist, in either order of hidden and visible facts —
 * otherwise `after` is an oracle for which hidden ids exist.
 */
describe("a hidden cursor pages like a missing one", () => {
  afterEach(() => vi.useRealTimers());
  for (const [label, make] of [
    ["InMemoryStore", () => new InMemoryStore()],
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
  ] as [string, () => MemoryStore][]) {
    for (const hiddenFirst of [true, false]) {
      it(`${label}: hidden fact ${hiddenFirst ? "older" : "newer"} than the visible one`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const inner = make();
        const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
        const add = async (text: string, second: number) => {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, second)));
          return owner.addNode(makeNode({ content: { text } }));
        };
        const hidden = await add("password: hunter2", hiddenFirst ? 1 : 2);
        await add("likes sourdough", hiddenFirst ? 2 : 1);
        const ai = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });
        for (const extra of [{}, { limit: 5 }, { query: "password" }]) {
          const afterHidden = await ai.searchNodes({ ...extra, after: hidden.nodeId });
          const afterMissing = await ai.searchNodes({ ...extra, after: "00000000-0000-4000-8000-00000000dead" });
          expect(afterHidden).toEqual(afterMissing);
        }
      });
    }
  }
});
