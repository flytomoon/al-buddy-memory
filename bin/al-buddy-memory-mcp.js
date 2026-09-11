#!/usr/bin/env node
// The governance MCP server over stdio. Env: AL_BUDDY_MEMORY_DB (default ~/.al-buddy-memory/brain.db)
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../dist/index.js";
import { attachGovernanceServer } from "../dist/mcp/governance-server.js";
const db = process.env.AL_BUDDY_MEMORY_DB ?? join(homedir(), ".al-buddy-memory", "brain.db");
const { connectStdio } = await attachGovernanceServer({ store: new SqliteMemoryStore(db) });
await connectStdio();
