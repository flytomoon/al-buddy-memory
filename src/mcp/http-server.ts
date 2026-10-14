/**
 * The governance MCP server over HTTPS, for a remote connector in Claude or
 * ChatGPT (Streamable HTTP, stateless: every POST gets a fresh server bound to
 * the same governed store, so nothing about one request outlives it).
 *
 * Signed in with OAuth 2.1 (owner-oauth.ts), with the SDK's own handlers for
 * discovery, dynamic client registration, authorize, token and revoke, and its
 * bearer middleware in front of /mcp — an unsigned request gets the 401 with a
 * resource_metadata pointer that both clients follow to sign in.
 *
 * One owner, one store. The app a fact came from is the client the owner let in
 * on the consent page, by the name it registered with: the fact's `origin`, and
 * the audit event's when the store's context reads `actingOrigin()` (the
 * shipped `serverStore` does). Not the MCP handshake name, as over stdio: every
 * POST gets a fresh server, so a tool call never sees the handshake.
 *
 * Or, for an organisation, signed in by its own identity provider (oidc.ts):
 * no passphrase and no sign-in of its own. Every request's bearer token is
 * checked against the issuer's keys, and `deps` is asked for the tools of the
 * person it names, with their tenant and attributes. A token that does not
 * verify gets the 401 and never reaches `deps`. The app is whatever `deps`
 * says in `origin` (the token names a person, not an app); without one, facts
 * record only that they came over HTTP.
 */
import type { Server } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { GovernanceDeps } from "./governance-server.js";
import { createGovernanceMcpServer } from "./governance-server.js";
import { oidcVerifier, OidcTokenRefused, type OidcIdentity, type OidcOptions } from "./oidc.js";
import { OwnerOAuthProvider } from "./owner-oauth.js";
import type { Origin } from "../provenance.js";

export { actingOrigin } from "./governance-server.js";
export { ASYMMETRIC_ALGORITHMS, oidcVerifier, OidcTokenRefused, type OidcIdentity, type OidcOptions } from "./oidc.js";

export interface HttpConnectorOptions {
  deps: GovernanceDeps;
  /** The public origin the apps reach, e.g. https://mac.tailnet.ts.net:8443 — the OAuth issuer. */
  publicUrl: string;
  port: number;
  /** Default 127.0.0.1: the tunnel is the only way in. */
  host?: string;
  oauthStatePath: string;
  passphraseHash: string;
  /** Origins apps may send the sign-in code to (default: Claude and ChatGPT; this machine always). */
  allowedRedirectOrigins?: readonly string[];
  log?: (line: string) => void;
}

/** The server signed in by an organisation's identity provider instead of the owner's passphrase. */
export interface OidcConnectorOptions {
  /** The identity provider whose bearer tokens are accepted. */
  oidc: OidcOptions;
  /**
   * The tools' dependencies for one verified person, asked on every request:
   * pick the tenant's store and govern it with `{ actor, attributes }` from
   * `who`, with `origin: actingOrigin()` in that context so the audit trail
   * names the app as well as the person. `origin` in what it returns is the
   * app the facts record; without one they record `{ via: "mcp-http" }`.
   * Throwing refuses the request (500); nothing is served without it.
   */
  deps: (who: OidcIdentity) => GovernanceDeps | Promise<GovernanceDeps>;
  /** The public origin the apps reach; `/mcp` under it is the resource the tokens are for. */
  publicUrl: string;
  port: number;
  /** Default 127.0.0.1. */
  host?: string;
  log?: (line: string) => void;
}

/** An app-chosen name, as an origin carries it: one line, at most 80 characters (like the connector log's). */
const clientApp = (name: string | undefined): string | undefined => name?.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 80);
const overHttp = (app?: string): (() => Origin) => () => ({ ...(app && { app }), via: "mcp-http" });

const isOidc = (o: HttpConnectorOptions | OidcConnectorOptions): o is OidcConnectorOptions => "oidc" in o && o.oidc !== undefined;

export async function startHttpConnector(opts: HttpConnectorOptions | OidcConnectorOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const express = (await import("express")).default;
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { requireBearerAuth } = await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
  const { InvalidTokenError } = await import("@modelcontextprotocol/sdk/server/auth/errors.js");
  const log = opts.log ?? (() => undefined);

  const issuer = new URL(opts.publicUrl);
  const mcpUrl = new URL("/mcp", issuer);

  const app = express();
  // Behind Tailscale Funnel: the client's address arrives in X-Forwarded-For (the SDK's rate limits key on it).
  app.set("trust proxy", 1);

  let verifier: { verifyAccessToken: (token: string) => Promise<AuthInfo> };
  let depsFor: (auth: AuthInfo | undefined) => GovernanceDeps | Promise<GovernanceDeps>;
  if (isOidc(opts)) {
    const oidc = oidcVerifier(opts.oidc);
    verifier = {
      async verifyAccessToken(token) {
        try {
          const who = await oidc.verify(token);
          return { token, clientId: who.actor, scopes: who.scopes, expiresAt: who.expiresAt, extra: { identity: who } };
        } catch (err) {
          // Fails closed: whatever went wrong, the caller gets the 401 and the pointer to sign in.
          log(`connector: token refused: ${err instanceof OidcTokenRefused ? err.reason : "verification failed"}`);
          throw new InvalidTokenError("invalid or expired token");
        }
      },
    };
    depsFor = async (auth) => {
      const who = auth?.extra?.["identity"] as OidcIdentity | undefined;
      if (!who) throw new Error("no verified identity on the request");
      const deps = await opts.deps(who);
      return { ...deps, origin: deps.origin ?? overHttp() };
    };
    // Where to sign in (RFC 9728): the organisation's identity provider, not this server.
    const metadata = { resource: mcpUrl.href, authorization_servers: [opts.oidc.issuer], bearer_methods_supported: ["header"], resource_name: "al-buddy-memory" };
    app.get(new URL(getOAuthProtectedResourceMetadataUrl(mcpUrl)).pathname, (_req, res) => { res.json(metadata); });
  } else {
    const provider = new OwnerOAuthProvider({ statePath: opts.oauthStatePath, passphraseHash: opts.passphraseHash, log, ...(opts.allowedRedirectOrigins && { allowedRedirectOrigins: opts.allowedRedirectOrigins }) });
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: issuer,
        resourceServerUrl: mcpUrl,
        resourceName: "al-buddy-memory",
        scopesSupported: ["memory"],
      }),
    );

    app.post(provider.consentPath, express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = provider.consent(String(body["pending"] ?? ""), String(body["passphrase"] ?? ""));
      if ("redirect" in out) {
        log("connector: an app was allowed");
        res.redirect(302, out.redirect);
      } else {
        res.status(out.status).type("html").send(out.page);
      }
    });
    verifier = provider;
    const deps = opts.deps;
    // The app is the client this token was issued to, by the name the owner saw when allowing it.
    depsFor = async (auth) => {
      if (deps.origin) return deps;
      const client = auth ? await provider.clientsStore.getClient(auth.clientId) : undefined;
      return { ...deps, origin: overHttp(clientApp(client?.client_name)) };
    };
  }

  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    let server: { connect: (t: unknown) => Promise<void>; close: () => Promise<void> } | undefined;
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void server?.close();
    });
    try {
      // Never pinning here, whatever deps a host passes: a remote client must not plant a standing rule in every prompt (Fable review M2).
      server = (await createGovernanceMcpServer({ ...(await depsFor((req as { auth?: AuthInfo }).auth)), pinning: false })).server as unknown as typeof server;
      await server!.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`connector: request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  // Stateless: no server-initiated stream, no sessions to end.
  const notAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", bearer, notAllowed);
  app.delete("/mcp", bearer, notAllowed);
  app.get("/health", (_req, res) => { res.json({ ok: true }); });

  const host = opts.host ?? "127.0.0.1";
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(opts.port, host, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`connector: listening on http://${host}:${port}, public ${mcpUrl.href}`);
  return {
    server,
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}
