import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The docs are part of the product, and three of them said something the code
 * does not do (Fable 5.1 MCP-surface review, 2026-09-19). Links are covered by
 * `docs-links.test.ts`; this file covers claims — the small number of places
 * where a sentence is a promise a reader will check.
 */
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("docs — the claims a reader will check", () => {
  /**
   * STARTER.md built a governed handle in step 2 and then handed `consolidate`
   * the RAW store in step 3, so every derived fact bypassed policy and audit.
   * Measured on this code, 2026-09-19, with `personalDefaults({owner:"maya"})`
   * and a proposal restating a password out of a raw turn: through the raw
   * store the derived fact is written `Private` with 0 audit events; through the
   * governed handle it is written `Sensitive` with 8. The raw-store PINS in
   * step 1 are left alone — seeding the spine before any policy exists is a
   * deliberate operator action, and it is the same store either way.
   */
  it("STARTER.md consolidates through the governed handle, not the raw store", () => {
    const starter = read("docs/STARTER.md");
    const call = starter.match(/await consolidate\((\w+),/);
    expect(call?.[1]).toBe("governed");
    expect(starter).toMatch(/audit|policy|governed handle/i);
  });

  /**
   * The README blamed the brute-force scan for the semantic path's cost. The
   * scan is 85–127 ms at 100,000 facts; the cost is reading 8 KB text rows and
   * JSON-parsing them, 95–96% of the work. Which is why BLOB is the move and
   * `sqlite-vec` is not, at this size. Two runs are quoted as a range — the
   * reviewer's (1,182 / 1,418 / 85 / 4,170) and ours on 2026-09-19 (978 / 1,744
   * / 127 / 3,650) — because one laptop run is not a constant and a reader who
   * benchmarks us will get a third set.
   */
  it("the README's semantic-path section blames the read and the parse, not the scan", () => {
    const readme = read("README.md");
    // The 2026-09-19 stage timings stay as history: they are why float32 storage was the fix.
    for (const number of [/978–1,182 ms/, /1,418–1,744 ms/, /85–127 ms/]) {
      expect(readme).toMatch(number);
    }
    // Float32 storage shipped in 0.8.1; the README reports what was measured, not a projection of it.
    for (const number of [/1,536 bytes/, /277 MB/, /1,619 ms/]) expect(readme).toMatch(number);
    expect(readme).not.toMatch(/neither is built/);
    expect(readme).not.toMatch(/sqlite-vec.*is the obvious next move/);
  });

  /**
   * Restoring a SQLite file while the WAL still sits beside it replays the WAL
   * over the restore and silently undoes it; WAL mode across two machines on a
   * synced folder corrupts the file. Neither is our bug and both lose a
   * person's memory, so the limits section has to say so.
   */
  it("the README tells you how to restore a backup, and what never to sync", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/## .*Backups, restores and synced folders|### Backups, restores and synced folders/);
    expect(readme).toMatch(/-wal/);
    expect(readme).toMatch(/-shm/);
    for (const service of [/iCloud/, /Dropbox/, /OneDrive/, /Google Drive/]) expect(readme).toMatch(service);
  });
});
