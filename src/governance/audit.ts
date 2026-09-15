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

// ---------------------------------------------------------------------------
// The chained log — tamper-evident, and honest about what that means
// ---------------------------------------------------------------------------

const GENESIS = "0".repeat(64);

/** What a JSON line will hold, with keys sorted so the hash does not depend on key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

async function digest(prev: string, event: unknown, key: string | undefined): Promise<string> {
  const { createHash, createHmac } = await import("node:crypto");
  const body = `${prev}\n${canonical(event)}`;
  return (key === undefined ? createHash("sha256") : createHmac("sha256", key)).update(body).digest("hex");
}

/**
 * Append-only JSON lines where every line carries the hash of the line before
 * it (`prev`) and of itself (`hash`). Editing, removing, inserting or
 * reordering any line breaks the chain at that line, and verifyAuditChain names
 * it. With a `key` (HMAC-SHA256) the chain cannot be recomputed by someone who
 * does not hold the key — keep it somewhere other than beside the log.
 *
 * What a file cannot prove about itself: that its tail was not cut off, or that
 * a key holder did not rewrite it. For that, publish `head()` somewhere the
 * log's owner does not control (a git commit, a transparency log) and verify
 * against it. One writer per file — two processes appending would fork the chain.
 */
export class ChainedAudit implements AuditSink {
  // A true private field: JSON.stringify and util.inspect printed the key when it
  // was an ordinary property (Fable final review, 2026-09-15).
  readonly #key: string | undefined;
  #tail: Promise<string> | null = null;

  constructor(
    private readonly path: string,
    opts: { key?: string } = {},
  ) {
    this.#key = opts.key;
  }

  private async readHead(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return GENESIS;
    }
    const last = text.trimEnd().split("\n").at(-1);
    if (!last) return GENESIS;
    let rec: unknown;
    try {
      rec = JSON.parse(last);
    } catch {
      throw new Error(`${this.path}: the last line is incomplete or not JSON, so the chain cannot be extended; remove that line (verify-audit names it) and restart`);
    }
    const hash = rec && typeof rec === "object" ? (rec as { hash?: unknown }).hash : undefined;
    if (typeof hash !== "string") throw new Error(`${this.path} is not a chained audit log (its last line has no hash); use a new file`);
    return hash;
  }

  /** Keep a promise we hold from ever surfacing as an unhandled rejection; callers still see it reject. */
  #hold(p: Promise<string>): Promise<string> {
    p.catch(() => undefined);
    this.#tail = p;
    return p;
  }

  /** The hash of the newest line — the value to anchor elsewhere. Rejects if the file cannot be chained. */
  head(): Promise<string> {
    return this.#tail ?? this.#hold(this.readHead());
  }

  record(event: AuditEvent): Promise<void> {
    const base = this.head();
    // Appends are serialised in order, so concurrent calls still form one chain;
    // a failed append leaves the head where it was. A log that cannot be chained
    // rejects every record with the same error — it used to leave a rejected
    // promise with no handler, which killed the process after the store write
    // had committed.
    const next = base.then(async (prev) => {
      const plain = JSON.parse(JSON.stringify(event)) as AuditEvent;
      const hash = await digest(prev, plain, this.#key);
      const { appendFile } = await import("node:fs/promises");
      await appendFile(this.path, JSON.stringify({ prev, hash, event: plain }) + "\n", { encoding: "utf8", mode: 0o600 });
      return hash;
    });
    this.#hold(next.catch(() => base));
    return next.then(() => undefined);
  }
}

export type AuditChainResult =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; line: number; reason: string };

/** Check a ChainedAudit file line by line. `head`: the last hash you anchored elsewhere. */
export async function verifyAuditChain(path: string, opts: { key?: string; head?: string } = {}): Promise<AuditChainResult> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // A verifier must never call a wrong path "intact: 0 events".
    const missing = (err as { code?: string }).code === "ENOENT";
    return { ok: false, count: 0, line: 0, reason: missing ? `no such file: ${path}` : `cannot read ${path}: ${(err as Error).message}` };
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let prev = GENESIS;
  for (const [i, line] of lines.entries()) {
    const at = { ok: false as const, count: lines.length, line: i + 1 };
    let rec: { prev?: unknown; hash?: unknown; event?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      return { ...at, reason: `line ${i + 1} is not JSON` };
    }
    if (typeof rec.prev !== "string" || typeof rec.hash !== "string" || rec.event === undefined) {
      return { ...at, reason: `line ${i + 1} is not a chained audit record` };
    }
    // The hash covers prev and event; anything else on the line would be unprotected.
    const extra = Object.keys(rec).filter((k) => k !== "prev" && k !== "hash" && k !== "event");
    if (extra.length > 0) return { ...at, reason: `line ${i + 1} has fields outside the chain (${extra.join(", ")})` };
    if (rec.prev !== prev) {
      return { ...at, reason: `line ${i + 1} does not follow the line before it: a line was removed, inserted or reordered` };
    }
    if ((await digest(rec.prev, rec.event, opts.key)) !== rec.hash) {
      return {
        ...at,
        reason: `line ${i + 1} was edited: its hash does not match its content${opts.key === undefined ? " (or the log was chained with a key, and none was given)" : " under this key (or the key is wrong)"}`,
      };
    }
    prev = rec.hash;
  }
  if (opts.head !== undefined && prev !== opts.head) {
    return { ok: false, count: lines.length, line: lines.length, reason: "the newest line does not match the anchored head: the log was cut short or has diverged" };
  }
  return { ok: true, count: lines.length, head: prev };
}
