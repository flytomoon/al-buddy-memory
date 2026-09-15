import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { MemoryAudit } from "../governance/audit.js";
import { governanceTools, serverStore } from "./governance-server.js";

const clock = (iso: string) => () => new Date(iso);

describe("governance MCP tools — every answer carries provenance and validity", () => {
  it("remember → recall returns provenance, validFrom, current=true, confidence", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store, now: clock("2026-09-10T12:00:00Z") });
    const saved = await t.remember({ text: "Chris prefers Pacific time in reports", provenance: "UserInput" });
    expect(saved).toMatchObject({ provenance: "UserInput", validFrom: "2026-09-10T12:00:00.000Z", validTo: null, current: true, confidence: 1, supersededBy: null });
    const found = await t.recall({ query: "Pacific" });
    expect(found.map((f) => f.id)).toEqual([saved.id]);
  });

  it("invalidate closes validity, keeps the record, names the successor; recall hides it unless asked", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store, now: clock("2026-09-10T12:00:00Z") });
    const london = await t.remember({ text: "Lives in London" });
    const tokyo = await t.remember({ text: "Lives in Tokyo" });
    const later = governanceTools({ store, now: clock("2026-09-11T00:00:00Z") });
    const closed = await later.invalidate({ id: london.id, replacedBy: tokyo.id, reason: "moved" });
    expect(closed).toMatchObject({ id: london.id, validTo: "2026-09-11T00:00:00.000Z", current: false, supersededBy: tokyo.id });
    expect(await store.getNode(london.id)).not.toBeNull();
    const current = await later.recall({ query: "Lives" });
    expect(current.map((f) => f.text)).toEqual(["Lives in Tokyo"]);
    const all = await later.recall({ query: "Lives", includeSuperseded: true });
    expect(all.map((f) => f.text).sort()).toEqual(["Lives in London", "Lives in Tokyo"]);
  });

  it("invalidate is idempotent and refuses unknown ids; remember refuses empty text", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    await expect(t.invalidate({ id: "nope" })).rejects.toThrow(/no fact nope/);
    await expect(t.remember({ text: "   " })).rejects.toThrow(/text is required/);
    const a = await t.remember({ text: "x" });
    const once = await t.invalidate({ id: a.id });
    const twice = await t.invalidate({ id: a.id });
    expect(twice.validTo).toBe(once.validTo);
  });

  it("pin / pinned / unpin ride the same store", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    const p = await t.pin({ text: "Al has no gender", label: "identity" });
    expect((await t.pinned()).rendered).toContain("[identity] Al has no gender");
    expect(await t.unpin({ id: p.nodeId })).toEqual({ unpinned: true });
    expect((await t.pinned()).blocks).toHaveLength(0);
  });
});

/**
 * The "governance MCP server" ran on the raw store: no policy, no audit
 * (review 2026-09-14, Fable §2.4). The shipped server now serves a governed
 * handle whose audience is the AI client, so the owner's own policy applies.
 */
describe("the shipped server's store", () => {
  it("classifies a secret the AI writes, keeps it out of the AI's recall, and audits every call", async () => {
    const audit = new MemoryAudit();
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner, { owner: "owner", audit }) });

    const secret = await t.remember({ text: "the deploy password: hunter2-staging" });
    await t.remember({ text: "prefers Pacific time" });
    expect((await inner.getNode(secret.id))?.privacyClassification).toBe("Sensitive");

    const recalled = await t.recall({ query: "password" });
    expect(recalled).toEqual([]);
    expect((await t.recall({ query: "Pacific" })).map((f) => f.text)).toEqual(["prefers Pacific time"]);
    expect(audit.events.some((e) => e.outcome === "hidden" && e.nodeIds.includes(secret.id))).toBe(true);
    expect(audit.events.every((e) => e.audience === "mcp-client")).toBe(true);
  });

  it("a hidden secret never takes the place of a fact the AI may see (no probing by page count)", async () => {
    const inner = new InMemoryStore();
    const owner = governanceTools({ store: inner });
    for (let i = 0; i < 12; i++) await owner.remember({ text: `password: hunter-${i}` }); // raw store: written Private...
    for (const n of await inner.listNodes()) await inner.updateNode(n.nodeId, { privacyClassification: "Sensitive" }); // ...and made Sensitive
    await owner.remember({ text: "password managers are allowed at work" });
    const ai = governanceTools({ store: serverStore(inner, { owner: "owner" }) });
    expect((await ai.recall({ query: "password", limit: 1 })).map((f) => f.text)).toEqual(["password managers are allowed at work"]);
  });
});
