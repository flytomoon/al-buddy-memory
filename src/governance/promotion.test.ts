/**
 * promote / withdraw on every store — SQLite, Postgres (PGlite here) and
 * in-memory — under the teamMemory sample (docs/policies/scopes.md#promotion):
 * a promotion writes a new fact and one `promote` event naming both, the
 * source is untouched, only the author completes one, an org promotion needs
 * an admin's approval, some facts are never promoted, a withdrawal closes the
 * copy and deletes nothing, and erasing the source leaves the copy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import { exportPortable, PORTABLE_FORMAT_VERSION } from "../memory-portability.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { governanceTools, PROMOTE_REFUSED, serverStore } from "../mcp/governance-server.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { ChainedAudit, storeAudit, visitTrail, type AuditCapable, type AuditEvent, type AuditSink, type AuditVerifiable } from "./audit.js";
import { RECEIPT_OUTSIDE } from "./erasure.js";
import { exportView, govern } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy, type PolicyContext } from "./policy.js";
import { promotionOf, verifyPromotion } from "./promotion.js";
import { teamMemory, teamMemoryAttributes, type TeamMemoryOptions } from "./samples.js";

let pg: PGlite;
let tenant = 0;
const dirs: string[] = [];
beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
});
afterAll(async () => {
  await pg.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A store and the trail its governed handles write to — the store's own table, or a chained file. */
type Rig = { inner: MemoryStore; audit: AuditSink; trail: string | AuditVerifiable };

const makers: [string, () => Promise<Rig>][] = [
  [
    "sqlite",
    async () => {
      const inner = new SqliteMemoryStore(":memory:");
      return { inner, audit: storeAudit(inner), trail: inner };
    },
  ],
  [
    "postgres",
    async () => {
      const inner = new PostgresMemoryStore({ tenantId: `promotion-${++tenant}`, client: pg });
      await inner.initialize();
      return { inner, audit: storeAudit(inner as PostgresMemoryStore & AuditCapable), trail: inner };
    },
  ],
  [
    "in-memory",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "promotion-"));
      dirs.push(dir);
      const path = join(dir, "audit.jsonl");
      return { inner: new InMemoryStore(), audit: new ChainedAudit(path), trail: path };
    },
  ],
];

const AT = "2026-01-05T00:00:00.000Z";
const seed = (id: string, text: string, labels: Record<string, unknown>, extra: Partial<MemoryNode> = {}): MemoryNode => ({
  ...makeNode({ content: { text }, contextualMetadata: labels, provenance: "AIInferred", confidenceWeight: 0.8 }),
  nodeId: id,
  temporalAnchors: [{ event: "created", timestamp: AT }],
  validFrom: AT,
  validTo: null,
  ...extra,
});

const SEEDS: MemoryNode[] = [
  seed("ana-tip", "Deploys go out on Tuesdays after the freeze", { scope: "user:ana", author: "ana", tags: ["deploy"], origin: { app: "x" } }),
  seed("ana-public", "The office opens at eight", { scope: "user:ana", author: "ana" }, { privacyClassification: "Public" }),
  seed("ana-sensitive", "Ana's appraisal notes", { scope: "user:ana", author: "ana" }, { privacyClassification: "Sensitive" }),
  seed("ana-sealed", "Ana's medical leave", { scope: "user:ana", author: "ana" }, { privacyClassification: "Sealed" }),
  seed("ana-binned", "An old idea", { scope: "user:ana", author: "ana" }, { retentionTier: "PendingDeletion" }),
  seed("ana-retired", "Standups were at nine", { scope: "user:ana", author: "ana" }, { validTo: "2026-01-06T00:00:00.000Z" }),
  seed("ana-rate", "Ana's client rate is 120", { scope: "user:ana", author: "ana", rate: "120" }),
  seed("ana-secret", "The staging api key: sk-test-0123456789abcdefXYZ", { scope: "user:ana", author: "ana" }),
  seed("blue-by-ana", "Blue team release checklist", { scope: "team:blue", author: "ana" }),
  seed("ben-own", "Ben's own note", { scope: "user:ben", author: "ben" }),
  seed("root-own", "Root's own rule for on-call", { scope: "user:root", author: "root" }),
];

const allowErase: GovernancePolicy = { name: "allow-erase", beforeErase: () => true };

/** Hides the `rate` label from ana: she sees her own fact redacted. */
const hideRate: GovernancePolicy = {
  name: "hide-rate",
  beforeRead(node: MemoryNode, ctx: PolicyContext) {
    if (ctx.actor !== "ana" || node.contextualMetadata["rate"] === undefined) return node;
    const { rate: _r, ...rest } = node.contextualMetadata;
    return { ...node, contextualMetadata: rest };
  },
};

function handle(rig: Rig, actor: string, attrs: { teams?: string[]; roles?: string[] } = {}, opts: TeamMemoryOptions & { extra?: GovernancePolicy[] } = {}) {
  const attributes = teamMemoryAttributes(actor, attrs);
  const { extra = [], ...team } = opts;
  return govern(rig.inner, { policies: [teamMemory(team), ...extra], context: () => ({ actor, attributes }), audit: rig.audit });
}

async function trailEvents(rig: Rig): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  const ok = await visitTrail(rig.trail, (e) => events.push(e));
  expect(ok).toEqual({ ok: true });
  return events;
}

describe.each(makers)("promote and withdraw (%s)", (_name, make) => {
  async function rig(): Promise<Rig> {
    const r = await make();
    for (const n of SEEDS) await r.inner.restoreNode(n);
    return r;
  }

  it("the author shares with their own team: a new fact, the source untouched, one promote event naming both", async () => {
    const r = await rig();
    const before = await r.inner.getNode("ana-tip");
    const ana = handle(r, "ana", { teams: ["blue"] });
    const { copyId, event } = await ana.promote("ana-tip", { to: "team:blue", basis: "self" });
    expect(copyId).not.toBe("ana-tip");

    const copy = (await r.inner.getNode(copyId))!;
    expect(copy.content.text).toBe("Deploys go out on Tuesdays after the freeze");
    expect(copy.provenance).toBe("AIInferred");
    expect(copy.confidenceWeight).toBe(0.8);
    expect(copy.privacyClassification).toBe("Private");
    expect(copy.validFrom).toBe(AT);
    expect(copy.validTo).toBeNull();
    // Only the convention's labels: the source's tags and origin were never approved for sharing.
    expect(copy.contextualMetadata).toEqual({
      scope: "team:blue",
      author: "ana",
      promotion: { from: "ana-tip", by: "ana", approvedBy: null, at: event.at, basis: "self", edited: false },
    });
    expect(await r.inner.getNode("ana-tip")).toEqual(before);
    expect(await r.inner.getEdges("ana-tip")).toEqual([]);

    // A teammate reads the copy and still not the original; someone off the team reads neither.
    const bo = handle(r, "bo", { teams: ["blue"] });
    expect((await bo.getNode(copyId))?.content.text).toBe(copy.content.text);
    expect(await bo.getNode("ana-tip")).toBeUndefined();
    expect(await handle(r, "ben", { teams: ["red"] }).getNode(copyId)).toBeUndefined();

    const promoted = (await trailEvents(r)).filter((e) => e.purpose === "promote");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ actor: "ana", outcome: "allowed", nodeIds: ["ana-tip", copyId], count: 2 });
    expect(JSON.parse(promoted[0]!.reason!)).toEqual({ to: "team:blue", basis: "self", approvedBy: null, edited: false });
    expect(event).toMatchObject({ purpose: "promote", nodeIds: ["ana-tip", copyId], reason: promoted[0]!.reason });

    const check = await verifyPromotion(copyId, r.trail);
    expect(check).toMatchObject({ ok: true, promotion: { from: "ana-tip", actor: "ana", to: "team:blue", basis: "self", approvedBy: null, edited: false }, withdrawn: null });
    expect(await verifyPromotion("ana-tip", r.trail)).toMatchObject({ ok: false });
  });

  it("approved text and fields: the copy holds the edited words, the event only the field names", async () => {
    const r = await rig();
    const ana = handle(r, "ana", { teams: ["blue"] });
    const { copyId } = await ana.promote("ana-tip", { to: "team:blue", basis: "self", text: "Deploys go out on Tuesdays", fields: { category: "release", weekly: true, hours: 2 } });
    const copy = (await r.inner.getNode(copyId))!;
    expect(copy.content.text).toBe("Deploys go out on Tuesdays");
    expect(promotionOf(copy)).toMatchObject({ edited: true, fields: { category: "release", weekly: true, hours: 2 } });
    const event = (await trailEvents(r)).find((e) => e.purpose === "promote")!;
    expect(JSON.parse(event.reason!)).toEqual({ to: "team:blue", basis: "self", approvedBy: null, edited: true, fields: ["category", "hours", "weekly"] });
    expect(event.reason).not.toMatch(/release/);
    // A Public source stays Public; the copy is never more open than its source.
    const pub = await ana.promote("ana-public", { to: "team:blue", basis: "self" });
    expect((await r.inner.getNode(pub.copyId))?.privacyClassification).toBe("Public");
  });

  it("who may promote where: the author to a team they are on; org only with an admin's approval or orgSelfServe", async () => {
    const r = await rig();
    const count = async () => (await r.inner.listNodes()).length;
    const n = await count();
    const ana = handle(r, "ana", { teams: ["blue"] });
    await expect(ana.promote("ana-tip", { to: "team:red", basis: "self" })).rejects.toThrow(/team-memory: ana is not on team:red/);
    await expect(ana.promote("ana-tip", { to: "org", basis: "self" })).rejects.toThrow(/needs an admin's approval/);
    await expect(ana.promote("ana-tip", { to: "org", basis: "policy" })).rejects.toThrow(/needs an admin's approval/);
    // A name in approvedBy is a claim, not an approval.
    await expect(ana.promote("ana-tip", { to: "org", basis: "admin-approved", approvedBy: "root" })).rejects.toThrow(/no admin approval by root/);
    await expect(ana.promote("ana-tip", { to: "user:ben", basis: "self" })).rejects.toThrow(/team:<id> or org/);
    await expect(ana.promote("ana-tip", { to: "team:", basis: "self" })).rejects.toThrow(/team:<id> or org/);
    expect(await count()).toBe(n);
    const denied = (await trailEvents(r)).filter((e) => e.purpose === "promote" && e.outcome === "denied");
    expect(denied).toHaveLength(6);
    expect(denied.every((e) => e.policy === "team-memory" && e.nodeIds[0] === "ana-tip")).toBe(true);

    // The approval workflow's record says root approved exactly this one.
    const asked: unknown[] = [];
    const approved = handle(r, "ana", { teams: ["blue"] }, { approval: (a) => (asked.push(a), a.approvedBy === "root" && a.sourceId === "ana-tip") });
    const { copyId } = await approved.promote("ana-tip", { to: "org", basis: "admin-approved", approvedBy: "root" });
    expect(asked).toEqual([{ approvedBy: "root", sourceId: "ana-tip", author: "ana", to: "org" }]);
    expect(promotionOf((await r.inner.getNode(copyId))!)).toMatchObject({ by: "ana", approvedBy: "root", basis: "admin-approved" });
    expect(await verifyPromotion(copyId, r.trail)).toMatchObject({ ok: true, promotion: { approvedBy: "root", basis: "admin-approved", to: "org" } });

    // orgSelfServe: the author alone.
    const self = handle(r, "ana", { teams: ["blue"] }, { orgSelfServe: true });
    await self.promote("ana-public", { to: "org", basis: "self" });

    // An admin approves their own fact by naming themselves; nobody else can.
    const root = handle(r, "root", { roles: ["admin"] });
    await root.promote("root-own", { to: "org", basis: "admin-approved", approvedBy: "root" });
    await expect(handle(r, "ben").promote("ben-own", { to: "org", basis: "admin-approved", approvedBy: "ben" })).rejects.toThrow(/no admin approval by ben/);
  });

  it("an admin cannot complete someone else's promotion without them", async () => {
    const r = await rig();
    // Root is an admin on team blue and reads Ana's team fact; it is still Ana's to share.
    const root = handle(r, "root", { teams: ["blue"], roles: ["admin"] });
    expect(await root.getNode("blue-by-ana")).toBeDefined();
    await expect(root.promote("blue-by-ana", { to: "org", basis: "admin-approved", approvedBy: "root" })).rejects.toThrow(/only a fact's author promotes it/);
    // Ana's own call, with root's approval on record, completes it: team → org.
    const ana = handle(r, "ana", { teams: ["blue"] }, { approval: (a) => a.approvedBy === "root" });
    const { copyId } = await ana.promote("blue-by-ana", { to: "org", basis: "admin-approved", approvedBy: "root" });
    expect((await r.inner.getNode(copyId))?.contextualMetadata).toMatchObject({ scope: "org", author: "ana" });
    // A fact the admin cannot see at all is not found, not "not yours".
    await expect(root.promote("ana-tip", { to: "org", basis: "admin-approved", approvedBy: "root" })).rejects.toThrow(/not found/);
  });

  it("never promoted: Sensitive, Sealed, in Recently deleted, no longer current, seen redacted, a secret, or twice", async () => {
    const r = await rig();
    const ana = handle(r, "ana", { teams: ["blue"] }, { extra: [hideRate] });
    const n = (await r.inner.listNodes()).length;
    const to = { to: "team:blue", basis: "self" } as const;
    await expect(ana.promote("ana-sensitive", to)).rejects.toThrow(/govern: a Sensitive fact is never promoted/);
    await expect(ana.promote("ana-sealed", to)).rejects.toThrow(/govern: a Sealed fact is never promoted/);
    await expect(ana.promote("ana-binned", to)).rejects.toThrow(/Recently deleted/);
    await expect(ana.promote("ana-retired", to)).rejects.toThrow(/no longer current/);
    await expect(ana.promote("ana-rate", to)).rejects.toThrow(/sees the fact redacted/);
    await expect(ana.promote("blue-by-ana", to)).rejects.toThrow(/already at team:blue/);
    await expect(ana.promote("ana-tip", { ...to, text: "the deploy password is hunter2" })).rejects.toThrow(/reads like a secret/);
    // Unedited too: a store without the personal defaults never classified it Sensitive.
    await expect(ana.promote("ana-secret", to)).rejects.toThrow(/reads like a secret/);
    expect((await r.inner.listNodes()).length).toBe(n);

    // Two at once (a double click, a retry racing the first): one copy.
    const both = await Promise.allSettled([ana.promote("ana-tip", to), ana.promote("ana-tip", to)]);
    expect(both.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((both.find((s) => s.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already promoted to team:blue/);
    const copies = (await r.inner.listNodes()).filter((x) => promotionOf(x)?.from === "ana-tip");
    expect(copies).toHaveLength(1);
    // Withdrawn, it may be promoted again.
    await ana.withdraw(copies[0]!.nodeId, "reworded");
    await ana.promote("ana-tip", to);
  });

  it("no policy that allows it, no promotion; malformed requests are refused before anything is read", async () => {
    const r = await rig();
    const bare = govern(r.inner, { policies: [], context: () => ({ actor: "ana" }), audit: r.audit });
    await expect(bare.promote("ana-tip", { to: "team:blue", basis: "self" })).rejects.toThrow(/promotion is not enabled/);
    const ana = handle(r, "ana", { teams: ["blue"] });
    const bad: unknown[] = [
      null,
      { to: "team:blue" },
      { to: "", basis: "self" },
      { to: " org", basis: "self" },
      { to: "org", basis: "admin" },
      { to: "org", basis: "admin-approved" },
      { to: "org", basis: "self", approvedBy: "root" },
      { to: "team:blue", basis: "self", text: "  " },
      { to: "team:blue", basis: "self", fields: { n: Number.NaN } },
      { to: "team:blue", basis: "self", fields: { nested: { a: 1 } } },
      { to: "team:blue", basis: "self", extra: 1 },
    ];
    const before = (await trailEvents(r)).length;
    for (const request of bad) await expect(ana.promote("ana-tip", request as never), JSON.stringify(request)).rejects.toThrow(/^promote: /);
    expect((await trailEvents(r)).length).toBe(before);
    // An export view is read-only.
    const view = exportView(r.inner, { policies: [teamMemory()], context: () => ({ actor: "ana", attributes: teamMemoryAttributes("ana") }) }) as unknown as { promote: () => Promise<unknown>; withdraw: () => Promise<unknown> };
    await expect(view.promote()).rejects.toThrow(/read-only/);
    await expect(view.withdraw()).rejects.toThrow(/read-only/);
  });

  it("withdraw closes the copy with a retraction and deletes nothing; only its author, its promoter or an admin may", async () => {
    const r = await rig();
    const ana = handle(r, "ana", { teams: ["blue"] });
    const { copyId } = await ana.promote("ana-tip", { to: "team:blue", basis: "self" });
    const bo = handle(r, "bo", { teams: ["blue"] });
    await expect(bo.withdraw(copyId, "I disagree")).rejects.toThrow(/team-memory: bo cannot withdraw a promoted fact/);
    // Not by the back door either: a plain invalidation of a copy is a withdrawal.
    await expect(bo.updateNode(copyId, { validTo: "2026-03-01T00:00:00.000Z" })).rejects.toThrow(/cannot withdraw a promoted fact/);
    await expect(ana.withdraw("ana-tip", "not a copy")).rejects.toThrow(/not a promoted copy/);
    await expect(ana.withdraw(copyId, " ")).rejects.toThrow(/reason is required/);

    const closed = await ana.withdraw(copyId, "outdated after the new release train");
    expect(closed.validTo).not.toBeNull();
    const stored = (await r.inner.getNode(copyId))!;
    expect(stored.content.text).toBe("Deploys go out on Tuesdays after the freeze");
    expect(stored.contextualMetadata).toMatchObject({
      scope: "team:blue",
      author: "ana",
      promotion: { from: "ana-tip", by: "ana" },
      retraction: { at: stored.validTo, by: "withdrawal", reason: "outdated after the new release train" },
    });
    expect((await r.inner.getNode("ana-tip"))?.validTo).toBeNull();
    // A retry changes nothing and records nothing more.
    const events = (await trailEvents(r)).length;
    expect((await ana.withdraw(copyId, "again")).validTo).toBe(stored.validTo);
    expect((await r.inner.getNode(copyId))?.contextualMetadata["retraction"]).toMatchObject({ reason: "outdated after the new release train" });
    expect((await trailEvents(r)).length).toBe(events);

    const withdrawn = (await trailEvents(r)).filter((e) => e.purpose === "withdraw" && e.outcome === "allowed");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatchObject({ actor: "ana", nodeIds: [copyId], reason: "outdated after the new release train" });
    expect(await verifyPromotion(copyId, r.trail)).toMatchObject({ ok: true, withdrawn: { actor: "ana", reason: "outdated after the new release train" } });

    // An admin may withdraw another person's copy.
    const second = await ana.promote("ana-public", { to: "team:blue", basis: "self" });
    await handle(r, "root", { teams: ["blue"], roles: ["admin"] }).withdraw(second.copyId, "superseded by the handbook");
    expect((await r.inner.getNode(second.copyId))?.validTo).not.toBeNull();
  });

  it("a copy's promotion record never changes, and a write cannot forge one", async () => {
    const r = await rig();
    const ana = handle(r, "ana", { teams: ["blue"] });
    const { copyId } = await ana.promote("ana-tip", { to: "team:blue", basis: "self" });
    const cm = (await r.inner.getNode(copyId))!.contextualMetadata;
    await expect(ana.updateNode(copyId, { contextualMetadata: { ...cm, promotion: { ...(cm["promotion"] as object), approvedBy: "root" } } })).rejects.toThrow(/promotion record never changes/);
    await expect(ana.updateNode(copyId, { contextualMetadata: { scope: cm["scope"], author: cm["author"] } })).rejects.toThrow(/promotion record never changes/);
    await expect(ana.addNode(makeNode({ content: { text: "forged" }, contextualMetadata: { promotion: { from: "x", by: "ana", at: AT } } }))).rejects.toThrow(/written by promote/);
    // Other changes go through, the record intact.
    await ana.updateNode(copyId, { contextualMetadata: { ...cm, tags: ["release"] } });
    expect(promotionOf((await r.inner.getNode(copyId))!)).toEqual(cm["promotion"]);
  });

  it("erasing the source leaves the copy; erasing by author reaches the copies; the receipt says so", async () => {
    const r = await rig();
    const ana = handle(r, "ana", { teams: ["blue"] }, { extra: [allowErase] });
    const { copyId } = await ana.promote("ana-tip", { to: "team:blue", basis: "self" });
    await ana.deleteNode("ana-tip");
    expect(await r.inner.getNode("ana-tip")).toBeUndefined();
    expect((await r.inner.getNode(copyId))?.content.text).toBe("Deploys go out on Tuesdays after the freeze");
    expect(await verifyPromotion(copyId, r.trail)).toMatchObject({ ok: true, promotion: { from: "ana-tip" } });

    const receipt = await ana.eraseWhere({ label: "author", equals: "ana" });
    expect(await r.inner.getNode(copyId)).toBeUndefined();
    expect(await r.inner.getNode("blue-by-ana")).toBeUndefined();
    expect(receipt.outside).toEqual([...RECEIPT_OUTSIDE]);
    expect(receipt.outside.some((line) => /Promoted copies/.test(line) && /author label/.test(line))).toBe(true);
    // Ben's fact was not Ana's to erase.
    expect(await r.inner.getNode("ben-own")).toBeDefined();
  });

  it("an erase policy still judges each copy: a refusal holds it", async () => {
    const r = await rig();
    const hold: GovernancePolicy = {
      name: "legal-hold",
      beforeErase: (s) => {
        if ("node" in s && promotionOf(s.node) !== null) throw new PolicyDenied("legal-hold", "the company's copy is on hold");
      },
    };
    const ana = handle(r, "ana", { teams: ["blue"] }, { extra: [allowErase, hold] });
    const { copyId } = await ana.promote("ana-tip", { to: "team:blue", basis: "self" });
    const receipt = await ana.eraseWhere({ label: "author", equals: "ana" });
    expect(receipt.refused.count).toBe(1);
    expect(await r.inner.getNode(copyId)).toBeDefined();
    expect(await r.inner.getNode("ana-tip")).toBeUndefined();
  });

  it("the portable format is unchanged: a copy exports as a fact with labels", async () => {
    const r = await rig();
    const { copyId } = await handle(r, "ana", { teams: ["blue"] }).promote("ana-tip", { to: "team:blue", basis: "self" });
    const artifact = await exportPortable(new Map([["p", r.inner]]));
    expect(artifact.formatVersion).toBe(PORTABLE_FORMAT_VERSION);
    const exported = artifact.projects[0]!.nodes.find((x) => x.nodeId === copyId)!;
    expect(exported.contextualMetadata["promotion"]).toMatchObject({ from: "ana-tip" });
  });
});

describe("the MCP tools", () => {
  it("promote and withdraw over a team store; the personal server refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-mcp-"));
    dirs.push(dir);
    const inner = new InMemoryStore();
    for (const n of SEEDS) await inner.restoreNode(n);
    const r: Rig = { inner, audit: new ChainedAudit(join(dir, "audit.jsonl")), trail: join(dir, "audit.jsonl") };
    const tools = governanceTools({ store: handle(r, "ana", { teams: ["blue"] }) });
    const out = await tools.promote({ id: "ana-tip", to: "team:blue", text: "Deploys go out on Tuesdays" });
    expect(out).toMatchObject({ from: "ana-tip", to: "team:blue", basis: "self", fact: { text: "Deploys go out on Tuesdays", current: true } });
    const back = await tools.withdraw({ id: out.copyId, reason: "wrong team" });
    expect(back.current).toBe(false);
    // approvedBy alone means an admin-approved promotion, and is judged as one.
    await expect(tools.promote({ id: "ana-public", to: "org", approvedBy: "root" })).rejects.toThrow(/no admin approval by root/);

    const personal = governanceTools({ store: serverStore(new InMemoryStore()) });
    const mine = await personal.remember({ text: "My own note" });
    await expect(personal.promote({ id: mine.id, to: "org" })).rejects.toThrow(/promotion is not enabled/);
    await expect(governanceTools({ store: new InMemoryStore() }).promote({ id: "x", to: "org" })).rejects.toThrow(PROMOTE_REFUSED);
  });
});
