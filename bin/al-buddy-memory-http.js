#!/usr/bin/env node
// The governance MCP server over HTTPS, as a remote connector for Claude and
// ChatGPT (Streamable HTTP + OAuth 2.1). One owner, one governed store; put a
// tunnel (e.g. Tailscale Funnel) in front of it — it listens on 127.0.0.1 only.
//
//   al-buddy-memory-http --set-passphrase     read a passphrase on stdin, store its scrypt hash
//   al-buddy-memory-http                      serve
//
// Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db),
//      AL_BUDDY_MEMORY_OWNER (default "owner"),
//      AL_BUDDY_MEMORY_PUBLIC_URL (required to serve: the https origin the apps reach),
//      AL_BUDDY_MEMORY_PORT (default 8787),
//      AL_BUDDY_MEMORY_CONNECTOR_DIR (default ~/.al-buddy-memory/connector — passphrase hash + OAuth state, 0600),
//      AL_BUDDY_MEMORY_AUDIT_KEY (optional) — HMAC key for the chain, as for the stdio server.
//      AL_BUDDY_MEMORY_SEMANTIC=off, AL_BUDDY_MEMORY_INDEX_LIMIT, AL_BUDDY_MEMORY_MODEL_CACHE — as for the stdio server:
//      recall turns hybrid once the on-device model loads, keyword-only until then.
//      `export` answers inline only here: a remote client never writes files on this host.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore, expandHome, storeAudit } from "../dist/index.js";
import { serverExportView, serverStore, startSemanticRecall } from "../dist/mcp/governance-server.js";
import { startHttpConnector } from "../dist/mcp/http-server.js";
import { hashPassphrase } from "../dist/mcp/owner-oauth.js";

const dir = expandHome(process.env.AL_BUDDY_MEMORY_CONNECTOR_DIR ?? join(homedir(), ".al-buddy-memory", "connector"));
const passFile = join(dir, "passphrase.hash");

if (process.argv.includes("--set-passphrase")) {
  const pass = readFileSync(0, "utf8").trim();
  if (pass.length < 12) {
    console.error("al-buddy-memory-http: use a passphrase of at least 12 characters");
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(passFile, hashPassphrase(pass) + "\n", { mode: 0o600 });
  console.log(`passphrase hash written to ${passFile}`);
  process.exit(0);
}

const publicUrl = process.env.AL_BUDDY_MEMORY_PUBLIC_URL;
if (!publicUrl) {
  console.error("al-buddy-memory-http: set AL_BUDDY_MEMORY_PUBLIC_URL to the https origin the apps reach");
  process.exit(1);
}
let passphraseHash;
try {
  passphraseHash = readFileSync(passFile, "utf8").trim();
} catch {
  console.error(`al-buddy-memory-http: no passphrase yet — run: al-buddy-memory-http --set-passphrase  (reads it on stdin)`);
  process.exit(1);
}
const db = expandHome(process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db"));
const key = process.env.AL_BUDDY_MEMORY_AUDIT_KEY;
const inner = new SqliteMemoryStore(db, key ? { auditKey: key } : {});
const audit = storeAudit(inner);
try {
  await audit.head();
} catch (err) {
  console.error(`al-buddy-memory-http: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const owner = process.env.AL_BUDDY_MEMORY_OWNER ?? "owner";
const store = serverStore(inner, { owner, audit });
const off = (process.env.AL_BUDDY_MEMORY_SEMANTIC ?? "").trim().toLowerCase();
const indexLimit = Number(process.env.AL_BUDDY_MEMORY_INDEX_LIMIT ?? "5000");
const semantic = startSemanticRecall({
  indexStore: inner,
  indexLimit: Number.isFinite(indexLimit) && indexLimit >= 0 ? indexLimit : 5000,
  modelCacheDir: expandHome(process.env.AL_BUDDY_MEMORY_MODEL_CACHE ?? join(homedir(), ".al-buddy-memory", "models")),
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  ...(["off", "0", "false", "no"].includes(off) ? { disabledBy: "AL_BUDDY_MEMORY_SEMANTIC=off" } : {}),
});
await startHttpConnector({
  deps: {
    store,
    embedder: () => semantic.current(),
    onEmbedderFailure: (reason) => semantic.disable(`the embedder failed: ${reason}`),
    exportStore: serverExportView(inner, { owner, audit }),
  },
  publicUrl,
  port: Number(process.env.AL_BUDDY_MEMORY_PORT ?? 8787),
  oauthStatePath: join(dir, "oauth.json"),
  passphraseHash,
  // AL_BUDDY_MEMORY_REDIRECT_ORIGINS="https://claude.ai,https://chatgpt.com" overrides the allowed sign-in destinations.
  ...(process.env.AL_BUDDY_MEMORY_REDIRECT_ORIGINS && { allowedRedirectOrigins: process.env.AL_BUDDY_MEMORY_REDIRECT_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) }),
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
