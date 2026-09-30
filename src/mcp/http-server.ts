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
 * One owner, one store. The app a fact came from is the client that connected
 * (its MCP handshake name), exactly as over stdio.
 */
import type { Server } from "node:http";

import type { GovernanceDeps } from "./governance-server.js";
import { createGovernanceMcpServer } from "./governance-server.js";
import { OwnerOAuthProvider } from "./owner-oauth.js";

export interface HttpConnectorOptions {
  deps: GovernanceDeps;
  /** The public origin the apps reach, e.g. https://mac.tailnet.ts.net:8443 — the OAuth issuer. */
  publicUrl: string;
  port: number;
  /** Default 127.0.0.1: the tunnel is the only way in. */
  host?: string;
  oauthStatePath: string;
  passphraseHash: string;
  log?: (line: string) => void;
}

export async function startHttpConnector(opts: HttpConnectorOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const express = (await import("express")).default;
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { requireBearerAuth } = await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
  const log = opts.log ?? (() => undefined);

  const issuer = new URL(opts.publicUrl);
  const mcpUrl = new URL("/mcp", issuer);
  const provider = new OwnerOAuthProvider({ statePath: opts.oauthStatePath, passphraseHash: opts.passphraseHash });

  const app = express();
  // Behind Tailscale Funnel: the client's address arrives in X-Forwarded-For (the SDK's rate limits key on it).
  app.set("trust proxy", 1);
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

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const { server } = await createGovernanceMcpServer(opts.deps);
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void (server as { close: () => Promise<void> }).close();
    });
    try {
      await (server as { connect: (t: unknown) => Promise<void> }).connect(transport);
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
