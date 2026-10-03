#!/usr/bin/env node
// al-buddy-memory export [--out file.json] [--format portable|markdown] [--db path]
//   the owner's backup of the memory the MCP server keeps: every fact, with its
//   provenance, validity and history, in the documented portable format
//   (docs/portable-format.schema.json) — or a read-only Markdown mirror. To
//   stdout, or to --out, a NEW file (never overwritten), readable by you only.
// al-buddy-memory import <export.json> [--db path]
//   restore a portable export verbatim, as the owner. The whole file is checked
//   before anything is written; running it twice is safe.
// al-buddy-memory context [--hook] [--max-chars N] [--cwd dir] [--db path]
//   a short briefing for the start of an assistant session (pinned rules, facts
//   mentioning the project, the most recent facts), read as the assistant would
//   see it. --hook reads a Claude Code hook's JSON from stdin for the working
//   directory. Prints nothing when there is no memory yet; never creates it.
// The database is AL_BUDDY_MEMORY_DB, else ~/.al-buddy-memory/brain.db — the
// MCP server's. --db overrides both.
// al-buddy-memory conformance <export.json> [--format portable|blocks|records] [--json]
// al-buddy-memory conformance --demo        score a small governed store, for comparison
// al-buddy-memory verify-audit <memory.db | audit.jsonl | <db>.audit dir> [--head <hash>]
//   check a hash-chained audit trail. Point it at a DATABASE and it checks the
//   `audit_events` table inside it — one chain, however many processes wrote it —
//   plus any per-process JSONL logs still sitting at <db>.audit/. Point it at a
//   file or a directory of files and it checks those. The HMAC key, if the trail
//   has one, comes from AL_BUDDY_MEMORY_AUDIT_KEY (never the command line, which
//   lands in shell history). --head anchors ONE chain, so it names a database or a
//   file, not a directory of files.
// al-buddy-memory mcp
//   the stdio MCP server, exactly as `al-buddy-memory-mcp` (same env vars). This
//   is the form the MCP Registry listing (server.json) starts: a client runs
//   `npx al-buddy-memory@X.Y.Z mcp`, and npx runs the bin named like the package.
import { readFileSync } from "node:fs";
import { InMemoryStore, exportPortable, verifyAuditLogs } from "../dist/index.js";
import { toConformanceInput, scoreConformance, formatReport, fromPortable } from "../dist/conformance/index.js";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);

if (cmd === "verify-audit") {
  if (!args[1]) {
    console.error("usage: al-buddy-memory verify-audit <memory.db | audit.jsonl | <db>.audit> [--head <hash>]");
    process.exit(2);
  }
  const key = process.env.AL_BUDDY_MEMORY_AUDIT_KEY;
  const checked = await verifyAuditLogs(args[1], { ...(key ? { key } : {}), ...(flag("--head") ? { head: flag("--head") } : {}) });
  // One line per chain. A database has exactly one, however many processes
  // wrote it; a directory of JSONL logs has one per writer, each standing on its
  // own, and the set is intact only when every one of them is.
  for (const { file, form, result } of checked.logs) {
    const label = checked.logs.length > 1 ? `${file}${form === "table" ? " (audit_events)" : ""}: ` : "";
    const unit = form === "table" ? "event" : "line";
    if (result.ok) console.log(`${label}intact: ${result.count} events, head ${result.head}`);
    else console.error(`${label}${result.line > 0 ? `BROKEN at ${unit} ${result.line} of ${result.count}` : "NOT VERIFIED"}: ${result.reason}`);
  }
  if (checked.reason) console.error(`NOT VERIFIED: ${checked.reason}`);
  process.exit(checked.ok ? 0 : 1);
}

if (cmd === "export" || cmd === "import" || cmd === "context") {
  const cli = await import("../dist/cli.js");
  const db = flag("--db") ? cli.memoryDbPath({ AL_BUDDY_MEMORY_DB: flag("--db") }) : cli.memoryDbPath();
  const owner = process.env.AL_BUDDY_MEMORY_OWNER ?? "owner";
  try {
    if (cmd === "export") {
      const format = flag("--format") ?? "portable";
      if (format !== "portable" && format !== "markdown") throw new Error(`--format must be portable or markdown (got ${format})`);
      const text = await cli.exportMemory({ db, owner, format });
      const out = flag("--out");
      if (out) {
        cli.writeNewFile(out, text);
        console.error(`exported ${db} to ${out} (${Buffer.byteLength(text)} bytes, ${format})`);
      } else process.stdout.write(text);
    } else if (cmd === "import") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("usage: al-buddy-memory import <export.json> [--db path]");
      const summary = await cli.importMemory({ db, owner, file: args[1] });
      console.log(`imported ${summary.nodes} fact(s) and ${summary.edges} link(s) into ${db}`);
    } else {
      let cwd = flag("--cwd") ?? process.cwd();
      if (has("--hook")) {
        // A hook's input is one JSON object on stdin; only its cwd is used.
        try {
          const input = JSON.parse(readFileSync(0, "utf8") || "{}");
          if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
        } catch {
          /* no usable hook input: fall back to this process's directory */
        }
      }
      const maxChars = flag("--max-chars") !== undefined ? Number(flag("--max-chars")) : undefined;
      const text = await cli.sessionContext({ db, owner, cwd, ...(Number.isFinite(maxChars) ? { maxChars } : {}) });
      if (text) process.stdout.write(text + "\n");
    }
    process.exit(0);
  } catch (err) {
    console.error(`${cmd}: ${err instanceof Error ? err.message : String(err)}`);
    // A session-start hook must never get in the way of the session.
    process.exit(cmd === "context" && has("--hook") ? 0 : 1);
  }
}

if (cmd !== "conformance" && cmd !== "mcp") {
  console.error("usage: al-buddy-memory conformance <export.json> [--format portable|blocks|records] [--json]\n       al-buddy-memory conformance --demo\n       al-buddy-memory verify-audit <memory.db | audit.jsonl> [--head <hash>]\n       al-buddy-memory export [--out file.json] [--format portable|markdown] [--db path]\n       al-buddy-memory import <export.json> [--db path]\n       al-buddy-memory context [--hook] [--max-chars N] [--cwd dir] [--db path]\n       al-buddy-memory mcp");
  process.exit(2);
}

async function demoInput() {
  const store = new InMemoryStore();
  const base = { encryptionKeyRef: "demo", privacyClassification: "Private", retentionTier: "FullRetention", contextualMetadata: {}, decayRate: 0 };
  const london = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in London" }, confidenceWeight: 1, validFrom: "2024-01-01T00:00:00Z" });
  const tokyo = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in Tokyo" }, confidenceWeight: 1, validFrom: "2026-06-01T00:00:00Z" });
  await store.updateNode(london.nodeId, { validTo: "2026-06-01T00:00:00Z", contextualMetadata: { supersededBy: tokyo.nodeId } });
  const derived = await store.addNode({ ...base, provenance: "AIInferred", memoryType: "Lesson", content: { text: "Moved from London to Tokyo in mid-2026" }, confidenceWeight: 0.8, validFrom: "2026-06-01T00:00:00Z" });
  await store.addEdge({ sourceNodeId: derived.nodeId, targetNodeId: tokyo.nodeId, relationshipType: "Reinforcement", strength: 0.9, provenance: "AIInferred" });
  await store.addEdge({ sourceNodeId: tokyo.nodeId, targetNodeId: london.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
  return fromPortable(await exportPortable(new Map([["demo", store]])), { system: "al-buddy-memory (demo store)" });
}

if (cmd === "mcp") {
  await import("./al-buddy-memory-mcp.js");
} else {
  try {
    const input = has("--demo") ? await demoInput() : await toConformanceInput(readFileSync(args[1], "utf8"), flag("--format"));
    const report = scoreConformance(input);
    if (has("--json")) console.log(JSON.stringify({ ...report, notes: input.traits.notes ?? [] }, null, 2));
    else {
      console.log(formatReport(report));
      if (input.traits.notes?.length) console.log("\nNotes:\n" + input.traits.notes.map((n) => `- ${n}`).join("\n"));
    }
  } catch (err) {
    console.error(`conformance: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
