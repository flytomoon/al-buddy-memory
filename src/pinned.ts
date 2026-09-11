/**
 * Pinned blocks — a small, size-capped tier of facts that belong in EVERY
 * prompt, editable by the agent itself.
 *
 * Retrieval finds what a question resembles; it does not reliably surface the
 * standing rules ("Al has no gender", "never mention the hour") that matter
 * on every turn, and those are exactly the corrections a person ends up
 * repeating. Editable core-memory blocks are one answer: a pinned, agent-writable
 * tier; this is the same idea on top of the governed store: a pin is an
 * ordinary node (portable, provenance-carrying, invalidated never deleted)
 * with `contextualMetadata.pinned = true`.
 */
import type { MemoryNode, MemoryStore, NewMemoryNode } from "./types/memory.js";

export const PINNED_TAG = "pinned";
/** The whole pinned tier must fit in this many characters of prompt. */
export const DEFAULT_PINNED_BUDGET = 1_200;

export interface PinInput {
  text: string;
  /** Short label shown before the text, e.g. "identity", "tone". */
  label?: string;
  /** Who pinned it. Default "UserInput"; an agent pinning on its own says "AIInferred". */
  provenance?: MemoryNode["provenance"];
  privacyClassification?: MemoryNode["privacyClassification"];
  encryptionKeyRef?: string;
}

export interface PinnedBlock {
  nodeId: string;
  label: string | null;
  text: string;
  pinnedAt: string;
}

export class PinnedBlocks {
  constructor(
    private readonly store: MemoryStore,
    private readonly opts: { budgetChars?: number; now?: () => Date; encryptionKeyRef?: string } = {},
  ) {}

  /** Pin a fact. Pinning the same text twice reinforces the existing pin instead of duplicating it. */
  async pin(input: PinInput): Promise<PinnedBlock> {
    const text = input.text.trim();
    if (text === "") throw new Error("A pinned block needs text.");
    const existing = (await this.list()).find((b) => b.text === text);
    if (existing) {
      await this.store.updateNode(existing.nodeId, {}, "reinforced");
      return existing;
    }
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const node: NewMemoryNode = {
      provenance: input.provenance ?? "UserInput",
      encryptionKeyRef: input.encryptionKeyRef ?? this.opts.encryptionKeyRef ?? "local",
      memoryType: "Lesson",
      privacyClassification: input.privacyClassification ?? "Private",
      retentionTier: "FullRetention",
      content: { text },
      contextualMetadata: { [PINNED_TAG]: true, pinnedLabel: input.label ?? null, pinnedAt: now, tags: [PINNED_TAG] },
      confidenceWeight: 1,
      decayRate: 0,
      // Valid from the moment it was pinned — not from the store's clock — so
      // a validAt query at pin time already sees it.
      validFrom: now,
    };
    const saved = await this.store.addNode(node);
    return { nodeId: saved.nodeId, label: input.label ?? null, text, pinnedAt: now };
  }

  /** Unpin: the node stays (history), its valid-time closes, the flag clears. */
  async unpin(nodeId: string): Promise<boolean> {
    const node = await this.store.getNode(nodeId);
    if (!node || node.contextualMetadata[PINNED_TAG] !== true) return false;
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    await this.store.updateNode(nodeId, {
      validTo: now,
      contextualMetadata: { ...node.contextualMetadata, [PINNED_TAG]: false, unpinnedAt: now },
    });
    return true;
  }

  /** Every live pin, oldest first — the order they render in. */
  async list(): Promise<PinnedBlock[]> {
    const nodes = await this.store.searchNodes({ memoryType: "Lesson", validAt: (this.opts.now ?? (() => new Date()))().toISOString(), limit: 500 });
    return nodes
      .filter((n) => n.contextualMetadata[PINNED_TAG] === true)
      .map((n) => ({
        nodeId: n.nodeId,
        label: typeof n.contextualMetadata["pinnedLabel"] === "string" ? (n.contextualMetadata["pinnedLabel"] as string) : null,
        text: n.content.text,
        pinnedAt: typeof n.contextualMetadata["pinnedAt"] === "string" ? (n.contextualMetadata["pinnedAt"] as string) : n.validFrom,
      }))
      .sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt));
  }

  /**
   * The prompt block. Newest pins win the budget; what does not fit is named
   * so the agent knows the tier is full rather than silently losing a rule.
   */
  async render(): Promise<string> {
    const blocks = await this.list();
    if (blocks.length === 0) return "";
    const budget = this.opts.budgetChars ?? DEFAULT_PINNED_BUDGET;
    const lines: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const b of [...blocks].reverse()) {
      const line = `- ${b.label ? `[${b.label}] ` : ""}${b.text}`;
      if (used + line.length + 1 > budget) {
        dropped++;
        continue;
      }
      lines.unshift(line);
      used += line.length + 1;
    }
    const head = "PINNED (always true, edit with pin/unpin):";
    return [head, ...lines, ...(dropped ? [`(+${dropped} older pin${dropped === 1 ? "" : "s"} over the ${budget}-char budget — unpin something to make room)`] : [])].join("\n");
  }
}
