/**
 * Erasure by label, with a receipt — a subject-erasure request (GDPR Art. 17
 * and its relatives) in the store's own terms. `eraseWhere(selector)` on a
 * governed handle finds every fact whose labels match, sends each one through
 * the same erase policies as `deleteNode` (a memory lock and Recently deleted
 * still win), erases what they allow together with everything concluded from
 * it, and returns a receipt whose digest is chained into the audit trail.
 *
 * This file holds the vocabulary: the selector, the receipt, how a receipt is
 * sealed and checked. The erasing itself lives in governed-store.ts, because it
 * must run through the handle's own queue, policies and audit.
 */
import { createHash } from "node:crypto";

import type { LabelFilter } from "../types/memory.js";
import { verifyAuditLogs, type AuditEvent, type AuditVerifiable, type AuditVisitor } from "./audit.js";
import { canonical } from "./chain.js";

/**
 * Which facts an erasure is about: the {@link ReadBoundary} language with
 * literal values only. `{ label, equals }`, `{ label, in }`, `{ all }`,
 * `{ any }` over the keys of `contextualMetadata`; a label may hold one string
 * or an array of them. There is no NOT and no "everything": a selector can
 * only reach facts by a label they carry.
 */
export type ErasureSelector =
  | { readonly label: string; readonly equals: string }
  | { readonly label: string; readonly in: readonly string[] }
  | { readonly all: readonly ErasureSelector[] }
  | { readonly any: readonly ErasureSelector[] };

export const RECEIPT_FORMAT = "al-buddy-memory/erasure-receipt@1";

/** How every id in a receipt is written. */
export const RECEIPT_ID_HASH = "sha256 hex of 'al-buddy-memory/fact-id' + newline + the fact's id";

/**
 * What a receipt does not reach. In the receipt itself, so it travels with it:
 * a receipt read on its own must not read as more than it is.
 */
export const RECEIPT_OUTSIDE: readonly string[] = [
  "Backups and copies of the database made before this erasure still hold these facts until they are deleted or expire; erase or expire them separately.",
  "Exports made before this erasure (al-buddy-memory export, exportPortable, anything a reader copied out) are outside it.",
  "Facts the erasing actor cannot see, or that carry the selector's labels only where a policy hides them from that actor, were not selected (a conclusion drawn from a selected fact went with it, as with any erasure, and is counted), and facts about the subject that do not carry the selector's labels were not matched.",
  "Storage the database has not reclaimed yet: SQLite free pages and WAL until compact() (VACUUM) and a checkpoint; Postgres dead rows until VACUUM.",
  "The audit trail keeps the events that name these facts' ids; it never held their content.",
];

/** A receipt for one `eraseWhere`. Every id is hashed ({@link erasedIdHash}); lists are sorted. */
export interface ErasureReceipt {
  readonly format: typeof RECEIPT_FORMAT;
  /** Random; each erasure event of this request names it in its `reason`. */
  readonly id: string;
  readonly selector: ErasureSelector;
  readonly actor: string;
  readonly audience?: string;
  /** When the request was made — the `at` of the audit event that attests to it. */
  readonly at: string;
  /** Facts carrying the labels that the actor can see. */
  readonly matched: number;
  /** Gone from the live store: `matched` of the selected facts, `concluded` from them. */
  readonly erased: { readonly count: number; readonly matched: number; readonly concluded: number; readonly ids: readonly string[] };
  /** Selected facts an erase policy refused, with its name and reason (ids in the reason are hashed too). */
  readonly refused: { readonly count: number; readonly facts: readonly { readonly id: string; readonly policy: string; readonly reason: string }[] };
  /** Allowed, but waiting in Recently deleted (with their conclusions); final after `finalAfter` and a purge. */
  readonly heldInRecentlyDeleted: { readonly count: number; readonly facts: readonly { readonly id: string; readonly finalAfter: string | null }[] };
  readonly idHash: typeof RECEIPT_ID_HASH;
  readonly outside: readonly string[];
  /** sha256 of the canonical JSON of every other field. The audit event carries it. */
  readonly digest: string;
}

/** How a receipt writes a fact id: anyone holding the id (a backup, a log) can check it; the receipt does not disclose it. */
export function erasedIdHash(nodeId: string): string {
  return createHash("sha256").update(`al-buddy-memory/fact-id\n${nodeId}`).digest("hex");
}

function digestOf(body: Omit<ErasureReceipt, "digest">): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

/** Compute and set the digest. Exported for tests and for anyone re-deriving a receipt. */
export function sealReceipt(body: Omit<ErasureReceipt, "digest"> & { digest?: unknown }): ErasureReceipt {
  const { digest: _ignored, ...rest } = body;
  const plain = JSON.parse(JSON.stringify(rest)) as Omit<ErasureReceipt, "digest">;
  return { ...plain, digest: digestOf(plain) };
}

/**
 * Refuse a selector that is malformed, names an actor attribute (a receipt
 * records what was asked for, not what it resolved to), or would match every
 * fact (`{ all: [] }`): before anything is read, let alone erased.
 */
export function assertErasureSelector(selector: unknown, path = "selector"): asserts selector is ErasureSelector {
  const fail = (why: string): never => {
    throw new Error(`eraseWhere: ${path} ${why}`);
  };
  if (typeof selector !== "object" || selector === null || Array.isArray(selector)) fail("must be an object");
  const s = selector as Record<string, unknown>;
  const keys = Object.keys(s).sort().join(",");
  if (keys === "all" || keys === "any") {
    const list = s[keys];
    if (!Array.isArray(list)) fail(`.${keys} must be an array`);
    if ((list as unknown[]).length === 0) fail(`.${keys} must hold at least one condition`);
    (list as unknown[]).forEach((inner, i) => assertErasureSelector(inner, `${path}.${keys}[${i}]`));
    return;
  }
  if (keys !== "equals,label" && keys !== "in,label") fail("must be { label, equals }, { label, in }, { all } or { any }");
  if (typeof s["label"] !== "string" || s["label"] === "") fail(".label must be a non-empty string");
  if ("equals" in s && typeof s["equals"] !== "string") fail(".equals must be a string (an erasure names its subject literally)");
  if ("in" in s && !(Array.isArray(s["in"]) && s["in"].every((v) => typeof v === "string"))) fail(".in must be an array of strings (an erasure names its subject literally)");
}

/** The selector as the filter every store compiles. */
export function selectorFilter(selector: ErasureSelector): LabelFilter {
  if ("all" in selector) return { all: selector.all.map(selectorFilter) };
  if ("any" in selector) return { any: selector.any.map(selectorFilter) };
  return { label: selector.label, in: "equals" in selector ? [selector.equals] : [...selector.in] };
}

/** The governed handle's extra method. Present on every `govern()` handle; an export view refuses it. */
export interface SubjectErasureCapable {
  /**
   * Erase every fact this actor can see whose labels match `selector`, each
   * through the erase policies, with everything concluded from it; return the
   * receipt, whose digest is recorded in the audit trail. Needs an audit sink.
   */
  eraseWhere(selector: ErasureSelector): Promise<ErasureReceipt>;
}

export function isSubjectErasureCapable(store: unknown): store is SubjectErasureCapable {
  return typeof store === "object" && store !== null && typeof (store as Partial<SubjectErasureCapable>).eraseWhere === "function";
}

/** The audit event that attests to a receipt. */
export function receiptEvent(receipt: ErasureReceipt, purpose: AuditEvent["purpose"] = "erase"): AuditEvent {
  return {
    at: receipt.at,
    actor: receipt.actor,
    audience: receipt.audience,
    purpose,
    outcome: "allowed",
    nodeIds: [],
    count: receipt.erased.count,
    reason: `erasure receipt ${receipt.id}: ${receipt.matched} matched, ${receipt.erased.count} erased, ${receipt.refused.count} refused, ${receipt.heldInRecentlyDeleted.count} held in Recently deleted`,
    receipt: receipt.digest,
  };
}

export type ReceiptCheck =
  | { ok: true; event: { position: number; file?: string } }
  | { ok: false; reason: string };

/**
 * Check a receipt: its digest matches its content, the trail verifies, and
 * exactly one event in it carries that digest for the same actor, time and
 * count. `trail` is what `verify-audit` takes (a database file, a JSONL log or
 * a directory of them; `key` is its HMAC key) or an open store that checks its
 * own chain with its own key (`SqliteMemoryStore`, `PostgresMemoryStore`).
 *
 * What a pass establishes is what the chain establishes: the receipt was
 * recorded in this trail and neither has been edited since — tamper-evident,
 * not tamper-proof; anchor the trail's head elsewhere for more.
 */
export async function verifyErasureReceipt(receipt: unknown, trail: string | AuditVerifiable, opts: { key?: string; head?: string } = {}): Promise<ReceiptCheck> {
  if (typeof receipt !== "object" || receipt === null || (receipt as { format?: unknown }).format !== RECEIPT_FORMAT) {
    return { ok: false, reason: `not an erasure receipt (format ${RECEIPT_FORMAT})` };
  }
  const r = receipt as ErasureReceipt;
  const { digest, ...body } = r;
  if (typeof digest !== "string" || digestOf(body) !== digest) return { ok: false, reason: "the receipt was edited: its digest does not match its content" };

  const found: { position: number; file?: string; event: AuditEvent }[] = [];
  const visit: AuditVisitor = (event, position, file) => {
    if (event.receipt === digest) found.push(file === undefined ? { position, event } : { position, file, event });
  };
  let verified: { ok: boolean; reason?: string };
  if (typeof trail === "string") {
    const checked = await verifyAuditLogs(trail, { ...opts, visit });
    const broken = checked.logs.find((l) => !l.result.ok);
    verified = checked.ok ? { ok: true } : { ok: false, reason: checked.reason ?? (broken && !broken.result.ok ? `${broken.file}: ${broken.result.reason}` : "the trail does not verify") };
  } else {
    // An open store checks with the key it was opened with; `key` is for a trail read from a file.
    const result = await trail.verifyAudit(opts.head === undefined ? { visit } : { head: opts.head, visit });
    verified = result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  if (!verified.ok) return { ok: false, reason: `the audit trail does not verify: ${verified.reason}` };
  if (found.length === 0) return { ok: false, reason: "no event in this trail carries this receipt's digest" };
  if (found.length > 1) return { ok: false, reason: `${found.length} events carry this receipt's digest; a receipt is recorded once` };
  const [{ event, ...where }] = found as [(typeof found)[number]];
  if (event.at !== r.at || event.actor !== r.actor || event.count !== r.erased.count || event.purpose !== "erase") {
    return { ok: false, reason: "the event carrying this digest does not match the receipt's actor, time or count" };
  }
  return { ok: true, event: where };
}
