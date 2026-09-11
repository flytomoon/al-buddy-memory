# Show HN draft

Post when the conformance CLI and the paste-your-export demo are live. One shot: the title states the mechanism, not the vision.

**Title (pick one, ≤ 80 chars):**
- Show HN: A provenance benchmark for AI memory – the popular memory layers scored on portability
- Show HN: Agent memory that never deletes a fact – provenance, validTo, one export format

**First comment (the author's, posted immediately):**

> I built this because every memory layer I tried could tell me what an agent recalled and none could tell me where a fact came from, when it stopped being true, or whether I could take the memory somewhere else. So the store never deletes: a fact that stops being true gets a `validTo` and stays; every node carries who asserted it; embeddings are a disposable cache; and everything exports to one documented JSON format with a schema.
>
> The conformance CLI in the repo scores any memory export on those three things. I ran it on the two most popular memory layers' exports and on my own; the table is in the README, and the demo page lets you paste an export and see the score. It is one dependency (SQLite), on-device embeddings, Apache-2.0.
>
> What I'd like to know: which of the three governance questions matters to you, and what would make you trust an agent's memory enough to move it between runtimes.

**Rules of the day:** reply to every comment for the first four hours; never argue with a benchmark objection, add it to the suite; if it does not reach the front page in four hours, it gets a second attempt on a different weekday, not a retreat.
