#!/usr/bin/env node
// The governance MCP server over stdio, serving a GOVERNED store: the owner's
// policy applies, the AI client is the audience, every call is audited.
//
// Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db; a leading ~ is
//      expanded, because a JSON config is not a shell),
//      AL_BUDDY_MEMORY_OWNER (default "owner"),
//      AL_BUDDY_MEMORY_AUDIT (default <db>.audit/<start>-<pid>.jsonl) — a
//      hash-chained log, one file per server process so two assistants on one
//      memory cannot fork a chain; check them with
//      `al-buddy-memory verify-audit <db>.audit`. Set this to pin ONE file, and
//      then run only one server against it.
//      AL_BUDDY_MEMORY_AUDIT_KEY (optional) — HMAC key for the chain; keep it away from the log.
import { homedir } from "node:os";
import { join } from "node:path";
import { ChainedAudit, SqliteMemoryStore, auditLogPath, expandHome } from "../dist/index.js";
import { attachGovernanceServer, serverStore } from "../dist/mcp/governance-server.js";
const db = expandHome(process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db"));
const log = process.env.AL_BUDDY_MEMORY_AUDIT ? expandHome(process.env.AL_BUDDY_MEMORY_AUDIT) : auditLogPath(db);
const audit = new ChainedAudit(log, process.env.AL_BUDDY_MEMORY_AUDIT_KEY ? { key: process.env.AL_BUDDY_MEMORY_AUDIT_KEY } : {});
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
