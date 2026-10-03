// The Claude Desktop extension (mcpb/, built by scripts/build-mcpb.mjs): the
// promises the page makes about it, checked against the manifest and launcher.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const launcher = readFileSync(join(root, "mcpb", "server", "index.js"), "utf8");

describe("the Claude Desktop extension", () => {
  it("is named for people, runs the bundled server on Node, and claims only the platform it carries binaries for", () => {
    expect(manifest.display_name).toBe("Al Buddy Memory");
    expect(manifest.server).toMatchObject({ type: "node", entry_point: "server/index.js" });
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
    expect(manifest.compatibility.platforms).toEqual(["darwin"]);
    // No runtimes.node: Claude Desktop then uses its built-in Node, the ABI the bundle is compiled for.
    expect(manifest.compatibility.runtimes).toBeUndefined();
    expect(manifest.icon).toBe("icon.png");
  });

  it("shares Claude Code's memory file by default", () => {
    expect(manifest.user_config.db_path.default).toBe("${HOME}/.al-buddy-memory/brain.db");
    expect(manifest.server.mcp_config.env.AL_BUDDY_MEMORY_DB).toBe("${user_config.db_path}");
  });

  it("an emptied setting falls back to the default file, never an unnamed database", () => {
    expect(launcher).toMatch(/if \(db === "" \|\| db\.includes\("\$\{"\)\) delete process\.env\.AL_BUDDY_MEMORY_DB;/);
  });

  it("lists every tool the server has", async () => {
    const { TOOL_ANNOTATIONS } = await import("./mcp/governance-server.js");
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
  });
});
