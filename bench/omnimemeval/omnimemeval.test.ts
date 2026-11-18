import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as lib from "../../src/index.js";
import { BOARD_ORDER, boardSpec, expectedCost } from "./boards.mjs";
import { COPIES, PATCHES, checkedOutCommit, patchText, prepareHarness } from "./harness.mjs";
import { PRICES, SpendLedger, chatRoute, costUsd, priceOf, promptBytes, serveMeter, stubContent, worstCaseUsd } from "./meter.mjs";
import { ANSWER_MODEL, EVAL_MODEL, OMNIMEMEVAL } from "./pin.mjs";
import { MAX_USD_CEILING, boardCommand, boardEnv, meterView, readBoardResult, readEnvFile, takeLock } from "./run.mjs";
import { createSidecar, dateLabel, memoryLine, parseBenchDate, serveSidecar, sidecarRoute, userFileStem } from "./server.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "omnimemeval-"));

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe("dates and lines", () => {
  it("reads ISO and LongMemEval dates as UTC, and nothing else", () => {
    expect(parseBenchDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(parseBenchDate("2023/05/20")).toBe("2023-05-20T00:00:00.000Z");
    expect(parseBenchDate("2023-05-08T13:56:00+00:00")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseBenchDate("2023-05-08T13:56:00")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseBenchDate("2023-05-08 13:56")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseBenchDate("2023/02/30 (Thu) 10:00")).toBeNull();
    expect(parseBenchDate("someday")).toBeNull();
    expect(parseBenchDate("")).toBeNull();
    expect(parseBenchDate(undefined)).toBeNull();
  });

  it("leads each memory with its date and its speaker, once", () => {
    expect(dateLabel("2023-05-08T13:56:00.000Z")).toBe("2023-05-08 13:56");
    expect(memoryLine({ text: "Ana: I adopted a puppy.", role: "user", name: "Ana", at: "2023-05-08T13:56:00.000Z" })).toBe("[2023-05-08 13:56] Ana: I adopted a puppy.");
    expect(memoryLine({ text: "Sure, here is a plan.", role: "assistant", at: "2023-05-08T13:56:00.000Z" })).toBe("[2023-05-08 13:56] assistant: Sure, here is a plan.");
    expect(memoryLine({ text: "no date", role: "user", at: null })).toBe("user: no date");
  });

  it("gives every user its own file name, safe for any id", () => {
    expect(userFileStem("a/../b")).toMatch(/^[0-9a-f]{32}$/);
    expect(userFileStem("a")).not.toBe(userFileStem("b"));
  });
});

describe("sidecar", () => {
  it("stores each message as said, recalls best first with dates, and keeps users apart", async () => {
    const stateDir = tmp();
    // A bag-of-letters vector: enough for the vector list to take part.
    const embedder = new lib.FakeEmbedder("letters", 26, (t: string) => Array.from({ length: 26 }, (_, i) => t.toLowerCase().split(String.fromCharCode(97 + i)).length - 1));
    const sidecar = createSidecar(lib, { stateDir, embedder });
    try {
      const added = await sidecar.add({
        user_id: "conv-1",
        messages: [
          { role: "user", name: "Ana", content: "Ana: I adopted a puppy named Biscuit.", chat_time: "2023-05-08T13:56:00+00:00" },
          { role: "assistant", name: "Ben", content: "Ben: I ran a charity race last Saturday.", chat_time: "2023-05-08T13:56:00+00:00" },
          { role: "user", content: "   " },
          { role: "user", content: "a message with no date" },
        ],
      });
      expect(added).toEqual({ added: 3, skippedEmpty: 1, undated: 1 });
      await sidecar.add({ user_id: "conv-2", messages: [{ role: "user", content: "Biscuit is a cat here.", chat_time: "2024-01-01T00:00:00Z" }] });
      const r = await sidecar.search({ user_id: "conv-1", query: "What is the name of the puppy Biscuit?", top_k: 2 });
      expect(r.memories).toHaveLength(2);
      expect(r.memories[0]).toBe("[2023-05-08 13:56] Ana: I adopted a puppy named Biscuit.");
      expect(r.memories.join("\n")).not.toContain("cat");
      expect(r.now).toBe("2023-05-08T13:56:00.000Z");
      const dated = await sidecar.search({ user_id: "conv-1", query: "puppy", top_k: 1, question_date: "2023/06/01 (Thu) 10:00" });
      expect(dated.now).toBe("2023-06-01T10:00:00.000Z");
      expect(sidecar.stats()).toMatchObject({ adds: 2, messagesStored: 4, emptySkipped: 1, undated: 1, searches: 2 });
    } finally {
      await sidecar.close();
    }
  });

  it("keeps a user's memory across a restart, and deletes one user only", async () => {
    const stateDir = tmp();
    const first = createSidecar(lib, { stateDir });
    await first.add({ user_id: "u1", messages: [{ role: "user", content: "the red kite", chat_time: "2023-01-02T00:00:00Z" }] });
    await first.add({ user_id: "u2", messages: [{ role: "user", content: "the blue kite" }] });
    await first.close();
    const second = createSidecar(lib, { stateDir });
    try {
      expect((await second.search({ user_id: "u1", query: "kite", top_k: 5 })).memories).toEqual(["[2023-01-02 00:00] user: the red kite"]);
      expect(await second.remove({ user_id: "u1" })).toEqual({ deleted: true });
      expect(await second.remove({ user_id: "u1" })).toEqual({ deleted: false });
      await expect(second.search({ user_id: "u1", query: "kite", top_k: 5 })).rejects.toMatchObject({ status: 404 });
      expect((await second.search({ user_id: "u2", query: "kite", top_k: 5 })).memories).toEqual(["user: the blue kite"]);
    } finally {
      await second.close();
    }
  });

  it("refuses bad requests with a reason, never an empty result", async () => {
    const sidecar = createSidecar(lib, { stateDir: tmp() });
    try {
      await expect(sidecar.add({ user_id: "", messages: [] })).rejects.toMatchObject({ status: 400 });
      await expect(sidecar.add({ user_id: "u", messages: "x" })).rejects.toMatchObject({ status: 400 });
      await expect(sidecar.add({ user_id: "u", messages: [{ role: "user" }] })).rejects.toMatchObject({ status: 400 });
      await sidecar.add({ user_id: "u", messages: [{ role: "user", content: "x" }] });
      await expect(sidecar.search({ user_id: "u", query: " ", top_k: 5 })).rejects.toMatchObject({ status: 400 });
      await expect(sidecar.search({ user_id: "u", query: "x", top_k: 0 })).rejects.toMatchObject({ status: 400 });
    } finally {
      await sidecar.close();
    }
  });

  it("runs one user's operations in arrival order, and closes idle stores past the limit", async () => {
    const sidecar = createSidecar(lib, { stateDir: tmp(), maxOpen: 2 });
    try {
      const writes = [1, 2, 3].map((i) => sidecar.add({ user_id: "u", messages: [{ role: "user", content: `note ${i}`, chat_time: `2023-01-0${i}T00:00:00Z` }] }));
      const read = sidecar.search({ user_id: "u", query: "note", top_k: 10 });
      await Promise.all(writes);
      expect((await read).memories).toHaveLength(3);
      for (const id of ["a", "b", "c", "d"]) await sidecar.add({ user_id: id, messages: [{ role: "user", content: `memo for ${id}` }] });
      expect(sidecar.stats().openStores).toBeLessThanOrEqual(2);
      expect((await sidecar.search({ user_id: "a", query: "memo", top_k: 5 })).memories).toEqual(["user: memo for a"]);
    } finally {
      await sidecar.close();
    }
  });

  it("serves each board its own stores over HTTP", async () => {
    const root = tmp();
    const served = await serveSidecar((board: string) => createSidecar(lib, { stateDir: join(root, board) }));
    try {
      expect((await post(`${served.url}/b/locomo/add`, { user_id: "u", messages: [{ role: "user", content: "hello locomo" }] })).status).toBe(200);
      expect((await post(`${served.url}/b/halumem/search`, { user_id: "u", query: "hello", top_k: 3 })).status).toBe(404);
      const hit = await post(`${served.url}/b/locomo/search`, { user_id: "u", query: "hello", top_k: 3 });
      expect(hit.body.memories).toEqual(["user: hello locomo"]);
      expect((await post(`${served.url}/b/locomo/nope`, {})).status).toBe(404);
      expect(served.stats().locomo.searches).toBe(1);
      expect(served.stats().halumem.errors).toBe(1);
      expect(readdirSync(root).sort()).toEqual(["halumem", "locomo"]);
    } finally {
      await served.close();
    }
    expect(sidecarRoute("/b/x/add")).toEqual({ board: "x", op: "add" });
    expect(sidecarRoute("/search")).toEqual({ board: "default", op: "search" });
    expect(sidecarRoute("/b/../add")).toBeNull();
    expect(sidecarRoute("/b/.hidden/add")).toBeNull();
    expect(chatRoute("/b/../v1/chat/completions")).toBeNull();
  });
});

describe("meter", () => {
  it("prices the shared reader and judge, and refuses what it cannot price", () => {
    expect(priceOf(ANSWER_MODEL)).toBe(PRICES["gpt-4.1-mini"]);
    expect(priceOf(EVAL_MODEL)).toBe(PRICES["gpt-4o-mini"]);
    expect(priceOf("gpt-5")).toBeNull();
    expect(costUsd(ANSWER_MODEL, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBeCloseTo(2.0, 10);
    expect(costUsd(ANSWER_MODEL, { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1_000_000 } })).toBeCloseTo(0.1, 10);
    expect(() => worstCaseUsd({ model: "gpt-5", messages: [] })).toThrow(/no price/);
  });

  it("bounds a call's cost from above: every prompt byte a token, the whole output limit", () => {
    const body = { model: EVAL_MODEL, messages: [{ role: "user", content: "héllo" }] };
    expect(promptBytes(body)).toBe(3 + 4 + 4 + 6);
    expect(worstCaseUsd(body)).toBeCloseTo((17 * 0.15 + 16_384 * 0.6) / 1e6, 12);
    expect(worstCaseUsd({ ...body, max_tokens: 10, n: 2 })).toBeCloseTo((17 * 0.15 + 20 * 0.6) / 1e6, 12);
  });

  it("never lets spent plus reserved pass the cap, and records the trip", () => {
    const ledger = new SpendLedger({ capUsd: 0.05, mode: "forward" });
    const body = { model: ANSWER_MODEL, messages: [{ role: "user", content: "x".repeat(1000) }] }; // worst ≈ $0.0528 > cap
    expect(ledger.reserve(body, "locomo")).toBeNull();
    expect(ledger.tripped).toMatchObject({ board: "locomo" });
    const small = { ...body, max_tokens: 100 }; // worst ≈ $0.00056
    const t = ledger.reserve(small, "locomo");
    expect(t).not.toBeNull();
    expect(ledger.settle(t!, { usage: { prompt_tokens: 250, completion_tokens: 10 } })).toBeCloseTo((250 * 0.4 + 10 * 1.6) / 1e6, 12);
    const lost = ledger.reserve(small, "beam");
    ledger.settle(lost!, { lost: true });
    const refusedByOpenAI = ledger.reserve(small, "beam");
    ledger.settle(refusedByOpenAI!, { upstreamError: true });
    expect(ledger.reservedUsd).toBe(0);
    expect(ledger.boardTotals("beam")).toMatchObject({ calls: 1, usageMissing: 1, upstreamErrors: 1 });
    expect(ledger.boardTotals("locomo")).toMatchObject({ calls: 1, refused: 1 });
    expect(() => new SpendLedger({ capUsd: 0, mode: "stub" })).toThrow();
  });

  it("stubs a reader and a judge every OmniMemEval parser can read", () => {
    const judge = stubContent({ model: EVAL_MODEL }, { answerModel: ANSWER_MODEL });
    // nlp_metrics.extract_label_json (LoCoMo, LongMemEval, HaluMem judges), at the pin.
    const label = /\{\s*"label"\s*:\s*["']([^"']*)["']\s*\}/.exec(judge);
    expect(JSON.parse(label![0]).label).toBe("WRONG");
    // The patterns of beam_eval.py's rubric and event-ordering judges.
    expect(/\{[^{}]*"score"\s*:\s*([0-9.]+)[^{}]*\}/.exec(judge)?.[1]).toBe("0");
    expect(/\{[^{}]*"positions"\s*:\s*\[.*?\]\s*\}/s.test(judge)).toBe(true);
    expect(stubContent({ model: ANSWER_MODEL }, { answerModel: ANSWER_MODEL })).toMatch(/stub reader/);
  });

  it("routes by board, stubs with usage, and refuses streams, unpriced models and calls over the cap", async () => {
    expect(chatRoute("/b/longmemeval/v1/chat/completions")).toEqual({ board: "longmemeval" });
    expect(chatRoute("/v1/chat/completions")).toEqual({ board: "unassigned" });
    expect(chatRoute("/b/a/v1/embeddings")).toBeNull();
    const ledgerPath = join(tmp(), "ledger.json");
    const meter = await serveMeter({ mode: "stub", capUsd: 0.02, answerModel: ANSWER_MODEL, ledgerPath });
    try {
      const ok = await post(`${meter.url}/b/locomo/v1/chat/completions`, { model: ANSWER_MODEL, max_tokens: 50, messages: [{ role: "user", content: "x".repeat(400) }] });
      expect(ok.status).toBe(200);
      expect(ok.body.choices[0].message.content).toMatch(/stub reader/);
      expect(ok.body.usage.prompt_tokens).toBe(Math.ceil((4 + 4 + 400) / 4) + 3);
      expect((await post(`${meter.url}/b/locomo/v1/chat/completions`, { model: ANSWER_MODEL, stream: true, messages: [] })).status).toBe(400);
      expect((await post(`${meter.url}/b/locomo/v1/chat/completions`, { model: "o3", messages: [] })).status).toBe(400);
      const over = await post(`${meter.url}/b/locomo/v1/chat/completions`, { model: ANSWER_MODEL, messages: [{ role: "user", content: "x" }] });
      expect(over.status).toBe(402);
      expect(over.body.error.type).toBe("spend_cap_reached");
      const saved = JSON.parse(readFileSync(ledgerPath, "utf8"));
      expect(saved.billedUsd).toBe(0);
      expect(meterView(saved, "locomo")).toMatchObject({ readerCalls: 1, refused: 1, judgeCalls: 0 });
    } finally {
      await meter.close();
    }
  });

  it("forwards with the key only it holds, passes OpenAI's errors back unbilled, and charges a lost call its worst case", async () => {
    const seen: { auth: string | null; body: any }[] = [];
    let mode = "ok";
    const fetchImpl = async (_url: string, init: any) => {
      seen.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
      if (mode === "throw") throw new Error("socket hang up");
      if (mode === "429") return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Biscuit" } }], usage: { prompt_tokens: 1000, completion_tokens: 5 } }), { status: 200 });
    };
    const meter = await serveMeter({ mode: "forward", capUsd: 5, apiKey: "sk-test", answerModel: ANSWER_MODEL, fetchImpl: fetchImpl as any });
    try {
      const body = { model: ANSWER_MODEL, max_tokens: 20, messages: [{ role: "user", content: "q" }] };
      expect((await post(`${meter.url}/b/locomo/v1/chat/completions`, body)).body.choices[0].message.content).toBe("Biscuit");
      expect(seen[0].auth).toBe("Bearer sk-test");
      mode = "429";
      expect((await post(`${meter.url}/b/locomo/v1/chat/completions`, body)).status).toBe(429);
      mode = "throw";
      expect((await post(`${meter.url}/b/locomo/v1/chat/completions`, body)).status).toBe(504);
      const t = meter.ledger.boardTotals("locomo");
      expect(t).toMatchObject({ calls: 2, upstreamErrors: 1, usageMissing: 1 });
      expect(meter.ledger.spentUsd).toBeCloseTo((1000 * 0.4 + 5 * 1.6) / 1e6 + worstCaseUsd(body), 12);
    } finally {
      await meter.close();
    }
    expect(() => serveMeter({ mode: "forward", capUsd: 1, answerModel: ANSWER_MODEL })).toThrow(/API key/);
  });
});

describe("harness patches", () => {
  const patch = PATCHES[0];

  it("applies once, recognises itself, and refuses a moved or doubled anchor", () => {
    const original = `x\n${patch.anchor}y\n`;
    const once = patchText(original, patch);
    expect(once.status).toBe("applied");
    expect(once.content).toBe(`x\n${patch.anchor}${patch.text}y\n`);
    expect(patchText(once.content, patch)).toEqual({ content: once.content, status: "already" });
    expect(() => patchText("x\n", patch)).toThrow(/exactly once, found it 0 times/);
    expect(() => patchText(patch.anchor + patch.anchor, patch)).toThrow(/found it 2 times/);
    const replace = PATCHES.find((p) => p.kind === "replace")!;
    expect(patchText(`a ${replace.anchor} b`, replace).content).toBe(`a ${replace.text} b`);
    const before = PATCHES.find((p) => p.kind === "before")!;
    expect(patchText(`a\n${before.anchor}`, before).content).toBe(`a\n${before.text}${before.anchor}`);
  });

  it("prepares a checkout at the pin, writes nothing when an anchor has moved, and refuses another commit", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), `${OMNIMEMEVAL.commit}\n`);
    const files = new Map<string, string>();
    for (const p of PATCHES) files.set(p.file, `${files.get(p.file) ?? "head\n"}${p.anchor}\n`);
    for (const [f, c] of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    const noGit = () => {
      throw new Error("git should not run: the checkout is at the pin");
    };
    const r = prepareHarness(dir, { git: noGit });
    expect(r.files.filter((f: { status: string }) => f.status === "applied")).toHaveLength(PATCHES.length);
    for (const c of COPIES) expect(existsSync(join(dir, c.to))).toBe(true);
    expect(prepareHarness(dir, { git: noGit }).files.filter((f: { status: string }) => f.status === "already")).toHaveLength(PATCHES.length);
    // A tree where one anchor is missing: no file is written.
    const broken = tmp();
    mkdirSync(join(broken, ".git"));
    writeFileSync(join(broken, ".git", "HEAD"), `${OMNIMEMEVAL.commit}\n`);
    for (const [f, c] of files) {
      mkdirSync(join(broken, f, ".."), { recursive: true });
      writeFileSync(join(broken, f), f === PATCHES[PATCHES.length - 1].file ? "moved\n" : c);
    }
    expect(() => prepareHarness(broken, { git: noGit })).toThrow(/exactly once/);
    expect(readFileSync(join(broken, PATCHES[0].file), "utf8")).toBe(files.get(PATCHES[0].file));
    const other = tmp();
    mkdirSync(join(other, ".git"));
    writeFileSync(join(other, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(other, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(other, ".git", "refs", "heads", "main"), `${"0".repeat(40)}\n`);
    expect(checkedOutCommit(other)).toBe("0".repeat(40));
    expect(() => prepareHarness(other, { git: () => {} })).toThrow(/not the pinned/);
  });
});

describe("runner", () => {
  it("knows the five boards, and what a full run should cost", () => {
    // PersonaMem v2 last: the largest, so a reached cap stops it and not the others.
    expect(BOARD_ORDER).toEqual(["locomo", "longmemeval", "beam", "halumem", "personamem_v2"]);
    expect(boardSpec("beam", { beamScale: "10m" }).questions).toBe(200);
    expect(() => boardSpec("convomem")).toThrow(/unknown board/);
    const total = BOARD_ORDER.reduce((s, b) => s + expectedCost(b)!.usd, 0);
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThan(MAX_USD_CEILING);
    expect(expectedCost("personamem_v2")!.judgeCalls).toBe(0);
  });

  it("writes an env file with no key and the per-board URLs, and the harness command", () => {
    const env = boardEnv({ board: "beam", sidecarUrl: "http://127.0.0.1:1", meterUrl: "http://127.0.0.1:2", topK: 20, llmWorkers: 10 });
    expect(env).toContain('AL_BUDDY_URL="http://127.0.0.1:1/b/beam"');
    expect(env).toContain('ANSWER_BASE_URL="http://127.0.0.1:2/b/beam/v1"');
    expect(env).toContain(`EVAL_MODEL="${EVAL_MODEL}"`);
    expect(env).not.toMatch(/sk-/);
    const argv = boardCommand(boardSpec("beam"), { envFile: "/e", version: "v", topK: 20, workers: 2, llmWorkers: 10, limit: 2, toStep: null });
    expect(argv.join(" ")).toBe("bash scripts/run_beam_eval.sh --lib al_buddy --env /e --version v --top-k 20 --workers 2 --llm-workers 10 --scale 100k --streaming 1 --end-idx 1");
    expect(boardCommand(boardSpec("locomo"), { envFile: "/e", version: "v", topK: 20, workers: 2, llmWorkers: 10, limit: 2, toStep: 3 })).not.toContain("--streaming");
  });

  it("lets one run at a time use a harness, and takes over a dead run's lock", () => {
    const lock = join(tmp(), "harness.lock");
    const release = takeLock(lock, { pid: 111, isAlive: () => true });
    expect(() => takeLock(lock, { pid: 222, isAlive: () => true })).toThrow(/pid 111/);
    const second = takeLock(lock, { pid: 222, isAlive: () => false });
    expect(readFileSync(lock, "utf8").trim()).toBe("222");
    release(); // the first run's release leaves the second's lock alone
    expect(existsSync(lock)).toBe(true);
    second();
    expect(existsSync(lock)).toBe(false);
  });

  it("reads the key file without echoing it, quotes and comments allowed", () => {
    const p = join(tmp(), ".env.omnimemeval");
    writeFileSync(p, '# key\nOPENAI_API_KEY="sk-abc" # mine\nexport OTHER=1\n');
    expect(readEnvFile(p)).toEqual({ OPENAI_API_KEY: "sk-abc", OTHER: "1" });
  });

  it("reads a board's headline from its grades, and says why when there is none", () => {
    const dir = tmp();
    const spec = boardSpec("longmemeval");
    const res = join(dir, spec.results, "al_buddy-v");
    expect(readBoardResult(dir, spec, "v")).toMatchObject({ score: null, why: expect.stringMatching(/did not run/) });
    mkdirSync(res, { recursive: true });
    writeFileSync(join(res, spec.grades), JSON.stringify({ metrics: { llm_judge_score: 0.812, context_tokens: 3999 }, category_scores: { a: { total: 300 }, b: { total: 200 } } }));
    expect(readBoardResult(dir, spec, "v")).toMatchObject({ score: 0.812, questions: 500, contextTokens: 3999 });
    writeFileSync(join(res, spec.grades), JSON.stringify({ overall: {} }));
    expect(readBoardResult(dir, spec, "v")).toMatchObject({ score: null, why: expect.stringMatching(/metrics.llm_judge_score not in/) });
  });
});
