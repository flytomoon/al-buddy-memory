/**
 * The audit trail: an append-only record of every governed decision. Who
 * wrote, who read what, what was refused and by which policy. The sink is
 * pluggable; the in-memory one is for tests and single sessions, the JSONL
 * one for a file that survives the process.
 */
import type { Purpose } from "./policy.js";

export interface AuditEvent {
  at: string;
  actor: string;
  audience?: string | undefined;
  purpose: Purpose;
  outcome: "allowed" | "denied" | "hidden";
  /** Facts touched (capped — the count is exact, the ids are a sample). */
  nodeIds: string[];
  count: number;
  policy?: string | undefined;
  reason?: string | undefined;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export const AUDIT_ID_SAMPLE = 20;

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** Append-only JSON lines. One event per line; nothing is ever rewritten. */
export class JsonlAudit implements AuditSink {
  constructor(private readonly path: string) {}
  async record(event: AuditEvent): Promise<void> {
    const { appendFile } = await import("node:fs/promises");
    // Owner-only, like the database it describes: the trail names actors and fact ids.
    await appendFile(this.path, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}
