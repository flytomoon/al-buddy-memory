---
description: How much Al Buddy remembers, where the memory file is, when it last changed, and whether semantic search is on.
disable-model-invocation: true
allowed-tools:
  - Bash(npx -y --package=al-buddy-memory@0.10.0 al-buddy-memory status)
  - Bash(npx -y --package=al-buddy-memory@0.10.0 al-buddy-memory context --max-chars 200)
---

Run exactly:

```
npx -y --package=al-buddy-memory@0.10.0 al-buddy-memory status
```

Show its lines to the user as they are, in a code block, then add one plain sentence on what they mean (for example, why semantic search is off and what that changes: recall still works by keyword).

If it prints a usage message instead (packages before `status` existed), run `npx -y --package=al-buddy-memory@0.10.0 al-buddy-memory context --max-chars 200` and report its first line, which carries the count of current facts, and that the memory lives at `~/.al-buddy-memory/brain.db` unless `AL_BUDDY_MEMORY_DB` says otherwise.
