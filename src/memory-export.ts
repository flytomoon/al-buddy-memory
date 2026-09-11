import type { MemoryNode, MemoryNodeType, MemoryStore } from "./types/memory.js";

/**
 * Render a project's memory as a human-readable Markdown mirror.
 *
 * This is deliberately a **read-only export** (a window, not a door): the source
 * of truth is the governed store, and this file is generated, never read back —
 * so editing it changes nothing, closing the "someone plants a false memory"
 * tampering vector. Every memory shows its provenance and validity, and retired
 * (superseded) memories are preserved in their own section, so the file is a
 * tamper-evident, auditable view of what the companion believes and how it
 * changed over time.
 */
export async function exportMemoryMarkdown(store: MemoryStore, project: string): Promise<string> {
  const all = await store.searchNodes({ limit: 10_000 });
  const current = all.filter((n) => n.validTo === null);
  const retired = all.filter((n) => n.validTo !== null);

  const out: string[] = [];
  out.push(`# Memory — ${project}`);
  out.push("");
  out.push("> **Read-only mirror.** The source of truth is the governed memory store; this file");
  out.push("> is generated and is **not read back**, so edits here change nothing. Every memory");
  out.push("> shows where it came from and its validity — tamper-evident by design. Retired");
  out.push("> memories are preserved below, never erased.");
  out.push("");

  // --- Current, grouped by type ---
  const groups = new Map<MemoryNodeType, MemoryNode[]>();
  for (const n of current) {
    const bucket = groups.get(n.memoryType) ?? [];
    bucket.push(n);
    groups.set(n.memoryType, bucket);
  }
  for (const [type, nodes] of groups) {
    out.push(`## ${type}`);
    for (const n of nodes) {
      out.push(`- ${n.content.text}`);
      out.push(`  _${n.provenance} · confidence ${n.confidenceWeight} · since ${n.validFrom}_`);
    }
    out.push("");
  }

  // --- Retired (superseded) memories, kept for history ---
  if (retired.length > 0) {
    out.push(`## Retired (no longer current — preserved for history)`);
    for (const n of retired) {
      out.push(`- ~~${n.content.text}~~`);
      out.push(`  _${n.provenance} · valid ${n.validFrom} → ${n.validTo}_`);
    }
    out.push("");
  }

  return out.join("\n");
}
