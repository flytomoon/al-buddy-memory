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
//      AL_BUDDY_MEMORY_SEMANTIC=off (optional) — keyword recall only; the on-device
//      embedding model is never loaded or downloaded.
//      AL_BUDDY_MEMORY_INDEX_LIMIT (optional, default 5000) — facts embedded in the
//      background per start; 0 skips the backfill.
//      AL_BUDDY_MEMORY_MODEL_CACHE (optional, default ~/.al-buddy-memory/models) —
//      where the embedding model is kept after its one-time download.
//
// Recall is hybrid (keyword + on-device vectors) once the embedding model has
// loaded — a one-time download on first use, then offline. Until then, or if
// it cannot load (the optional dependency missing, no onnxruntime binary for
// this platform, no network on first run), recall is keyword-only and stderr
// says so once. The server never waits for the model to start.
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
import { attachGovernanceServer, serverExportView, serverStore, startSemanticRecall } from "../dist/mcp/governance-server.js";
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
const owner = process.env.AL_BUDDY_MEMORY_OWNER ?? "owner";
const store = serverStore(inner, { owner, audit });
const off = (process.env.AL_BUDDY_MEMORY_SEMANTIC ?? "").trim().toLowerCase();
const indexLimit = Number(process.env.AL_BUDDY_MEMORY_INDEX_LIMIT ?? "5000");
// Vectors are a cache over the raw store; what recall may SEE is decided at read time.
const semantic = startSemanticRecall({
  indexStore: inner,
  indexLimit: Number.isFinite(indexLimit) && indexLimit >= 0 ? indexLimit : 5000,
  modelCacheDir: expandHome(process.env.AL_BUDDY_MEMORY_MODEL_CACHE ?? join(homedir(), ".al-buddy-memory", "models")),
  ...(["off", "0", "false", "no"].includes(off) ? { disabledBy: "AL_BUDDY_MEMORY_SEMANTIC=off" } : {}),
});
const { connectStdio } = await attachGovernanceServer({
  store,
  embedder: () => semantic.current(),
  onEmbedderFailure: (reason) => semantic.disable(`the embedder failed: ${reason}`),
  exportStore: serverExportView(inner, { owner, audit }),
  exportToFiles: true,
});
await connectStdio();
