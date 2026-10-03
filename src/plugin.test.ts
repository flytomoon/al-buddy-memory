// The Claude Code plugin (plugin/) and its marketplace (.claude-plugin/): the
// rules a plugin directory submission checks that `claude plugin validate`
// does not, plus the one that bites on release — every pin naming one version.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PLUGIN_PIN_FILES } from "../scripts/release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "plugin");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const PIN = /al-buddy-memory@(\d+\.\d+\.\d+)\b/g;
const pinsIn = (text: string) => [...text.matchAll(PIN)].map((m) => m[1]!);
const first = (text: string, re: RegExp) => text.match(re)?.[1];

describe("the plugin's pins", () => {
  const manifest = json("plugin/.claude-plugin/plugin.json");
  const commands = readdirSync(join(pluginDir, "commands")).map((f) => read(`plugin/commands/${f}`));
  const pinned = [read("plugin/.mcp.json"), read("plugin/hooks/hooks.json"), read("plugin/README.md"), ...commands].flatMap(pinsIn);

  it("every launch and example names the same exact version, and plugin.json says it too", () => {
    expect(pinned.length).toBeGreaterThanOrEqual(4);
    expect(new Set(pinned)).toEqual(new Set([manifest["version"]]));
  });

  it("names the README's install version, the version the CHANGELOG is preparing, or the one being released", () => {
    const readmePin = first(read("README.md"), /--package=al-buddy-memory@(\d+\.\d+\.\d+)/);
    const preparing = first(read("CHANGELOG.md"), /^## (\d+\.\d+\.\d+) — unreleased\s*$/m);
    // The release commit dates the CHANGELOG heading and bumps package.json before npm serves the version.
    const releasing = (json("package.json") as { version: string }).version;
    expect([readmePin, preparing, releasing]).toContain(manifest["version"]);
  });

  it("every plugin file that names a version is one the release's pin step moves", () => {
    const withPins = filesUnder(pluginDir).filter((f) => pinsIn(readFileSync(f, "utf8")).length > 0).map((f) => relative(root, f));
    for (const f of withPins) expect(PLUGIN_PIN_FILES).toContain(f);
  });

  it("launches with npx exact pins only — never a range, a tag or latest", () => {
    const servers = json("plugin/.mcp.json")["mcpServers"] as Record<string, { command: string; args: string[] }>;
    for (const s of Object.values(servers)) {
      expect(s.command).toBe("npx");
      expect(s.args.join(" ")).toMatch(/--package=al-buddy-memory@\d+\.\d+\.\d+ /);
    }
  });
});

describe("the hook", () => {
  const hooks = json("plugin/hooks/hooks.json")["hooks"] as Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;

  it("is SessionStart only, bounded in time, and never installs (so it cannot race the server's first install)", () => {
    expect(Object.keys(hooks)).toEqual(["SessionStart"]);
    for (const h of hooks["SessionStart"]!.flatMap((g) => g.hooks)) {
      expect(h.type).toBe("command");
      expect(h.timeout).toBeLessThanOrEqual(30);
      expect(h.command).toMatch(/^npx --no --package=al-buddy-memory@\d+\.\d+\.\d+ al-buddy-memory context --hook/);
    }
  });

  it("uses no shell variable, substitution, glob or inline program (a directory submission blocks them)", () => {
    for (const h of hooks["SessionStart"]!.flatMap((g) => g.hooks)) expect(h.command).not.toMatch(/[$`*?|;&<>]|\s-c\s|\s-e\s/);
  });
});

describe("the plugin folder", () => {
  it("has a manifest the directory accepts: kebab-case name, description, author, license", () => {
    const m = json("plugin/.claude-plugin/plugin.json");
    expect(m["name"]).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(m["description"]).toBeTruthy();
    expect(m["author"]?.name).toBeTruthy();
    expect(m["license"]).toBe(json("package.json")["license"]);
  });

  it("has a README of at least 40 words outside code blocks", () => {
    const prose = read("plugin/README.md").replace(/```[\s\S]*?```/g, "");
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });

  it("holds only small text files: no binaries, no OS litter, nothing over 256 KiB", () => {
    for (const f of filesUnder(pluginDir)) {
      const rel = relative(pluginDir, f);
      expect(rel).not.toMatch(/(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini)$/);
      expect(rel).toMatch(/\.(json|md)$/);
      expect(statSync(f).size).toBeLessThan(256 * 1024);
    }
  });

  it("each skill has front matter with a name matching its folder and a one-line description", () => {
    const skills = readdirSync(join(pluginDir, "skills"));
    expect(skills.sort()).toEqual(["recall", "remember"]);
    for (const s of skills) {
      const fm = first(read(`plugin/skills/${s}/SKILL.md`), /^---\n([\s\S]*?)\n---\n/) ?? "";
      expect(first(fm, /^name: (.+)$/m)).toBe(s);
      expect(first(fm, /^description: (.+)$/m)?.length).toBeGreaterThan(40);
    }
  });
});

describe("the slash commands", () => {
  // Skills are commands too: /al-buddy:recall and /al-buddy:remember ARE the two
  // skills. A command file with a skill's name would be shadowed by the skill.
  const SKILLS = ["recall", "remember"];
  const COMMANDS = ["export", "forget", "help", "import", "status"];

  it("is the agreed set, namespaced under the plugin name al-buddy, with no name a skill already has", () => {
    expect(json("plugin/.claude-plugin/plugin.json")["name"]).toBe("al-buddy");
    const files = readdirSync(join(pluginDir, "commands")).sort();
    expect(files).toEqual(COMMANDS.map((c) => `${c}.md`));
    for (const c of COMMANDS) expect(SKILLS).not.toContain(c);
  });

  it("each has a description, and only the user starts them (they act on the whole memory)", () => {
    for (const c of COMMANDS) {
      const fm = first(read(`plugin/commands/${c}.md`), /^---\n([\s\S]*?)\n---\n/) ?? "";
      expect(first(fm, /^description: (.+)$/m)?.length).toBeGreaterThan(30);
      expect(fm).toMatch(/^disable-model-invocation: true$/m);
    }
  });

  it("the two skills take the user's words as arguments", () => {
    for (const s of SKILLS) expect(read(`plugin/skills/${s}/SKILL.md`)).toMatch(/^argument-hint: <\w+>$/m);
  });

  it("every command the help screen lists exists", () => {
    const help = read("plugin/commands/help.md");
    const listed = [...help.matchAll(/`\/al-buddy:(\w+)/g)].map((m) => m[1]!);
    expect(new Set(listed)).toEqual(new Set([...SKILLS, ...COMMANDS]));
  });
});

describe("the marketplace", () => {
  it("lists the plugin under its manifest name, from a folder that exists", () => {
    const market = json(".claude-plugin/marketplace.json");
    expect(market["name"]).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(market["owner"]?.name).toBeTruthy();
    const entry = (market["plugins"] as { name: string; source: string }[])[0]!;
    expect(entry.name).toBe(json("plugin/.claude-plugin/plugin.json")["name"]);
    expect(existsSync(join(root, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });
});
