import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { expandHome } from "./home-path.js";

/**
 * R4 (release review, 2026-09-18): the published MCP config passed
 * `~/.al-buddy-memory/brain.db` as an environment value, and nothing expanded
 * the `~`. A clean run created a literal `./~/.al-buddy-memory/brain.db` under
 * the client's working directory — verified against the published 0.4.1.
 */
describe("expandHome", () => {
  it("expands a leading ~ the way a shell would", () => {
    expect(expandHome("~/.al-buddy-memory/brain.db", "/home/chris")).toBe(join("/home/chris", ".al-buddy-memory/brain.db"));
    expect(expandHome("~", "/home/chris")).toBe("/home/chris");
    expect(expandHome("~/", "/home/chris")).toBe("/home/chris");
  });

  it("leaves everything else exactly as it was", () => {
    for (const path of ["/absolute/brain.db", "./relative/brain.db", "brain.db", ":memory:", "~other/brain.db", "a~b.db", ""]) {
      expect(expandHome(path, "/home/chris")).toBe(path);
    }
  });

  it("uses the real home directory when none is given", () => {
    expect(expandHome("~/x")).toBe(join(homedir(), "x"));
  });
});
