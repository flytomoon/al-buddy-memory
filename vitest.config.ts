import { defineConfig } from "vitest/config";
// *.spec.ts here is the importable conformance suite, not a test file of its own.
// bench/**/*.test.ts test the benchmark harness's pieces against the source; no benchmark runs.
export default defineConfig({ test: { include: ["src/**/*.test.ts", "bench/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 } });
