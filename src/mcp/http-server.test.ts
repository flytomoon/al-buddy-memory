/**
 * The whole remote-connector sign-in, the way Claude and ChatGPT walk it:
 * discovery from a 401, dynamic registration, the consent page and its
 * passphrase, PKCE code exchange, then MCP over Streamable HTTP with the token.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { TOOL_ANNOTATIONS } from "./governance-server.js";
import { startHttpConnector } from "./http-server.js";
import { hashPassphrase } from "./owner-oauth.js";

const PASS = "correct horse battery staple";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const dir = mkdtempSync(join(tmpdir(), "mem-http-"));
const statePath = join(dir, "oauth.json");
let base = "";
let close: () => Promise<void> = async () => undefined;
const logged: string[] = [];

beforeAll(async () => {
  const c = await startHttpConnector({
    deps: { store: new InMemoryStore() },
    publicUrl: "http://127.0.0.1:1",
    port: 0,
    oauthStatePath: statePath,
    passphraseHash: hashPassphrase(PASS),
    log: (line) => logged.push(line),
  });
  base = c.url;
  close = c.close;
});
afterAll(async () => { await close(); });

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function register(name = "claude-test"): Promise<string> {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function startAuthorize(clientId: string, challenge: string, name = "claude-test"): Promise<string> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain(`Connect ${name} to your memory`);
  return html.match(/name="pending" value="([^"]+)"/)![1]!;
}

/** One passphrase on the consent page for `clientId`; the response status (302 allowed, 401 wrong, 429 locked). */
async function tryPassphrase(clientId: string, passphrase: string, name = "claude-test"): Promise<number> {
  const pending = await startAuthorize(clientId, "x".repeat(43), name);
  const r = await fetch(`${base}/consent`, { method: "POST", headers: FORM, body: form({ pending, passphrase }), redirect: "manual" });
  return r.status;
}

/** Lift every lock and forget every wrong passphrase, so each test starts clean. */
function clearLocks(): void {
  const s = JSON.parse(readFileSync(statePath, "utf8")) as { failures: unknown };
  s.failures = { byClient: {}, recent: [], lockedUntil: 0 };
  writeFileSync(statePath, JSON.stringify(s));
}

async function signIn(): Promise<{ access: string; refresh: string; clientId: string }> {
  const clientId = await register();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pending = await startAuthorize(clientId, challenge);
  const allow = await fetch(`${base}/consent`, { method: "POST", headers: FORM, body: form({ pending, passphrase: PASS }), redirect: "manual" });
  expect(allow.status).toBe(302);
  const to = new URL(allow.headers.get("location")!);
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get("state")).toBe("s1");
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code: to.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
  });
  expect(tok.status).toBe(200);
  const t = (await tok.json()) as { access_token: string; refresh_token: string };
  return { access: t.access_token, refresh: t.refresh_token, clientId };
}

const rpc = (token: string, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

async function rpcJson(token: string, body: unknown): Promise<{ result?: Record<string, unknown> }> {
  const r = await rpc(token, body);
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).at(-1)! : text;
  return JSON.parse(data) as { result?: Record<string, unknown> };
}

describe("remote connector over HTTPS", () => {
  it("refuses an app that wants its sign-in sent anywhere but Claude, ChatGPT or this machine, and names the destination on consent (review 2026-10-08 H1)", async () => {
    const bad = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/redirect not allowed/);
    const local = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    });
    expect(local.status).toBe(201);
    const clientId = await register();
    const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const page = await (await fetch(`${base}/authorize?${q}`)).text();
    expect(page).toMatch(/Access goes to <strong>claude\.ai<\/strong>/);
  });

  it("an unsigned request is told where to sign in", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(((await meta.json()) as { code_challenge_methods_supported: string[] }).code_challenge_methods_supported).toContain("S256");
  });

  describe("wrong passphrases (review 2026-10-08 M3)", () => {
    // Registration is rate-limited (20 an hour), so the owner's app is registered once and shared.
    let owner = "";
    beforeAll(async () => { owner = await register(); });
    beforeEach(() => {
      clearLocks();
      logged.length = 0;
    });
    afterAll(() => { clearLocks(); });

    it("five from one app lock that app out, but not the owner's own app", async () => {
      const stranger = await register("mallory");
      for (let i = 0; i < 5; i++) expect(await tryPassphrase(stranger, "nope", "mallory")).toBe(401);
      expect(await tryPassphrase(stranger, PASS, "mallory")).toBe(429);
      expect(await tryPassphrase(owner, PASS)).toBe(302);
      expect(logged.filter((l) => l.includes("locked"))).toHaveLength(1);
      expect(logged.find((l) => l.includes("locked"))).toMatch(/^connector: consent locked for "mallory" \(client [0-9a-f]{8}\) until \d{4}-\d\d-\d\dT[\d:.]+Z: 5 wrong passphrases from it$/);
      expect(logged.join("\n")).not.toMatch(/nope|correct horse/);
    });

    it("twenty across many fresh apps lock every app, the owner's too", async () => {
      for (let a = 0; a < 4; a++) {
        const stranger = await register(`stranger ${a}`);
        for (let i = 0; i < 5; i++) expect(await tryPassphrase(stranger, `guess ${a}-${i}`, `stranger ${a}`)).toBe(401);
      }
      expect(await tryPassphrase(owner, PASS)).toBe(429);
      const locks = logged.filter((l) => l.includes("locked"));
      expect(locks.filter((l) => l.includes("from it"))).toHaveLength(4);
      expect(locks.filter((l) => l.startsWith("connector: consent locked for every app until "))).toHaveLength(1);
      expect(locks.at(-1)).toMatch(/20 wrong passphrases in 15 minutes, the last from "stranger 3"/);
      expect(logged.join("\n")).not.toMatch(/guess|correct horse/);
    });

    it("a right passphrase resets that app's count", async () => {
      for (let i = 0; i < 4; i++) expect(await tryPassphrase(owner, "nope")).toBe(401);
      expect(await tryPassphrase(owner, PASS)).toBe(302);
      for (let i = 0; i < 4; i++) expect(await tryPassphrase(owner, "nope")).toBe(401);
      expect(await tryPassphrase(owner, PASS)).toBe(302);
      expect(logged.filter((l) => l.includes("locked"))).toEqual([]);
    });

    it("forgets an app's wrong passphrases on disk once they are old, like every other entry", async () => {
      expect(await tryPassphrase(owner, "nope")).toBe(401);
      const s = JSON.parse(readFileSync(statePath, "utf8")) as { failures: { byClient: Record<string, { expiresAt: number }>; recent: number[] } };
      expect(Object.keys(s.failures.byClient)).toEqual([owner]);
      expect(s.failures.recent).toHaveLength(1);
      // Age them past the lock time; the next write drops them.
      s.failures.byClient[owner]!.expiresAt = 1;
      s.failures.recent = [1];
      writeFileSync(statePath, JSON.stringify(s));
      await register("anything");
      const after = JSON.parse(readFileSync(statePath, "utf8")) as { failures: { byClient: Record<string, unknown>; recent: number[] } };
      expect(after.failures).toMatchObject({ byClient: {}, recent: [] });
    });
  });

  it("signs in, lists every tool with its read/write annotations, and remembers then recalls", async () => {
    const { access } = await signIn();
    const init = await rpcJson(access, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } });
    expect(init.result?.["serverInfo"]).toMatchObject({ name: "al-buddy-memory" });
    const list = await rpcJson(access, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list.result?.["tools"] ?? []) as { name: string; annotations?: Record<string, unknown> }[];
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    for (const t of tools) {
      expect(t.annotations?.["title"]).toBeTruthy();
      expect(typeof t.annotations?.["readOnlyHint"]).toBe("boolean");
      expect(typeof t.annotations?.["destructiveHint"]).toBe("boolean");
      expect(typeof t.annotations?.["openWorldHint"]).toBe("boolean");
    }
    await rpcJson(access, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { text: "The founder takes his coffee black." } } });
    const got = await rpcJson(access, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall", arguments: { query: "coffee" } } });
    expect(JSON.stringify(got.result)).toMatch(/coffee black/);
  });

  it("refresh tokens rotate: the old one stops working", async () => {
    const { refresh, clientId } = await signIn();
    const once = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }) });
    expect(once.status).toBe(200);
    const again = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }) });
    expect(again.status).toBe(400);
  });

  it("keeps no token on disk, only hashes, in a 0600 file", async () => {
    const { access, refresh } = await signIn();
    const raw = readFileSync(statePath, "utf8");
    expect(raw).not.toContain(access);
    expect(raw).not.toContain(refresh);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const bad = await rpc("not-a-token", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(bad.status).toBe(401);
  });
});

describe("redirectAllowed", () => {
  it("allows the default assistants and loopback, refuses everything else", async () => {
    const { redirectAllowed } = await import("./owner-oauth.js");
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:5555/cb")).toBe(true);
    expect(redirectAllowed("http://claude.ai/cb")).toBe(false);
    expect(redirectAllowed("https://claude.ai.evil.example/cb")).toBe(false);
    expect(redirectAllowed("https://evil.example/?x=https://claude.ai")).toBe(false);
    expect(redirectAllowed("not a url")).toBe(false);
    expect(redirectAllowed("https://intranet.example/cb", ["https://intranet.example"])).toBe(true);
  });
});
