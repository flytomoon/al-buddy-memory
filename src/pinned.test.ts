import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { PinnedBlocks } from "./pinned.js";

const clock = (iso: string) => () => new Date(iso);

describe("PinnedBlocks — the tier that is in every prompt", () => {
  it("pins, lists oldest-first, and renders as a block", async () => {
    const store = new InMemoryStore();
    const pins = new PinnedBlocks(store, { now: clock("2026-09-10T00:00:00Z") });
    await pins.pin({ text: "Al has no gender — say Al or they.", label: "identity" });
    const later = new PinnedBlocks(store, { now: clock("2026-09-10T01:00:00Z") });
    await later.pin({ text: "Never mention the time of day." });
    const list = await later.list();
    expect(list.map((b) => b.text)).toEqual(["Al has no gender — say Al or they.", "Never mention the time of day."]);
    const block = await later.render();
    expect(block.split("\n")).toEqual([
      "PINNED (always true, edit with pin/unpin):",
      "- [identity] Al has no gender — say Al or they.",
      "- Never mention the time of day.",
    ]);
  });

  it("pinning the same text again reinforces instead of duplicating", async () => {
    const store = new InMemoryStore();
    const pins = new PinnedBlocks(store);
    const a = await pins.pin({ text: "one rule" });
    const b = await pins.pin({ text: "one rule" });
    expect(b.nodeId).toBe(a.nodeId);
    expect((await pins.list()).length).toBe(1);
    const node = await store.getNode(a.nodeId);
    expect(node?.temporalAnchors.some((t) => t.event === "reinforced")).toBe(true);
  });

  it("unpin keeps the node — valid-time closes, nothing is deleted", async () => {
    const store = new InMemoryStore();
    const pins = new PinnedBlocks(store, { now: clock("2026-09-10T00:00:00Z") });
    const p = await pins.pin({ text: "temporary rule" });
    const later = new PinnedBlocks(store, { now: clock("2026-09-11T00:00:00Z") });
    expect(await later.unpin(p.nodeId)).toBe(true);
    expect(await later.list()).toEqual([]);
    const node = await store.getNode(p.nodeId);
    expect(node).toBeDefined();
    expect(node?.validTo).toBe("2026-09-11T00:00:00.000Z");
    expect(await later.unpin(p.nodeId)).toBe(false); // already unpinned
  });

  it("respects the prompt budget: newest pins win, and the overflow is named", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 5; i++) {
      await new PinnedBlocks(store, { now: clock(`2026-09-1${i}T00:00:00Z`) }).pin({ text: `rule ${i} ${"x".repeat(60)}` });
    }
    const block = await new PinnedBlocks(store, { budgetChars: 160, now: clock("2026-09-20T00:00:00Z") }).render();
    expect(block).toContain("rule 4");
    expect(block).not.toContain("rule 0");
    expect(block).toMatch(/\+\d older pins? over the 160-char budget/);
  });
});
