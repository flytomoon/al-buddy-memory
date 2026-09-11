/**
 * The fields a fact can never change after it is written. Provenance is the
 * whole point: a fact that could be re-labelled "UserInput" after the fact is
 * a fact nobody can weigh. The store enforces this at runtime, not only in the
 * types, so a JavaScript caller gets the same refusal a TypeScript one does.
 */
export const IMMUTABLE_NODE_FIELDS = ["nodeId", "provenance", "encryptionKeyRef", "temporalAnchors"] as const;

export function assertPatchMutable(patch: object): void {
  for (const field of IMMUTABLE_NODE_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      throw new Error(`${field} is immutable: it is set when the fact is written and never changes (invalidate with validTo instead)`);
    }
  }
}
