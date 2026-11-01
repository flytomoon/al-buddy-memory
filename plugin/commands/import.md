---
description: Restore memory from a portable export file (from /al-buddy:export or another machine). Checks the whole file first; safe to run twice.
argument-hint: <file.json>
disable-model-invocation: true
---

Import the memory export at: $ARGUMENTS

1. If no file was given, ask for the path and stop.
2. Run:

   ```
   npx -y --package=al-buddy-memory@0.12.0 al-buddy-memory import <file>
   ```

3. Report its one-line result (facts and links imported, any skipped, and into which database). Facts this store already holds in a newer state are skipped and counted; identical ones are no-ops, so running it again changes nothing. If it refuses the file, show the reason; nothing was written.

Do not read or print the file's contents.
