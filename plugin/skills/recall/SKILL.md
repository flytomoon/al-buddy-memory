---
name: recall
description: Search the user's long-term memory before answering anything about past work, earlier decisions, preferences, people, or project history — "what did we decide", "how did I set this up", "do you remember", or any question whose answer may be in a previous session.
---

# Recall before you answer

The `memory` server's `recall` tool searches facts the user (or an assistant) stored in earlier sessions. Use it before answering from assumption whenever the question depends on what happened before this session.

1. Call `recall` with a few keywords: names, project terms, the subject of the decision. Not the whole question.
2. Read each result's fields before trusting it:
   - `current: false` means the fact was retired. Say what replaced it (`supersededBy`) instead of quoting the old value.
   - `provenance` says who asserted it. `UserInput` is the user's own words; `AIInferred` is an assistant's conclusion, so weigh it accordingly.
   - `validFrom` says since when it has been true. Mention the date when it matters.
3. When results conflict, prefer the current fact, and call `explain` or `history` with the fact's id if the user needs the reasoning.
4. If nothing relevant comes back, say that memory has nothing on it. Do not invent a past decision.

The first `recall` of a session also returns the user's pinned rules. Treat them as standing instructions for the conversation.
