/**
 * Team memory over the remote connector signed in by the company's identity
 * provider: the `groups` claim, mapped to `teams` exactly as docs/SIGN-IN.md
 * maps it, becomes the person's `team:<id>` scopes through
 * teamMemoryAttributes, and the teamMemory sample (docs/policies/scopes.md)
 * decides what each recall returns, on Postgres (PGlite here).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { govern } from "../governance/governed-store.js";
import { storeAudit, type AuditEvent } from "../governance/audit.js";
import { teamMemory, teamMemoryAttributes } from "../governance/samples.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import type { MemoryNode } from "../types/memory.js";
import { actingOrigin, startHttpConnector } from "./http-server.js";

const ISSUER = "https://login.example.test/org/v2.0";
const AUDIENCE = "api://al-buddy-memory";

let pg: PGlite;
let key: CryptoKey;
let base = "";
let close: () => Promise<void> = async () => undefined;
let acme: PostgresMemoryStore;

const AT = "2026-01-05T00:00:00.000Z";
const fact = (id: string, text: string, labels: Record<string, unknown>): MemoryNode => ({
  ...makeNode({ content: { text }, contextualMetadata: labels }),
  nodeId: id,
  temporalAnchors: [{ event: "created", timestamp: AT }],
  validFrom: AT,
  validTo: null,
});

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
  const pair = await generateKeyPair("ES256");
  key = pair.privateKey;
  acme = new PostgresMemoryStore({ tenantId: "acme", client: pg });
  await acme.initialize();
  await acme.restoreNode(fact("alice-own", "Budget idea Alice keeps to herself", { scope: "user:alice", author: "alice" }));
  await acme.restoreNode(fact("rob-own", "Budget idea Rob keeps to himself", { scope: "user:rob", author: "rob" }));
  await acme.restoreNode(fact("blue", "Budget plan for the blue team", { scope: "team:blue", author: "alice" }));
  await acme.restoreNode(fact("red", "Budget plan for the red team", { scope: "team:red", author: "rob" }));
  await acme.restoreNode(fact("org", "Budget freeze applies to the whole company", { scope: "org", author: "rob" }));
  const c = await startHttpConnector({
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] },
      claims: { groups: "teams", roles: "roles" },
      tenantClaim: "tid",
      actorClaim: "oid",
    },
    deps: async (who) => ({
      store: govern(acme, {
        policies: [teamMemory()],
        context: () => ({ actor: who.actor, attributes: teamMemoryAttributes(who.actor, who.attributes), origin: actingOrigin() }),
        audit: storeAudit(acme),
      }),
    }),
    publicUrl: "http://127.0.0.1:1",
    port: 0,
  });
  base = c.url;
  close = c.close;
});
afterAll(async () => {
  await close();
  await pg.close();
});

const token = (claims: JWTPayload) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m").sign(key);

const alice = () => token({ oid: "alice", tid: "acme", groups: ["blue"] });
const rob = () => token({ oid: "rob", tid: "acme", groups: ["red"] });

async function call(bearer: string, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).at(-1)! : text;
  const out = JSON.parse(data) as { result?: { content?: { text: string }[]; isError?: boolean } };
  expect(out.result?.isError ?? false).toBe(false);
  return (out.result?.content ?? []).map((c) => c.text).join("\n");
}

describe("team memory, signed in by the company's identity provider", () => {
  it("a recall returns the person's own facts, their groups' and the company's", async () => {
    const a = await call(await alice(), "recall", { query: "budget" });
    expect(a).toMatch(/Alice keeps/);
    expect(a).toMatch(/blue team/);
    expect(a).toMatch(/whole company/);
    expect(a).not.toMatch(/Rob keeps|red team/);
    const r = await call(await rob(), "recall", { query: "budget" });
    expect(r).toMatch(/Rob keeps/);
    expect(r).toMatch(/red team/);
    expect(r).not.toMatch(/Alice keeps|blue team/);
  });

  it("what a person remembers is theirs: stamped with their scope and name, unseen by their own team", async () => {
    const written = JSON.parse(await call(await alice(), "remember", { text: "Alice's budget draft for the offsite." })) as { id: string };
    expect((await acme.getNode(written.id))?.contextualMetadata).toMatchObject({ scope: "user:alice", author: "alice" });
    expect(await call(await alice(), "recall", { query: "offsite" })).toMatch(/offsite/);
    const teammate = await token({ oid: "bo", tid: "acme", groups: ["blue"] });
    expect(await call(teammate, "recall", { query: "offsite" })).not.toMatch(/offsite/);
    expect(await call(teammate, "recall", { query: "budget" })).toMatch(/blue team/);
    const events: AuditEvent[] = [];
    expect((await acme.verifyAudit({ visit: (e) => events.push(e) })).ok).toBe(true);
    expect(events.some((e) => e.actor === "alice" && e.purpose === "write" && e.nodeIds.includes(written.id) && e.outcome === "allowed")).toBe(true);
  });

  it("invalidating keeps the fact's scope and author: closed, not moved and not deleted", async () => {
    const written = JSON.parse(await call(await rob(), "remember", { text: "Rob's red retro is on Fridays." })) as { id: string };
    await call(await rob(), "invalidate", { id: written.id, reason: "moved to Thursdays" });
    const closed = await acme.getNode(written.id);
    expect(closed?.validTo).not.toBeNull();
    expect(closed?.contextualMetadata).toMatchObject({ scope: "user:rob", author: "rob" });
  });

  it("a groups claim named like a scope is a team, and widens nothing", async () => {
    const t = await token({ oid: "mallory", tid: "acme", groups: ["org", "user:alice", "team:blue"] });
    const out = await call(t, "recall", { query: "budget" });
    expect(out).toMatch(/whole company/);
    expect(out).not.toMatch(/Alice keeps|Rob keeps|blue team|red team/);
  });

  it("a person with no groups claim sees their own and the company's", async () => {
    const out = await call(await token({ oid: "newhire", tid: "acme" }), "recall", { query: "budget" });
    expect(out).toMatch(/whole company/);
    expect(out).not.toMatch(/keeps|team/);
  });
});
