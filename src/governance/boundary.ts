/**
 * Data boundaries: a policy's read rule declared as data, so the store can apply
 * it inside the query instead of after it. A {@link ReadBoundary} names the
 * asking actor's attributes; resolving it against one actor's context gives a
 * {@link LabelFilter} of plain strings, which every store compiles.
 */
import type { LabelFilter } from "../types/memory.js";
import type { GovernancePolicy, PolicyContext, ReadBoundary } from "./policy.js";

/** The actor's values for one attribute; none when the actor does not have it. */
function attribute(ctx: PolicyContext, name: string): readonly string[] {
  const value = ctx.attributes?.[name];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value.filter((v): v is string => typeof v === "string");
}

function resolve(boundary: ReadBoundary, ctx: PolicyContext): LabelFilter {
  if ("all" in boundary) return { all: boundary.all.map((b) => resolve(b, ctx)) };
  if ("any" in boundary) return { any: boundary.any.map((b) => resolve(b, ctx)) };
  const wanted = "equals" in boundary ? boundary.equals : boundary.in;
  const values = typeof wanted === "string" ? [wanted] : "actor" in wanted ? attribute(ctx, wanted.actor) : wanted;
  return { label: boundary.label, in: [...values] };
}

/** Every policy's boundary for this actor, ANDed; undefined when no policy declares one. */
export function boundaryFor(policies: readonly GovernancePolicy[], ctx: PolicyContext): LabelFilter | undefined {
  const declared = policies.filter((p) => p.readBoundary !== undefined).map((p) => resolve(p.readBoundary!, ctx));
  return declared.length === 0 ? undefined : declared.length === 1 ? declared[0] : { all: declared };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isActorAttribute = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && isString((v as { actor?: unknown }).actor) && (v as { actor: string }).actor !== "";

/**
 * Refuse a malformed declaration when the governed handle is made. A typo that
 * parsed as "no rule" would show everything; one that parsed as "match nothing"
 * would hide it all without saying why.
 */
export function assertReadBoundary(boundary: unknown, policy: string, path = "readBoundary"): void {
  const fail = (why: string): never => {
    throw new Error(`policy ${policy}: ${path} ${why}`);
  };
  if (typeof boundary !== "object" || boundary === null || Array.isArray(boundary)) fail("must be an object");
  const b = boundary as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (keys === "all" || keys === "any") {
    const list = b[keys];
    if (!Array.isArray(list)) fail(`.${keys} must be an array`);
    (list as unknown[]).forEach((inner, i) => assertReadBoundary(inner, policy, `${path}.${keys}[${i}]`));
    return;
  }
  if (keys !== "equals,label" && keys !== "in,label") fail("must be { label, equals }, { label, in }, { all } or { any }");
  if (!isString(b["label"]) || b["label"] === "") fail(".label must be a non-empty string");
  if ("equals" in b && !isString(b["equals"]) && !isActorAttribute(b["equals"])) fail(".equals must be a string or { actor: name }");
  if ("in" in b && !(Array.isArray(b["in"]) && b["in"].every(isString)) && !isActorAttribute(b["in"])) fail(".in must be an array of strings or { actor: name }");
}
