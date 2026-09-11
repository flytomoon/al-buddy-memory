/**
 * The provenance-and-portability conformance score.
 *
 * Recall benchmarks are saturated; nobody scores whether a memory system can
 * say WHO asserted a fact, SINCE WHEN, whether it is STILL TRUE, and whether
 * the fact survives leaving the vendor. This does. Each dimension is 0..1 with
 * the reason spelled out, so a score is an argument, not a verdict.
 *
 * A dimension the sample cannot prove (e.g. retention, with no retired facts
 * present) scores null and is left out of the total rather than counted as a
 * failure — the report says "unproven", which is the honest word.
 */
import type { ConformanceInput } from "./model.js";

export interface Dimension {
  key: "provenance" | "temporal" | "invalidation" | "retention" | "confidence" | "relationships" | "portability";
  title: string;
  /** 0..1, or null when the sample cannot prove it either way. */
  score: number | null;
  reason: string;
}

export interface ConformanceReport {
  system: string;
  format: ConformanceInput["format"];
  facts: number;
  edges: number;
  dimensions: Dimension[];
  /** Mean of the provable dimensions, 0..1. */
  total: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

const PROVENANCE_WEIGHTED_TOTAL_EPSILON = 1e-9;

function ratio(n: number, of: number): number {
  return of === 0 ? 0 : n / of;
}

function pct(n: number, of: number): string {
  return `${n}/${of}`;
}

export function grade(total: number): ConformanceReport["grade"] {
  if (total >= 0.9 - PROVENANCE_WEIGHTED_TOTAL_EPSILON) return "A";
  if (total >= 0.75) return "B";
  if (total >= 0.5) return "C";
  if (total >= 0.25) return "D";
  return "F";
}

export function scoreConformance(input: ConformanceInput): ConformanceReport {
  const { facts, edges, traits } = input;
  const n = facts.length;
  const dims: Dimension[] = [];

  const withProv = facts.filter((f) => f.provenance !== null && f.provenance !== "").length;
  dims.push({
    key: "provenance",
    title: "Every fact says who asserted it",
    score: n === 0 ? null : ratio(withProv, n),
    reason: n === 0 ? "no facts in the sample" : `${pct(withProv, n)} facts carry a provenance label`,
  });

  const withFrom = facts.filter((f) => f.validFrom !== null).length;
  dims.push({
    key: "temporal",
    title: "Every fact says since when it is true",
    score: n === 0 ? null : ratio(withFrom, n),
    reason: n === 0 ? "no facts in the sample" : `${pct(withFrom, n)} facts carry a validFrom (or creation) time`,
  });

  const invalidationScore: Record<typeof traits.invalidation, number | null> = {
    kept: 1,
    "expiry-only": 0.5,
    overwritten: 0,
    deleted: 0,
    unknown: null,
  };
  const invalidationReason: Record<typeof traits.invalidation, string> = {
    kept: "a fact can be closed (validTo) and the record is kept",
    "expiry-only": "facts can expire on a date, but a fact that stops being true is deleted or rewritten, not closed with history",
    overwritten: "facts are rewritten in place; the old value is gone",
    deleted: "the only way to retire a fact is to delete it",
    unknown: "the sample does not show how a fact is retired",
  };
  dims.push({ key: "invalidation", title: "A fact can stop being true without being erased", score: invalidationScore[traits.invalidation], reason: invalidationReason[traits.invalidation] });

  const retired = facts.filter((f) => f.validTo !== null);
  const retiredWithSuccessor = retired.filter((f) => f.supersededBy !== null).length;
  dims.push({
    key: "retention",
    title: "Superseded facts are still there, and say what replaced them",
    score: retired.length === 0 ? null : 0.5 + 0.5 * ratio(retiredWithSuccessor, retired.length),
    reason: retired.length === 0 ? "no retired facts in the sample — unproven" : `${retired.length} retired facts retained; ${pct(retiredWithSuccessor, retired.length)} name their successor`,
  });

  const withConf = facts.filter((f) => typeof f.confidence === "number").length;
  dims.push({
    key: "confidence",
    title: "Every fact says how sure the system is",
    score: n === 0 ? null : ratio(withConf, n),
    reason: n === 0 ? "no facts in the sample" : `${pct(withConf, n)} facts carry a confidence in [0,1]`,
  });

  const edgesWithProv = edges.filter((e) => e.provenance !== null).length;
  dims.push({
    key: "relationships",
    title: "Facts relate to each other, and the relations have provenance too",
    score: edges.length === 0 ? (n > 1 ? 0 : null) : ratio(edgesWithProv, edges.length),
    reason: edges.length === 0 ? (n > 1 ? "no relationships between facts in the sample" : "too few facts to relate") : `${pct(edgesWithProv, edges.length)} relationships carry provenance`,
  });

  const portability = (traits.schema.published ? 0.34 : 0) + (traits.roundTrip === "lossless" ? 0.33 : traits.roundTrip === "lossy" ? 0.1 : 0) + (traits.itemised ? 0.33 : 0);
  dims.push({
    key: "portability",
    title: "The export leaves the vendor intact",
    score: Math.min(1, Math.round(portability * 100) / 100),
    reason: [
      traits.schema.published ? `published schema${traits.schema.url ? ` (${traits.schema.url})` : ""}` : "no published schema",
      traits.roundTrip === "lossless" ? "lossless round-trip" : traits.roundTrip === "lossy" ? "lossy round-trip" : "round-trip unproven",
      traits.itemised ? "one record per fact" : "facts live inside free-text blobs",
    ].join("; "),
  });

  const provable = dims.filter((d) => d.score !== null) as Array<Dimension & { score: number }>;
  const total = provable.length === 0 ? 0 : provable.reduce((s, d) => s + d.score, 0) / provable.length;
  const rounded = Math.round(total * 1000) / 1000;
  return { system: input.system, format: input.format, facts: n, edges: edges.length, dimensions: dims, total: rounded, grade: grade(rounded) };
}

/** A plain-text report: one line per dimension, then the grade. */
export function formatReport(r: ConformanceReport): string {
  const lines = [`${r.system} (${r.format}) — ${r.facts} facts, ${r.edges} relationships`, ""];
  for (const d of r.dimensions) {
    const s = d.score === null ? "  —  " : `${String(Math.round(d.score * 100)).padStart(3)}% `;
    lines.push(`${s} ${d.title}`);
    lines.push(`       ${d.reason}`);
  }
  lines.push("", `Grade ${r.grade}  (${Math.round(r.total * 100)}% across ${r.dimensions.filter((d) => d.score !== null).length} provable dimensions)`);
  return lines.join("\n");
}
