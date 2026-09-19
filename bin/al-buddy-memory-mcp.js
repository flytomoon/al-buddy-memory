#!/usr/bin/env node
// The governance MCP server over stdio, serving a GOVERNED store: the owner's
// policy applies, the AI client is the audience, every call is audited.
//
// Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db; a leading ~ is
//      expanded, because a JSON config is not a shell),
//      AL_BUDDY_MEMORY_OWNER (default "owner"),
//      AL_BUDDY_MEMORY_AUDIT (optional) — a JSONL file to write the chained log
//      to INSTEAD of the database's own `audit_events` table. Only one process
//      may write one such file; give each its own, or leave this unset.
//      AL_BUDDY_MEMORY_AUDIT_KEY (optional) — HMAC key for the chain; keep it away from the trail.
//
// By default the trail goes in the database, in the same transaction as the
// fact it describes: no instant at which a fact exists and nothing attests to
// it, and one chain however many assistants are running. Check it with
// `al-buddy-memory verify-audit <db>`, which also reports any per-process JSONL
// logs still sitting at `<db>.audit/` from before the table existed. Those are NOT adopted
// and NOT extended — they cover a period the table cannot attest to, and the
// table covers one they cannot.
import { homedir } from "node:os";
import { join } from "node:path";
import { ChainedAudit, SqliteMemoryStore, expandHome, storeAudit } from "../dist/index.js";
import { attachGovernanceServer, serverStore } from "../dist/mcp/governance-server.js";
const db = expandHome(process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db"));
const key = process.env.AL_BUDDY_MEMORY_AUDIT_KEY;
const inner = new SqliteMemoryStore(db, key ? { auditKey: key } : {});
const audit = process.env.AL_BUDDY_MEMORY_AUDIT
  ? new ChainedAudit(expandHome(process.env.AL_BUDDY_MEMORY_AUDIT), key ? { key } : {})
  : storeAudit(inner);
// Fail at start, with the reason, if the chain cannot be extended — never after a write.
try {
  await audit.head();
} catch (err) {
  console.error(`al-buddy-memory-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const store = serverStore(inner, { owner: process.env.AL_BUDDY_MEMORY_OWNER ?? "owner", audit });
const { connectStdio } = await attachGovernanceServer({ store });
await connectStdio();
