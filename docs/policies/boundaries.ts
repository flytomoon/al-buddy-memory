/**
 * An example "boundaries" policy: one company's read rules, mapped onto the
 * library's generic data boundaries. Nothing here is part of the API — the
 * API knows only labels (keys of a fact's `contextualMetadata`) and the asking
 * actor's attributes. "team", "client", "visibility", "rate" and "finance" are
 * this example company's words; use your own. See boundaries.md.
 */
import type { GovernancePolicy, NewMemoryNode, PolicyContext } from "al-buddy-memory";

/** The actor's values for one attribute, as a list. */
const values = (ctx: PolicyContext, name: string): readonly string[] => {
  const v = ctx.attributes?.[name];
  return v === undefined ? [] : typeof v === "string" ? [v] : v;
};

export const boundaries: GovernancePolicy = {
  name: "boundaries",

  // Who may see what, as data: the store applies this inside its query, before
  // any limit. A fact is visible when it is labelled for the whole company, or
  // when it belongs to one of the actor's teams AND one of the actor's clients.
  // Team-internal work carries client "internal", which every employee has.
  readBoundary: {
    any: [
      { label: "visibility", equals: "company" },
      {
        all: [
          { label: "team", in: { actor: "teams" } },
          { label: "client", in: { actor: "clients" } },
        ],
      },
    ],
  },

  // The per-fact hook still runs on what the boundary lets through, and has
  // the final word: billing rates are redacted for anyone outside finance.
  beforeRead(node, ctx) {
    if (!("rate" in node.contextualMetadata) || values(ctx, "roles").includes("finance")) return node;
    const { rate: _rate, ...rest } = node.contextualMetadata;
    return { ...node, contextualMetadata: rest };
  },

  // An unlabelled fact is visible to nobody (a boundary fails closed), so a
  // fact written without labels gets the writer's first team, as internal work.
  beforeWrite(node: NewMemoryNode, ctx): NewMemoryNode {
    const labels = node.contextualMetadata;
    if ("visibility" in labels || ("team" in labels && "client" in labels)) return node;
    const team = values(ctx, "teams")[0];
    if (team === undefined) return node;
    return { ...node, contextualMetadata: { team, client: "internal", ...labels } };
  },
};
