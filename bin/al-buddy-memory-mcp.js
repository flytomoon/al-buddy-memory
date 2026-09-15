#!/usr/bin/env node
// The governance MCP server over stdio, serving a GOVERNED store: the owner's
// policy applies, the AI client is the audience, every call is audited.
// Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db),
//      AL_BUDDY_MEMORY_OWNER (default "owner"),
//      AL_BUDDY_MEMORY_AUDIT (default <db>.audit.jsonl) — a hash-chained log; check it with
//      `al-buddy-memory verify-audit <file>`,
//      AL_BUDDY_MEMORY_AUDIT_KEY (optional) — HMAC key for the chain; keep it away from the log.
import { homedir } from "node:os";
import { join } from "node:path";
import { ChainedAudit, SqliteMemoryStore } from "../dist/index.js";
import { attachGovernanceServer, serverStore } from "../dist/mcp/governance-server.js";
const db = process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db");
const audit = new ChainedAudit(process.env.AL_BUDDY_MEMORY_AUDIT ?? `${db}.audit.jsonl`, process.env.AL_BUDDY_MEMORY_AUDIT_KEY ? { key: process.env.AL_BUDDY_MEMORY_AUDIT_KEY } : {});
// Fail at start, with the reason, if the log cannot be extended — never after a write.
try {
  await audit.head();
} catch (err) {
  console.error(`al-buddy-memory-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const store = serverStore(new SqliteMemoryStore(db), { owner: process.env.AL_BUDDY_MEMORY_OWNER ?? "owner", audit });
const { connectStdio } = await attachGovernanceServer({ store });
await connectStdio();
