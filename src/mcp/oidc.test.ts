/**
 * Sign-in by the company's identity provider: a bearer token is accepted only
 * when its signature checks against the issuer's keys, its issuer and audience
 * are the configured ones and it has not expired; its claims become the actor's
 * attributes. Every key here is generated locally; discovery is served from
 * 127.0.0.1, so nothing leaves the machine.
 */
import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OidcTokenRefused, oidcVerifier, type OidcOptions } from "./oidc.js";

const ISSUER = "https://idp.example.test/tenant-1/v2.0";
const AUDIENCE = "api://memory";

let signer: CryptoKey;
let stranger: CryptoKey;
let rsSigner: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const ec = await generateKeyPair("ES256");
  const rs = await generateKeyPair("RS256");
  stranger = (await generateKeyPair("ES256")).privateKey;
  signer = ec.privateKey;
  rsSigner = rs.privateKey;
  jwks = { keys: [{ ...(await exportJWK(ec.publicKey)), kid: "ec-1", alg: "ES256" }, { ...(await exportJWK(rs.publicKey)), kid: "rs-1", alg: "RS256" }] };
});

interface Mint {
  key?: CryptoKey;
  alg?: string;
  kid?: string;
  iss?: string | null;
  aud?: string | string[] | null;
  exp?: number | string | null;
  nbf?: number | string;
}

async function mint(claims: JWTPayload, m: Mint = {}): Promise<string> {
  const alg = m.alg ?? "ES256";
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: m.kid ?? (alg === "RS256" ? "rs-1" : "ec-1") }).setIssuedAt();
  if (m.iss !== null) jwt = jwt.setIssuer(m.iss ?? ISSUER);
  if (m.aud !== null) jwt = jwt.setAudience(m.aud ?? AUDIENCE);
  if (m.exp !== null) jwt = jwt.setExpirationTime(m.exp ?? "10m");
  if (m.nbf !== undefined) jwt = jwt.setNotBefore(m.nbf);
  return jwt.sign(m.key ?? (alg === "RS256" ? rsSigner : signer));
}

const verifier = (o: Partial<OidcOptions> = {}) => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, ...o });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

describe("a verified token", () => {
  it("names the actor from sub and maps the configured claims onto attributes", async () => {
    const v = verifier({ claims: { groups: "teams", roles: "roles", department: "department" } });
    const who = await v.verify(await mint({ sub: "alice", groups: ["blue", "ops"], roles: ["finance"], department: "Sales", email: "a@x.test" }));
    expect(who.actor).toBe("alice");
    expect(who.attributes).toEqual({ teams: ["blue", "ops"], roles: ["finance"], department: "Sales" });
    expect(who.tenant).toBeUndefined();
    expect(who.expiresAt).toBeGreaterThan(now());
  });

  it("accepts RS256 as well as ES256", async () => {
    expect((await verifier().verify(await mint({ sub: "bob" }, { alg: "RS256" }))).actor).toBe("bob");
  });

  it("reads the tenant from the configured claim", async () => {
    const who = await verifier({ tenantClaim: "tid" }).verify(await mint({ sub: "alice", tid: "acme" }));
    expect(who.tenant).toBe("acme");
  });

  it("can name the actor from another claim", async () => {
    const who = await verifier({ actorClaim: "oid" }).verify(await mint({ sub: "pairwise-123", oid: "user-9" }));
    expect(who.actor).toBe("user-9");
  });

  it("reads a namespaced claim whose name has dots, and a nested one by path", async () => {
    const v = verifier({ claims: { "https://example.com/clients": "clients", "realm_access.roles": "roles" } });
    const who = await v.verify(await mint({ sub: "alice", "https://example.com/clients": ["acme"], realm_access: { roles: ["admin"] } }));
    expect(who.attributes).toEqual({ clients: ["acme"], roles: ["admin"] });
  });

  it("merges two claims mapped onto one attribute, once each", async () => {
    const who = await verifier({ claims: { groups: "teams", wids: "teams" } }).verify(await mint({ sub: "a", groups: ["blue"], wids: ["blue", "red"] }));
    expect(who.attributes).toEqual({ teams: ["blue", "red"] });
  });

  it("leaves out a claim that is absent or not text, so a boundary on it matches nothing", async () => {
    const v = verifier({ claims: { groups: "teams", level: "level", department: "department", mixed: "mixed" } });
    const who = await v.verify(await mint({ sub: "a", level: 7, mixed: ["x", 3, null] }));
    expect(who.attributes).toEqual({ mixed: ["x"] });
  });

  it("collects the scopes from scope or scp", async () => {
    expect((await verifier().verify(await mint({ sub: "a", scope: "memory read" }))).scopes).toEqual(["memory", "read"]);
    expect((await verifier().verify(await mint({ sub: "a", scp: ["memory"] }))).scopes).toEqual(["memory"]);
  });

  it("accepts any one of several audiences", async () => {
    expect((await verifier({ audience: ["other", AUDIENCE] }).verify(await mint({ sub: "a" }))).actor).toBe("a");
  });
});

describe("fails closed", () => {
  const refused = async (token: string | Promise<string>, o: Partial<OidcOptions> = {}) => {
    await expect(verifier(o).verify(await token)).rejects.toBeInstanceOf(OidcTokenRefused);
  };

  it("on a signature from a key the issuer does not publish", async () => {
    await refused(mint({ sub: "a" }, { key: stranger }));
  });
  it("on a kid the key set does not have", async () => {
    await refused(mint({ sub: "a" }, { kid: "nope" }));
  });
  it("on a tampered payload", async () => {
    const [h, , s] = (await mint({ sub: "alice", groups: ["blue"] })).split(".");
    await refused(`${h}.${b64({ sub: "alice", groups: ["finance"], iss: ISSUER, aud: AUDIENCE, exp: now() + 600 })}.${s}`, { claims: { groups: "teams" } });
  });
  it("on another issuer, or none", async () => {
    await refused(mint({ sub: "a" }, { iss: "https://evil.example.test" }));
    await refused(mint({ sub: "a" }, { iss: null }));
  });
  it("on another audience, or none", async () => {
    await refused(mint({ sub: "a" }, { aud: "api://other" }));
    await refused(mint({ sub: "a" }, { aud: null }));
  });
  it("when expired, or not yet valid", async () => {
    await refused(mint({ sub: "a" }, { exp: now() - 120 }));
    await refused(mint({ sub: "a" }, { nbf: now() + 600 }));
  });
  it("on a token with no expiry at all", async () => {
    await refused(mint({ sub: "a" }, { exp: null }));
  });
  it("on alg none", async () => {
    await refused(`${b64({ alg: "none" })}.${b64({ sub: "a", iss: ISSUER, aud: AUDIENCE, exp: now() + 600 })}.`);
  });
  it("on a symmetric algorithm keyed with the public key (algorithm confusion)", async () => {
    const pub = new TextEncoder().encode(JSON.stringify(jwks.keys[0]));
    await refused(mint({ sub: "a" }, { alg: "HS256", key: pub as unknown as CryptoKey, kid: "ec-1" }));
  });
  it("on an algorithm outside the configured list", async () => {
    await refused(mint({ sub: "a" }, { alg: "RS256" }), { algorithms: ["ES256"] });
  });
  it("without an actor", async () => {
    await refused(mint({}));
    await refused(mint({ sub: "" }));
    await refused(mint({ sub: "a" }), { actorClaim: "oid" });
  });
  it("without the tenant claim, or with one that is not text", async () => {
    await refused(mint({ sub: "a" }), { tenantClaim: "tid" });
    await refused(mint({ sub: "a", tid: "" }), { tenantClaim: "tid" });
    await refused(mint({ sub: "a", tid: ["acme"] }), { tenantClaim: "tid" });
  });
  it("on anything that is not a token", async () => {
    await refused("");
    await refused("not.a.token");
    await refused("eyJhbGciOiJFUzI1NiJ9");
  });
});

describe("configuration", () => {
  it("is refused when it could not verify anything", () => {
    expect(() => oidcVerifier({ issuer: "", audience: AUDIENCE, jwks })).toThrow(/issuer/);
    expect(() => oidcVerifier({ issuer: "not a url", audience: AUDIENCE, jwks })).toThrow(/issuer/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: "", jwks })).toThrow(/audience/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: [], jwks })).toThrow(/audience/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, claims: { groups: "" } })).toThrow(/claims/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, algorithms: ["HS256"] })).toThrow(/algorithm/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, algorithms: ["none"] })).toThrow(/algorithm/);
    expect(() => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, tenantClaim: "" })).toThrow(/tenantClaim/);
  });
});

describe("the issuer's published keys", () => {
  let server: Server;
  let origin = "";
  let discovery: Record<string, unknown> = {};
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === "/realm/.well-known/openid-configuration") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(discovery));
      if (req.url === "/realm/keys") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwks));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const remote = (o: Partial<OidcOptions> = {}) => oidcVerifier({ issuer: `${origin}/realm`, audience: AUDIENCE, ...o });

  it("are found through the issuer's discovery document", async () => {
    discovery = { issuer: `${origin}/realm`, jwks_uri: `${origin}/realm/keys` };
    const who = await remote().verify(await mint({ sub: "alice" }, { iss: `${origin}/realm` }));
    expect(who.actor).toBe("alice");
  });

  it("or read from jwksUri directly", async () => {
    discovery = {};
    const who = await remote({ jwksUri: `${origin}/realm/keys` }).verify(await mint({ sub: "bob" }, { iss: `${origin}/realm` }));
    expect(who.actor).toBe("bob");
  });

  it("are not trusted from a discovery document that names another issuer", async () => {
    discovery = { issuer: "https://evil.example.test", jwks_uri: `${origin}/realm/keys` };
    await expect(remote().verify(await mint({ sub: "a" }, { iss: `${origin}/realm` }))).rejects.toBeInstanceOf(OidcTokenRefused);
  });

  it("refuse every token while discovery fails, and recover once it works", async () => {
    discovery = { issuer: `${origin}/realm` }; // no jwks_uri
    const v = remote();
    const token = await mint({ sub: "a" }, { iss: `${origin}/realm` });
    await expect(v.verify(token)).rejects.toBeInstanceOf(OidcTokenRefused);
    discovery = { issuer: `${origin}/realm`, jwks_uri: `${origin}/realm/keys` };
    expect((await v.verify(token)).actor).toBe("a");
  });

  it("are fetched once, not per token", async () => {
    discovery = { issuer: `${origin}/realm`, jwks_uri: `${origin}/realm/keys` };
    const v = remote();
    await v.verify(await mint({ sub: "a" }, { iss: `${origin}/realm` }));
    const before = hits;
    for (let i = 0; i < 5; i++) await v.verify(await mint({ sub: `u${i}` }, { iss: `${origin}/realm` }));
    expect(hits).toBe(before);
  });
});
