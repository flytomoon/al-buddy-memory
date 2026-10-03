---
description: Retire a fact that is no longer true. It stops coming back in recall and stays in history with the date and reason.
argument-hint: <the fact to forget>
disable-model-invocation: true
---

The user wants this fact retired from long-term memory: $ARGUMENTS

1. Call the `memory` server's `recall` tool with a few keywords from it. Show the current matches as a short numbered list (text, and since when).
2. Unless exactly one match is plainly the fact meant, ask which to retire, and wait.
3. Call `invalidate` with that fact's `id` and a `reason` in the user's words (or "the user asked to forget it"). If they said what replaced it and that fact is stored, pass its id as `replacedBy`.
4. Answer in one line: what was retired, and that it is kept in history, not deleted. If nothing matched, say so and change nothing.

Never retire more than the user picked. To delete everything for good, point them to `/al-buddy:help`.
