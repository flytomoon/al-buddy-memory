#!/usr/bin/env node
// The governance MCP server over stdio, serving a GOVERNED store: the owner's
// policy applies, the AI client is the audience, every call is audited.
// Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db),
//      AL_BUDDY_MEMORY_OWNER (default "owner"),
//      AL_BUDDY_MEMORY_AUDIT (default <db>.audit.jsonl).
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonlAudit, SqliteMemoryStore } from "../dist/index.js";
import { attachGovernanceServer, serverStore } from "../dist/mcp/governance-server.js";
const db = process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db");
const store = serverStore(new SqliteMemoryStore(db), {
  owner: process.env.AL_BUDDY_MEMORY_OWNER ?? "owner",
  audit: new JsonlAudit(process.env.AL_BUDDY_MEMORY_AUDIT ?? `${db}.audit.jsonl`),
});
const { connectStdio } = await attachGovernanceServer({ store });
await connectStdio();
