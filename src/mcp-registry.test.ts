// server.json is the MCP Registry's entry for this package. The registry checks
// it against npm at publish time — the named version must be on npm with a
// matching `mcpName` — so everything it can be checked against here, it is.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — a plain .mjs script with no type declarations
import { setVersion } from "../scripts/release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const serverText = read("server.json");
const server = JSON.parse(serverText);
const [npmEntry] = server.packages;

describe("the MCP Registry entry", () => {
  it("names this package by the GitHub namespace the publisher logs in to", () => {
    expect(pkg.mcpName).toBe("io.github.flytomoon/al-buddy-memory");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.repository.url).toBe(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  });

  it("is this version, and points at this version on npm", () => {
    expect(server.packages).toHaveLength(1);
    expect(server.version).toBe(pkg.version);
    expect(npmEntry).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
  });

  it("keeps the description inside the registry's 100 characters", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("starts the MCP server, not the default bin: `npx al-buddy-memory mcp`", () => {
    // npx runs the bin named like the package, which is the CLI; the CLI's `mcp` hands over to the server's bin.
    expect(pkg.bin[pkg.name]).toBe("bin/al-buddy-memory.js");
    expect(npmEntry.packageArguments).toEqual([expect.objectContaining({ type: "positional", value: "mcp" })]);
    const cli = read("bin/al-buddy-memory.js");
    expect(cli).toMatch(/if \(cmd === "mcp"\) \{\n\s*await import\("\.\/al-buddy-memory-mcp\.js"\);/);
    expect(pkg.bin["al-buddy-memory-mcp"]).toBe("bin/al-buddy-memory-mcp.js");
  });

  it("lists exactly the environment variables the server reads, and marks the key secret", () => {
    const used = [...read("bin/al-buddy-memory-mcp.js").matchAll(/process\.env\.(AL_BUDDY_MEMORY_\w+)/g)].map((m) => m[1]);
    const listed = npmEntry.environmentVariables.map((v: { name: string }) => v.name);
    expect([...new Set(listed)].sort()).toEqual([...new Set(used)].sort());
    expect(listed).toHaveLength(new Set(listed).size);
    for (const v of npmEntry.environmentVariables) expect(v.isSecret === true).toBe(v.name === "AL_BUDDY_MEMORY_AUDIT_KEY");
  });

  it("moves to the next version with the release, both fields and nothing else", () => {
    const next = setVersion(serverText, pkg.version, "99.0.0", 2);
    const bumped = JSON.parse(next);
    expect(bumped.version).toBe("99.0.0");
    expect(bumped.packages[0].version).toBe("99.0.0");
    expect(next.replace(/99\.0\.0/g, pkg.version)).toBe(serverText);
  });
});
