/**
 * The whole remote-connector sign-in, the way Claude and ChatGPT walk it:
 * discovery from a 401, dynamic registration, the consent page and its
 * passphrase, PKCE code exchange, then MCP over Streamable HTTP with the token.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  const c = await startHttpConnector({
    deps: { store: new InMemoryStore() },
    publicUrl: "http://127.0.0.1:1",
    port: 0,
    oauthStatePath: statePath,
    passphraseHash: hashPassphrase(PASS),
  });
  base = c.url;
  close = c.close;
});
afterAll(async () => { await close(); });

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function register(): Promise<string> {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "claude-test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function startAuthorize(clientId: string, challenge: string): Promise<string> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toMatch(/Connect claude-test to your memory/);
  return html.match(/name="pending" value="([^"]+)"/)![1]!;
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
  it("an unsigned request is told where to sign in", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(((await meta.json()) as { code_challenge_methods_supported: string[] }).code_challenge_methods_supported).toContain("S256");
  });

  it("a wrong passphrase issues no code, and five lock the page", async () => {
    const clientId = await register();
    for (let i = 0; i < 5; i++) {
      const pending = await startAuthorize(clientId, "x".repeat(43));
      const r = await fetch(`${base}/consent`, { method: "POST", headers: FORM, body: form({ pending, passphrase: "nope" }), redirect: "manual" });
      expect(r.status).toBe(401);
    }
    const pending = await startAuthorize(clientId, "x".repeat(43));
    const locked = await fetch(`${base}/consent`, { method: "POST", headers: FORM, body: form({ pending, passphrase: PASS }), redirect: "manual" });
    expect(locked.status).toBe(429);
    // Clear the lock for the other tests.
    const s = JSON.parse(readFileSync(statePath, "utf8")) as { failures: unknown };
    s.failures = { count: 0, lockedUntil: 0 };
    writeFileSync(statePath, JSON.stringify(s));
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
