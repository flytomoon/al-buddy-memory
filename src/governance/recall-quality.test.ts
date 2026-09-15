import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryStore, NewMemoryNode } from "../types/memory.js";
import { govern } from "./governed-store.js";
import { personalDefaults } from "./samples.js";

/**
 * Fable's last review, 2026-09-15: the fix that stopped hidden facts reordering
 * visible results ranked by length-normalised term frequency with no weight for
 * how rare a word is — so for a question an agent actually asks ("what is the
 * wifi login"), facts dense in "the / is / my" outranked the one that says
 * "wifi". Targets fell to ranks 31, 95 and 34 on a personal-memory-sized corpus.
 * This is that corpus: 200 facts built from common words, 12 facts worth
 * finding, each asked for the way a person would ask.
 */
const fact = (text: string): NewMemoryNode => ({
  provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience", privacyClassification: "Private",
  retentionTier: "FullRetention", content: { text }, contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
});
const SUBJECTS = ["the dog", "my sister", "the landlord", "the car", "the office", "the bank", "the garden", "my phone", "the kids' school", "the gym", "the dentist", "the neighbour", "the printer", "the boat", "my manager", "the book club", "the wedding", "the flight", "the router", "the accountant"];
const PREDICATES = ["is the reason the week is busy", "is where the time goes on Tuesdays", "was the thing we talked about at dinner", "needs a decision before the end of the month", "is the one that keeps coming up in the morning", "was fine in the end, which is a relief", "is the part of the plan that is still open", "is what the note on the fridge is about", "is the thing that the meeting is for", "was the highlight of the weekend"];
const TARGETS: [string, string][] = [
  ["wifi login is hunter2, written on the fridge", "what is the wifi login"],
  ["Chris moved to Tokyo in March 2020", "when did I move to Tokyo"],
  ["the bank login lives in 1Password under Chase", "where is the bank login"],
  ["Biscuit the dog is allergic to chicken", "what is the dog allergic to"],
  ["the dentist appointment is on the 3rd at 9", "when is the dentist appointment"],
  ["sister's birthday is 14 June", "when is my sister's birthday"],
  ["the accountant said file the extension by October", "what did the accountant say about the extension"],
  ["the router password was reset in May", "when was the router password reset"],
  ["the flight to Lisbon is on the 22nd, seat 14A", "what seat is the flight to Lisbon"],
  ["the landlord agreed to fix the boiler", "did the landlord agree to fix the boiler"],
  ["the printer needs a magenta cartridge", "what does the printer need"],
  ["the book club is reading Piranesi this month", "what is the book club reading"],
];

describe("governed keyword recall finds what a person asks for", () => {
  for (const [label, make] of [
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
    ["InMemoryStore", () => new InMemoryStore()],
  ] as const) {
    it(`${label}: every target is on the MCP server's default page of 8, most of them first`, async () => {
      const inner: MemoryStore = make();
      const store = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });
      for (const s of SUBJECTS) for (const p of PREDICATES) await inner.addNode(fact(`${s} ${p}`));
      const ids = new Map<string, string>();
      for (const [text] of TARGETS) ids.set(text, (await inner.addNode(fact(text))).nodeId);

      let reciprocal = 0;
      for (const [text, question] of TARGETS) {
        const page = (await store.searchNodes({ query: question, limit: 8 })).map((n) => n.nodeId);
        const rank = page.indexOf(ids.get(text)!) + 1;
        expect(rank, `"${question}" should find "${text}"`).toBeGreaterThan(0);
        reciprocal += 1 / rank;
      }
      expect(reciprocal / TARGETS.length).toBeGreaterThan(0.85); // mean reciprocal rank
      (inner as { close?: () => void }).close?.();
    });
  }
});
