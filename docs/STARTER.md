# Seed your Al: start with a spine, not a blank

An empty memory gives an assistant nothing to stand on. Before the first conversation,
pin the facts that must be true in every prompt, and choose the rules the store enforces.
Ten minutes, once.

## 1. Pin who the person is and how they want to be treated

Pinned facts sit at the top of every prompt and the assistant may edit them as it learns
(`PinnedBlocks`). Keep them short and true. A starter set:

```ts
import { SqliteMemoryStore, PinnedBlocks } from "al-buddy-memory";

const store = new SqliteMemoryStore("brain.db");
const pins = new PinnedBlocks(store);

await pins.pin({ label: "who", text: "You are talking to Maya. Call her Maya. She works in short bursts and speaks by voice, so expect typos and half sentences; recover the intent, do not ask her to repeat." });
await pins.pin({ label: "how", text: "Never a yes-person. When you disagree, say so in the first line with the reason, then recommend; she decides. Do not flatter. If her premise is wrong, correct the premise first." });
await pins.pin({ label: "boundary", text: "Advise and anticipate freely. Act only inside what she has approved, and never on anything consequential (money, deletion, public posts, credentials) without her explicit yes." });
await pins.pin({ label: "you", text: "Your name is Al. Al has no gender: say Al, or they." });
```

Render them into the prompt with `await pins.render()`; recall covers everything else.

Seeding goes on the raw store on purpose: this is you, before any policy exists, writing the
spine by hand. Everything the *assistant* writes afterwards should go through the governed
handle in step 2 — including the derived facts in step 3.

## 2. Choose the rules the store enforces

Policies run in front of every write, read and export ([docs/GOVERNANCE.md](GOVERNANCE.md)). Start with one:

```ts
import { govern, personalDefaults, JsonlAudit } from "al-buddy-memory";

const governed = govern(store, {
  policies: [personalDefaults({ owner: "maya" })],   // secrets stay Sensitive; only Maya exports them
  context: () => ({ actor: currentActor() }),
  audit: new JsonlAudit("audit.jsonl"),
});
```

`guardianMode` protects a child's or a client's facts; `enterpriseAudit` hides low-confidence
inferences from non-reviewers and gates exports. Copy one and change the rule.

## 3. Let it learn, on a schedule

Raw turns are the truth; standing beliefs are derived from them. Run `consolidate()` nightly
over the day's raw memory with any model you like: it writes new facts marked as inferred,
with a confidence and an edge back to the raw sources, and never rewrites the raw text.

Hand it the **governed** handle from step 2, not the raw store. A derived fact is written
like any other, so on the raw store it skips the policy and the audit log that the rest of
your memory runs behind — and a derived fact restates what the raw turn said. Measured on
0.4.2: given a raw turn containing a password, a proposal repeating it is written
`Private` with nothing audited through the raw store, and `Sensitive` with eight audit
events through `governed`.

Sensitive facts are not shown to the model at all unless you pass `includeSensitive: true`,
and a fact derived from one is written Sensitive. Sealed facts are never shown. Since 0.5.1, then,
that password turn — classified Sensitive by the policy on `governed` — never reaches the model.

Since 0.6.0 each conclusion must quote the words it rests on: `evidence` holds at least one
exact passage from every source it cites, and a conclusion whose quotes are not in its sources is
refused as unsupported. Ask your model for the quotes alongside the fact:

```ts
import { consolidate } from "al-buddy-memory";

await consolidate(governed, {
  since: yesterday,
  model: "your-model",
  // Each proposal: { text, sourceNodeIds, evidence: [{ nodeId, quote }] }, quotes copied verbatim.
  propose: async (excerpts) => yourModel(excerpts),
});
```

Run `verifyDerived(governed)` whenever you import memory from elsewhere: it re-checks every
conclusion's quotes against its sources and retracts, never deletes, any that no longer hold.

Show the person what was learned about them once a week, in a sentence they can correct.
That is the whole loop: pin the spine, enforce the rules, derive the rest, keep everything.
