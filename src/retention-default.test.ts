import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

/** Schema §3.5 promised it; no reader did it (review 2026-09-01, idea 12). */
describe.each([
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(join(mkdtempSync(join(tmpdir(), "al-ret-")), "m.db"))],
])("%s keeps Archived and PendingDeletion out of active context by default", (_name, make) => {
  let store: ReturnType<typeof make>;
  beforeEach(() => {
    store = make();
  });
  afterEach(() => {
    const p = (store as { path?: string }).path;
    if (p) rmSync(join(p, ".."), { recursive: true, force: true });
  });

  it("hides them unless asked for by name", async () => {
    await store.addNode(makeNode({ content: { text: "live fact" }, retentionTier: "FullRetention" }));
    await store.addNode(makeNode({ content: { text: "cold fact" }, retentionTier: "Archived" }));
    await store.addNode(makeNode({ content: { text: "doomed fact" }, retentionTier: "PendingDeletion" }));
    const byDefault = (await store.searchNodes({})).map((n) => n.content.text);
    expect(byDefault).toEqual(["live fact"]);
    const named = (await store.searchNodes({ retentionTier: ["Archived"] })).map((n) => n.content.text);
    expect(named).toEqual(["cold fact"]);
  });
});
