import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChainedAudit, verifyAuditChain, type AuditEvent } from "./audit.js";

/**
 * "Every governed decision is recorded" was a claim you had to take on trust:
 * an append-only file is only append-only until someone edits it. Each line
 * now carries the hash of the line before it and of its own event, so an edit,
 * a removal, a reorder or an insertion is detectable — and, with a key, a
 * wholesale rewrite by someone without the key. What no file can prove by
 * itself is that its TAIL was not cut off; that is what `head` is for: publish
 * the latest hash somewhere the file's owner does not control, and verify
 * against it.
 */
const event = (i: number): AuditEvent => ({
  at: new Date(Date.UTC(2026, 8, 15, 0, 0, i)).toISOString(),
  actor: i % 2 ? "agent" : "owner",
  purpose: "write",
  outcome: "allowed",
  nodeIds: [`node-${i}`],
  count: 1,
});

describe("the hash-chained audit log", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-chain-"));
    path = join(dir, "audit.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = () => readFileSync(path, "utf8").trimEnd().split("\n");
  const rewrite = (ls: string[]) => writeFileSync(path, ls.join("\n") + "\n");

  it("verifies a log it wrote, across a restart, and under concurrent appends", async () => {
    const first = new ChainedAudit(path);
    for (let i = 0; i < 3; i++) await first.record(event(i));
    const second = new ChainedAudit(path); // a new process picks the chain up
    await Promise.all(Array.from({ length: 20 }, (_, i) => second.record(event(3 + i))));
    const result = await verifyAuditChain(path);
    expect(result).toMatchObject({ ok: true, count: 23 });
    expect(result.head).toBe(await second.head());
  });

  it("names the line that was edited", async () => {
    const audit = new ChainedAudit(path);
    for (let i = 0; i < 5; i++) await audit.record(event(i));
    const ls = lines();
    const third = JSON.parse(ls[2]!);
    third.event.actor = "someone-else";
    ls[2] = JSON.stringify(third);
    rewrite(ls);
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, line: 3, reason: expect.stringMatching(/edited/) });
  });

  it("notices a line removed, a line inserted, and two lines swapped", async () => {
    const audit = new ChainedAudit(path);
    for (let i = 0; i < 5; i++) await audit.record(event(i));
    const original = lines();

    rewrite([original[0]!, original[1]!, original[3]!, original[4]!]);
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, line: 3, reason: expect.stringMatching(/removed|inserted|reordered/) });

    rewrite([original[0]!, original[1]!, original[1]!, original[2]!, original[3]!, original[4]!]);
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, line: 3 });

    rewrite([original[0]!, original[2]!, original[1]!, original[3]!, original[4]!]);
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, line: 2 });
  });

  it("a cut-off tail is caught only against a head anchored somewhere else", async () => {
    const audit = new ChainedAudit(path);
    for (let i = 0; i < 5; i++) await audit.record(event(i));
    const anchored = await audit.head();
    rewrite(lines().slice(0, 3));
    expect((await verifyAuditChain(path)).ok).toBe(true); // the file alone cannot know
    expect(await verifyAuditChain(path, { head: anchored })).toMatchObject({ ok: false, reason: expect.stringMatching(/head/) });
  });

  it("with a key, a rewrite by someone who does not hold it fails from the first line", async () => {
    const key = "a secret the log's owner keeps elsewhere";
    const audit = new ChainedAudit(path, { key });
    for (let i = 0; i < 3; i++) await audit.record(event(i));
    expect((await verifyAuditChain(path, { key })).ok).toBe(true);

    // Forge the whole file with a freshly computed, unkeyed chain.
    rmSync(path);
    const forger = new ChainedAudit(path);
    for (let i = 0; i < 3; i++) await forger.record({ ...event(i), actor: "forged" });
    expect(await verifyAuditChain(path, { key })).toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/edited/) });
  });

  it("an empty log verifies as empty; a missing one is NOT intact; garbage is named", async () => {
    // A verifier that calls a wrong path "intact: 0 events" is worse than none (Fable final review).
    expect(await verifyAuditChain(join(dir, "nope.jsonl"))).toMatchObject({ ok: false, reason: expect.stringMatching(/no such file/) });
    writeFileSync(path, "");
    expect(await verifyAuditChain(path)).toMatchObject({ ok: true, count: 0 });
    writeFileSync(path, "not json\n");
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/JSON/) });
  });

  it("refuses to extend a log whose last line is not a chained record — with an error, not a dead process", async () => {
    // Fable final review: the head promise was left rejected with no handler, so
    // an old-format or crash-truncated last line killed the process on the next
    // write — after the store write had already committed.
    for (const lastLine of [JSON.stringify(event(0)), '{"prev":"00000000']) {
      writeFileSync(path, lastLine + "\n");
      const audit = new ChainedAudit(path);
      await expect(audit.head()).rejects.toThrow(/chained audit log|incomplete/);
      await expect(audit.record(event(1))).rejects.toThrow(/chained audit log|incomplete/);
      await expect(audit.record(event(2))).rejects.toThrow(/chained audit log|incomplete/);
      expect(readFileSync(path, "utf8")).toBe(lastLine + "\n"); // nothing appended to a log it cannot chain
    }
  });

  it("covers every field on a line, and never exposes the key", async () => {
    const key = "keep-me-private";
    const audit = new ChainedAudit(path, { key });
    await audit.record(event(0));
    const [only] = lines();
    rewrite([JSON.stringify({ ...JSON.parse(only!), note: "planted" })]);
    expect(await verifyAuditChain(path, { key })).toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/outside the chain/) });
    const { inspect } = await import("node:util");
    expect(JSON.stringify(audit)).not.toContain(key);
    expect(inspect(audit, { showHidden: true, depth: 5 })).not.toContain(key);
  });
});
