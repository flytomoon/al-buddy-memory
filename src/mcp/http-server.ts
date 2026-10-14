/**
 * The governance MCP server over HTTPS, for a remote connector in Claude or
 * ChatGPT (Streamable HTTP, stateless: every POST gets a fresh MCP server, so
 * no session outlives its request). The tools under it are built once, over
 * the one governed store: built per request, the retriever read every stored
 * vector on every recall and the pinned tier rode every recall (Fable review
 * M4). The pins go to each signed-in app instead: with its first recall after
 * each sign-in, and its next after the tier changes.
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
 * POST gets a fresh server, so a tool call never sees the handshake. The shared
 * tools learn each request's app from `REQUEST`, below.
 *
 * Or, for an organisation, signed in by its own identity provider (oidc.ts):
 * no passphrase and no sign-in of its own. Every request's bearer token is
 * checked against the issuer's keys, and `deps` is asked for the tools of the
 * person it names, with their tenant and attributes. A token that does not
 * verify gets the 401 and never reaches `deps`. The app is whatever `deps`
 * says in `origin` (the token names a person, not an app); without one, facts
 * record only that they came over HTTP. Its tools are built per request, over
 * the store `deps` picks, but share that store's retriever; the pinned tier
 * reaches each person (in their tenant) once, and again when it changes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { GovernanceDeps, GovernanceTools } from "./governance-server.js";
import { createGovernanceMcpServer, governanceTools, PinDeliveries } from "./governance-server.js";
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
   * `pinning`, `connection` and `pinDeliveries` are the connector's own.
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

/** The request a tool call runs for: the app it came through, when known, and who its pins are delivered to. */
interface RequestContext {
  app?: string | undefined;
  connection: string;
}
const REQUEST = new AsyncLocalStorage<RequestContext>();
/** What one request is served with: the tools' deps, the tool layer when it is shared, and the request's context. */
interface Served {
  deps: GovernanceDeps;
  tools?: GovernanceTools;
  request: RequestContext;
}

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
  let serve: (auth: AuthInfo | undefined) => Promise<Served>;
  // Never pinning here, whatever deps a host passes: a remote client must not plant a standing rule in every prompt (Fable review M2).
  const remote = (deps: GovernanceDeps, deliveries: PinDeliveries): GovernanceDeps => ({
    ...deps,
    pinning: false,
    pinDeliveries: deliveries,
    connection: () => REQUEST.getStore()?.connection,
  });
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
    // Tools per request, over whatever store `deps` picks for the person; the
    // retriever is shared per store (governance-server.ts), the pins per person.
    const deliveries = new PinDeliveries();
    serve = async (auth) => {
      const who = auth?.extra?.["identity"] as OidcIdentity | undefined;
      if (!who) throw new Error("no verified identity on the request");
      const deps = await opts.deps(who);
      return {
        deps: remote({ ...deps, origin: deps.origin ?? overHttp() }, deliveries),
        request: { connection: JSON.stringify([who.tenant ?? null, who.actor]) },
      };
    };
    // Where to sign in (RFC 9728): the organisation's identity provider, not this server.
    const metadata = { resource: mcpUrl.href, authorization_servers: [opts.oidc.issuer], bearer_methods_supported: ["header"], resource_name: "al-buddy-memory" };
    app.get(new URL(getOAuthProtectedResourceMetadataUrl(mcpUrl)).pathname, (_req, res) => { res.json(metadata); });
  } else {
    const deliveries = new PinDeliveries();
    const provider = new OwnerOAuthProvider({
      statePath: opts.oauthStatePath,
      passphraseHash: opts.passphraseHash,
      log,
      // A new sign-in is a new start for that app: its next recall carries the pins.
      onSignIn: (clientId) => { deliveries.forget(clientId); },
      ...(opts.allowedRedirectOrigins && { allowedRedirectOrigins: opts.allowedRedirectOrigins }),
    });
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
    // One owner, one store, one tool layer for every request. The app is the
    // client this token was issued to, by the name the owner saw when allowing it.
    const hostOrigin = opts.deps.origin;
    const deps = remote({ ...opts.deps, origin: hostOrigin ?? (() => overHttp(REQUEST.getStore()?.app)()) }, deliveries);
    const tools = governanceTools(deps);
    serve = async (auth) => {
      const client = !hostOrigin && auth ? await provider.clientsStore.getClient(auth.clientId) : undefined;
      return { deps, tools, request: { app: clientApp(client?.client_name), connection: auth?.clientId ?? "" } };
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
      const { deps, tools, request } = await serve((req as { auth?: AuthInfo }).auth);
      const fresh = (await createGovernanceMcpServer(deps, tools ? { tools } : {})).server as unknown as NonNullable<typeof server>;
      server = fresh;
      // The tool calls this request makes run inside it, and read their app and connection from it.
      await REQUEST.run(request, async () => {
        await fresh.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
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
