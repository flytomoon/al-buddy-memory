import { defineConfig } from "vitest/config";
// *.spec.ts here is the importable conformance suite, not a test file of its own.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 } });
