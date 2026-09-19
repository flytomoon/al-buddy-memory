import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import type { NewMemoryNode } from "../types/memory.js";
import { ChainedAudit, type AuditEvent, type AuditSink } from "./audit.js";
import { govern } from "./governed-store.js";
import type { GovernancePolicy } from "./policy.js";

/**
 * R3 (release review, 2026-09-18): every mutator wrote to the store and THEN
 * recorded. `ChainedAudit` correctly refuses to append after a torn write, so
 * the caller was told the write failed — but the store kept accepting writes,
 * so a retrying MCP client compounded changes that nothing could attest to.
 * Three nodes persisted with one complete audit event in the review's repro.
 *
 * What stays, deliberately, is the FIRST window: a mutation commits before its
 * event is written, so the write that breaks the sink is itself unrecorded
 * (docs/policies/ENFORCEMENT.md). What must not happen is everything after it.
 */

const base = {
  provenance: "UserInput" as const,
  encryptionKeyRef: "test",
  memoryType: "Experience" as const,
  privacyClassification: "Private" as const,
  retentionTier: "FullRetention" as const,
  contextualMetadata: {},
  confidenceWeight: 1,
  decayRate: 0,
};
const node = (text: string): NewMemoryNode => ({ ...base, content: { text } });

const allowErase: GovernancePolicy = { name: "allow-erase", beforeErase: () => true };

/** A sink that works, then breaks the way a full disk breaks one. */
class FailsOnNthWrite implements AuditSink {
  readonly events: AuditEvent[] = [];
  constructor(private readonly failAt: number) {}
  record(event: AuditEvent): void {
    if (this.events.length + 1 === this.failAt) {
      this.events.push(event); // the line is half-written, like a torn append
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    this.events.push(event);
  }
}

describe("a broken audit trail stops the store changing", () => {
  it("does not keep writing after the sink has failed (the review's repro)", async () => {
    const inner = new InMemoryStore();
    const audit = new FailsOnNthWrite(2);
    const store = govern(inner, { policies: [], context: () => ({ actor: "owner" }), audit });

    await store.addNode(node("first"));
    // The second write commits and then breaks the sink — the documented window.
    await expect(store.addNode(node("second"))).rejects.toThrow(/ENOSPC/);
    // THE DEFECT, on 0.4.1: this third write also landed, unrecorded.
    await expect(store.addNode(node("third"))).rejects.toThrow(/verify-audit/);

    const stored = await inner.listNodes();
    expect(stored.map((n) => n.content.text).sort()).toEqual(["first", "second"]);
  });

  it("stops updates, erasures, links and imports too", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(node("standing"));
    const other = await inner.addNode(node("also standing"));
    const audit = new FailsOnNthWrite(1);
    const store = govern(inner, { policies: [allowErase], context: () => ({ actor: "owner" }), audit });

    await expect(store.addNode(node("breaks it"))).rejects.toThrow(/ENOSPC/);
    for (const attempt of [
      () => store.updateNode(fact.nodeId, { confidenceWeight: 0.1 }),
      () => store.deleteNode(fact.nodeId),
      () => store.addEdge({ sourceNodeId: fact.nodeId, targetNodeId: other.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserInput" }),
      () => store.restoreNode({ ...fact, confidenceWeight: 0.2 }),
      () => store.addNode(node("another")),
    ]) {
      await expect(attempt()).rejects.toThrow(/audit sink failed/);
    }

    // Nothing after the failure changed anything.
    expect((await inner.getNode(fact.nodeId))?.confidenceWeight).toBe(1);
    expect(await inner.getEdges(fact.nodeId)).toHaveLength(0);
    expect((await inner.listNodes()).map((n) => n.content.text).sort()).toEqual(["also standing", "breaks it", "standing"]);
  });

  it("stops every handle writing to the same trail, not only the one that hit it", async () => {
    const inner = new InMemoryStore();
    const audit = new FailsOnNthWrite(1);
    const one = govern(inner, { policies: [], context: () => ({ actor: "a" }), audit });
    const two = govern(inner, { policies: [], context: () => ({ actor: "b" }), audit });

    await expect(one.addNode(node("breaks it"))).rejects.toThrow(/ENOSPC/);
    await expect(two.addNode(node("from the other handle"))).rejects.toThrow(/audit sink failed/);
    expect(await inner.listNodes()).toHaveLength(1);
  });

  it("leaves a store with no audit sink alone", async () => {
    const inner = new InMemoryStore();
    const store = govern(inner, { policies: [], context: () => ({ actor: "owner" }) });
    await store.addNode(node("no sink, no latch"));
    await store.addNode(node("still writing"));
    expect(await inner.listNodes()).toHaveLength(2);
  });

  describe("against the real chained log", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-poison-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("stops after a torn append, and what is on disk still verifies up to the tear", async () => {
      const path = join(dir, "trail.jsonl");
      let writes = 0;
      const audit = new ChainedAudit(path, {
        append: async (file, data) => {
          const { appendFile } = await import("node:fs/promises");
          writes += 1;
          if (writes === 2) {
            await appendFile(file, data.slice(0, 20), "utf8"); // torn: 20 bytes, no newline
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          }
          await appendFile(file, data, "utf8");
        },
      });
      const inner = new InMemoryStore();
      const store = govern(inner, { policies: [], context: () => ({ actor: "owner" }), audit });

      await store.addNode(node("first"));
      await expect(store.addNode(node("second"))).rejects.toThrow(/ENOSPC/);
      await expect(store.addNode(node("third"))).rejects.toThrow();
      await expect(store.addNode(node("fourth"))).rejects.toThrow();

      expect((await inner.listNodes()).map((n) => n.content.text).sort()).toEqual(["first", "second"]);
      const text = readFileSync(path, "utf8");
      expect(text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2); // one whole line, one fragment
      expect(text.endsWith("\n")).toBe(false); // and verify-audit will say so
    });
  });
});
