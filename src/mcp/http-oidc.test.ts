/**
 * The remote connector signed in by the company's identity provider instead of
 * the owner's passphrase: each request's bearer token names the actor, the
 * tenant picks the store, and the mapped claims are the attributes the
 * boundaries policy (docs/policies/boundaries.ts) reads — so what a recall
 * returns follows the person's groups, on Postgres (PGlite here).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundaries } from "../../docs/policies/boundaries.js";
import { govern } from "../governance/governed-store.js";
import { storeAudit, type AuditEvent } from "../governance/audit.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import type { MemoryNode } from "../types/memory.js";
import { startHttpConnector } from "./http-server.js";
import type { OidcIdentity } from "./oidc.js";

const ISSUER = "https://login.example.test/org/v2.0";
const AUDIENCE = "api://al-buddy-memory";
const CLIENTS = "https://example.test/clients";

let pg: PGlite;
let key: CryptoKey;
let base = "";
let close: () => Promise<void> = async () => undefined;
const tenants = new Map<string, PostgresMemoryStore>();
const seen: OidcIdentity[] = [];

async function tenantStore(id: string): Promise<PostgresMemoryStore> {
  let s = tenants.get(id);
  if (!s) {
    s = new PostgresMemoryStore({ tenantId: id, client: pg });
    await s.initialize();
    tenants.set(id, s);
  }
  return s;
}

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
  const acme = await tenantStore("acme");
  await acme.restoreNode(fact("n-blue", "Budget plan for the blue team's Globex work", { team: "blue", client: "globex" }));
  await acme.restoreNode(fact("n-red", "Budget plan for the red team's Globex work", { team: "red", client: "globex" }));
  await acme.restoreNode(fact("n-all", "Budget freeze applies to the whole company", { visibility: "company" }));
  const c = await startHttpConnector({
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] },
      claims: { groups: "teams", [CLIENTS]: "clients", roles: "roles" },
      tenantClaim: "tid",
    },
    deps: async (who) => {
      seen.push(who);
      const inner = await tenantStore(who.tenant!);
      return { store: govern(inner, { policies: [boundaries], context: () => ({ actor: who.actor, attributes: who.attributes }), audit: storeAudit(inner) }) };
    },
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

const token = (claims: JWTPayload, exp: string | number = "10m", iss = ISSUER) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(iss).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(exp).sign(key);

const alice = () => token({ sub: "alice", tid: "acme", groups: ["blue"], [CLIENTS]: ["globex", "internal"] });
const rob = () => token({ sub: "rob", tid: "acme", groups: ["red"], [CLIENTS]: ["globex", "internal"] });

const rpc = (bearer: string | null, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...(bearer !== null && { authorization: `Bearer ${bearer}` }), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

async function call(bearer: string, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpc(bearer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).at(-1)! : text;
  const out = JSON.parse(data) as { result?: { content?: { text: string }[]; isError?: boolean } };
  expect(out.result?.isError ?? false).toBe(false);
  return (out.result?.content ?? []).map((c) => c.text).join("\n");
}

describe("remote connector signed in by the company's identity provider", () => {
  it("each person's recall follows their own groups, inside the query", async () => {
    const a = await call(await alice(), "recall", { query: "budget" });
    expect(a).toMatch(/blue team/);
    expect(a).toMatch(/whole company/);
    expect(a).not.toMatch(/red team/);
    const r = await call(await rob(), "recall", { query: "budget" });
    expect(r).toMatch(/red team/);
    expect(r).not.toMatch(/blue team/);
    expect(seen.at(-1)).toMatchObject({ actor: "rob", tenant: "acme", attributes: { teams: ["red"], clients: ["globex", "internal"] } });
  });

  it("what a person writes is theirs: labelled by their team, audited under their name", async () => {
    await call(await alice(), "remember", { text: "The blue team standup moved to 9:30." });
    expect(await call(await alice(), "recall", { query: "standup" })).toMatch(/9:30/);
    expect(await call(await rob(), "recall", { query: "standup" })).not.toMatch(/9:30/);
    const events: AuditEvent[] = [];
    expect((await (await tenantStore("acme")).verifyAudit({ visit: (e) => events.push(e) })).ok).toBe(true);
    expect(events.some((e) => e.actor === "alice" && e.purpose === "write" && e.outcome === "allowed")).toBe(true);
  });

  it("the tenant claim picks the store: another tenant with the same groups sees none of it", async () => {
    const other = await token({ sub: "alice", tid: "globex-corp", groups: ["blue"], [CLIENTS]: ["globex", "internal"] });
    expect(await call(other, "recall", { query: "budget standup" })).not.toMatch(/budget|standup/i);
  });

  it("a person with no groups claim sees only what is for everyone", async () => {
    const t = await token({ sub: "newhire", tid: "acme" });
    const out = await call(t, "recall", { query: "budget" });
    expect(out).toMatch(/whole company/);
    expect(out).not.toMatch(/team/);
  });

  it("refuses with 401 and a pointer to the issuer, never reaching the store", async () => {
    const before = seen.length;
    const cases: (string | null)[] = [
      null,
      "garbage",
      await token({ sub: "alice", tid: "acme" }, Math.floor(Date.now() / 1000) - 600),
      await token({ sub: "alice", tid: "acme" }, "10m", "https://evil.example.test"),
      await token({ sub: "alice" }), // no tenant
    ];
    for (const t of cases) {
      const r = await rpc(t, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    }
    expect(seen.length).toBe(before);
    const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(meta.authorization_servers).toEqual([ISSUER]);
    expect(meta.resource).toBe("http://127.0.0.1:1/mcp");
  });

  it("runs no sign-in of its own: no passphrase page, no client registration, no tokens", async () => {
    for (const path of ["/register", "/token", "/consent"]) expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/authorize`)).status).toBe(404);
  });
});
