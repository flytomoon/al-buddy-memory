import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { governanceTools } from "./mcp/governance-server.js";

const clock = (iso: string) => () => new Date(iso);

/**
 * Recall asked the store for twice the page and then threw away the superseded
 * facts in JavaScript, so a subject the person had corrected often enough
 * answered with nothing at all: sixteen retired facts about quokkas outranked
 * the one that is still true, filled the candidate list, and left an empty
 * page — while a store search at the same instant returned the current fact
 * straight away (Astra R7, reproduced in both stores, 2026-09-18).
 *
 * This file lives outside src/mcp on purpose: the release-blockers branch owns
 * that directory this week, and a new file collides with nothing.
 */
describe("MCP recall — the current facts, not a page of them", () => {
  it("finds the fact that is still true under sixteen retired ones", async () => {
    const store = new InMemoryStore();
    const tools = governanceTools({ store, now: clock("2026-09-18T00:00:00Z") });
    for (let i = 0; i < 16; i += 1) {
      const retired = await tools.remember({ text: `quokka quokka quokka note ${i}` });
      await tools.invalidate({ id: retired.id, reason: "superseded" });
    }
    const current = await tools.remember({ text: "the quokka sanctuary opens at nine" });

    const found = await tools.recall({ query: "quokka" });
    expect(found.map((f) => f.id)).toEqual([current.id]);
    expect(found.every((f) => f.current)).toBe(true);
  });

  it("still hands back the history when it is asked for", async () => {
    const store = new InMemoryStore();
    const tools = governanceTools({ store, now: clock("2026-09-18T00:00:00Z") });
    const first = await tools.remember({ text: "lives in London" });
    await tools.invalidate({ id: first.id, reason: "moved" });
    const second = await tools.remember({ text: "lives in Tokyo" });

    const all = await tools.recall({ query: "lives", includeSuperseded: true });
    expect(all.map((f) => f.id).sort()).toEqual([first.id, second.id].sort());
  });
});
