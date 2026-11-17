import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The recall test runs on an InMemoryStore, so this file needs no SQLite binding.

import * as lib from "../../src/index.js";
import { RESULTS_DIR } from "../lib/run-info.mjs";
import { CEILING_TYPES, ORACLE_FLAGS, SWEEP_FLAGS, lossOf, modelName, readerSplit, readerSentence } from "./ceilings.mjs";
import { PUBLISHED } from "./event-study.mjs";
import { historyRoundCount, ingestHistory, recallRounds } from "./memory.mjs";
import { instance } from "./fixture.js";

type Row = { question_id: string; question_type: string; abstention?: boolean; label?: boolean; error?: string; retrieval?: unknown; shownRounds?: string[] };
const shown = (all: boolean) => ({ skipped: null, shown: { rounds: 20, evidence: 2, found: all ? 2 : 1, all: all ? 1 : 0 } });
const result = (questions: Row[]) => ({ questions });

describe("the reader's ceiling: where a published question was lost", () => {
  it("follows the review's rule: abstention, not scored, shown every evidence turn (reader), or not (recall)", () => {
    expect(lossOf({ retrieval: shown(false) }, true)).toBeNull();
    expect(lossOf({ abstention: true, retrieval: { skipped: "abstention" } }, false)).toBe("lostAbstention");
    expect(lossOf({ retrieval: { skipped: "no-user-evidence" } }, false)).toBe("lostNotScored");
    expect(lossOf({ retrieval: shown(true) }, false)).toBe("lostByReader");
    expect(lossOf({ retrieval: shown(false) }, false)).toBe("lostToRecall");
  });

  it("splits each group by what the oracle run got right, and lists what it could not place", () => {
    const published = result([
      { question_id: "r1", question_type: "multi-session", retrieval: shown(false), label: true },
      { question_id: "r2", question_type: "temporal-reasoning", retrieval: shown(false), label: false },
      { question_id: "d1", question_type: "multi-session", retrieval: shown(true), label: true },
      { question_id: "ok", question_type: "multi-session", retrieval: shown(true), label: true },
      { question_id: "ab_abs", question_type: "multi-session", abstention: true, retrieval: { skipped: "abstention" }, label: false },
      { question_id: "other", question_type: "knowledge-update", retrieval: shown(false), label: false },
    ]);
    const official = [
      { question_id: "r1", label: false },
      { question_id: "r2", label: false },
      { question_id: "d1", label: false },
      { question_id: "ok", label: true },
      { question_id: "ab_abs", label: false },
      { question_id: "other", label: false },
    ];
    const oracle = result([
      { question_id: "r1", question_type: "multi-session", retrieval: shown(true), label: true, shownRounds: ["a", "b"] },
      { question_id: "r2", question_type: "temporal-reasoning", retrieval: shown(true), label: false, shownRounds: ["a"] },
      { question_id: "d1", question_type: "multi-session", retrieval: shown(true), label: true, shownRounds: ["a", "b", "c"] },
      { question_id: "ok", question_type: "multi-session", retrieval: shown(true), label: false, shownRounds: ["a"] },
      { question_id: "ab_abs", question_type: "multi-session", retrieval: { skipped: "abstention" }, error: "usage", shownRounds: [] },
    ]);
    const s = readerSplit(published, official, oracle, { historyRounds: new Map([["r1", 2], ["r2", 1], ["d1", 4], ["ok", 1]]) });
    expect(s.official.groups.lostToRecall).toMatchObject({ n: 2, oracleRight: ["r1"], oracleWrong: ["r2"], notInOracle: [] });
    expect(s.official.groups.lostToRecall.byType).toEqual({ "multi-session": { n: 1, oracleRight: 1 }, "temporal-reasoning": { n: 1, oracleRight: 0 } });
    expect(s.official.groups.lostByReader).toMatchObject({ n: 1, oracleRight: ["d1"] });
    expect(s.official.groups.lostAbstention).toMatchObject({ n: 1, notInOracle: ["ab_abs"] });
    expect(s.official.groups.right).toMatchObject({ n: 1, oracleWrong: ["ok"] });
    // The knowledge-update question is outside the ceiling's types.
    expect(Object.values(s.official.groups).reduce((a, g) => a + g.n, 0)).toBe(5);
    // Judge for judge: the published run's own labels put r1 and d1 among the right.
    expect(s.claude.groups.right.n).toBe(3);
    expect(s.claude.groups.lostToRecall).toMatchObject({ n: 1, oracleWrong: ["r2"] });
    expect(s.claude.unlabeled).toEqual([]);
    // An errored question and a history not shown whole make it no ceiling.
    expect(s.status).toBe("incomplete");
    expect(s.incomplete).toEqual(["1 oracle question(s) errored", "1 oracle question(s) were not shown their whole history"]);
    expect(s.coverage).toMatchObject({ scored: 4, shownAll: 4, notShownAll: [], wholeHistory: { shown: 3, of: 4, partial: ["d1"] } });
    expect(s.oracleCorrectByType).toEqual({ "multi-session": { correct: 2, n: 3 }, "temporal-reasoning": { correct: 0, n: 1 } });
    expect(readerSentence(s)).toBe("the reader's ceiling is incomplete (1 oracle question(s) errored; 1 oracle question(s) were not shown their whole history) and concludes nothing");
  });

  it("is incomplete when a scored question was not shown every evidence turn or is missing", () => {
    const published = result([
      { question_id: "a", question_type: "multi-session", retrieval: shown(false), label: false },
      { question_id: "b", question_type: "multi-session", retrieval: shown(false), label: false },
    ]);
    const s = readerSplit(published, [], result([{ question_id: "a", question_type: "multi-session", retrieval: shown(false), label: true }]));
    expect(s.status).toBe("incomplete");
    expect(s.incomplete).toEqual(["1 of the 2 questions are not in the oracle run", "1 scored oracle question(s) were not shown every evidence turn"]);
    // No official label for either: listed, not dropped.
    expect(s.official.unlabeled).toEqual(["a", "b"]);
  });

  it("reproduces the review's loss table on the committed published run, and says it in one clause", () => {
    const published = JSON.parse(readFileSync(join(RESULTS_DIR, PUBLISHED.result), "utf8"));
    const official = readFileSync(join(RESULTS_DIR, PUBLISHED.labels), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // An oracle run that got every question right, shown every evidence turn.
    const oracle = result(
      published.questions
        .filter((q: Row) => CEILING_TYPES.includes(q.question_type))
        .map((q: Row) => ({ question_id: q.question_id, question_type: q.question_type, retrieval: (q.retrieval as { skipped: string | null }).skipped ? q.retrieval : shown(true), label: true, shownRounds: [] })),
    );
    const s = readerSplit(published, official, oracle);
    const g = s.official.groups;
    // § 2.1 of the review, multi-session and temporal reasoning: 12 + 5 to recall, 8 + 3 by the reader, 2 abstention.
    expect([g.lostToRecall.n, g.lostByReader.n, g.lostAbstention.n, g.lostNotScored.n, g.right.n]).toEqual([17, 11, 2, 0, 236]);
    expect(g.lostToRecall.byType).toEqual({ "multi-session": { n: 12, oracleRight: 12 }, "temporal-reasoning": { n: 5, oracleRight: 5 } });
    expect(g.lostByReader.byType).toEqual({ "multi-session": { n: 8, oracleRight: 8 }, "temporal-reasoning": { n: 3, oracleRight: 3 } });
    expect(s.official.unlabeled).toEqual([]);
    expect(s.status).toBe("complete");
    const sonnet = { kind: "claude-cli", requestedModel: "sonnet" };
    expect(readerSentence(s, { answerer: sonnet, judge: sonnet })).toBe(
      "shown every evidence session (oracle; Claude sonnet reading and judging; multi-session 133/133, temporal 133/133), the reader got 17 of the 17 questions the published run lost to recall " +
        "and 11 of the 11 it lost with every evidence turn shown (official labels), so 0 of those 28 stay wrong with perfect recall, and it got 0 wrong that the published run got right",
    );
  });

  it("names the reader and judge the oracle run used, and the questions it did not run", () => {
    const published = result([
      { question_id: "a", question_type: "multi-session", retrieval: shown(false), label: false },
      { question_id: "b", question_type: "multi-session", retrieval: shown(false), label: false },
    ]);
    const official = [{ question_id: "a", label: false }, { question_id: "b", label: false }];
    const s = { ...readerSplit(published, official, result([{ question_id: "a", question_type: "multi-session", retrieval: shown(true), label: false, shownRounds: [] }])), status: "smoke" };
    expect(modelName(null)).toBe("no model");
    expect(readerSentence(s, { answerer: { kind: "command", command: "echo hi" }, judge: { kind: "claude-cli", requestedModel: "sonnet" } })).toBe(
      "shown every evidence session (oracle; echo hi reading, Claude sonnet judging; multi-session 0/1), the reader got 0 of the 2 questions the published run lost to recall, 1 not run " +
        "and 0 of the 0 it lost with every evidence turn shown (official labels), so 1 of those 2 stay wrong with perfect recall, and it got 0 wrong that the published run got right",
    );
  });
});

describe("the reader's ceiling: the whole oracle history in front of the reader", () => {
  it("counts the rounds a history has, as recall groups them", () => {
    // Filler opening with an assistant turn (1 round), an evidence session of 2 rounds, then 1.
    expect(historyRoundCount(instance())).toBe(4);
    const blank = instance({ haystack_sessions: [[{ role: "user", content: " " }, { role: "assistant", content: "" }], [{ role: "user", content: "hi" }]] , haystack_session_ids: ["a", "b"], haystack_dates: ["2023/01/05 (Thu) 09:00", "2023/01/06 (Fri) 09:00"] });
    expect(historyRoundCount(blank)).toBe(1);
  });

  it("with a pool larger than the history, recall shows every round of it", async () => {
    const memory = await ingestHistory(lib, instance(), { embedder: new lib.FakeEmbedder("words", 2, (t: string) => [t.length % 7, 1]), store: () => new lib.InMemoryStore() });
    const { rounds } = await recallRounds(memory, instance(), { expand: true, recallPool: 200 });
    expect(rounds.slice(0, 40)).toHaveLength(historyRoundCount(instance()));
  });

  it("asks run.mjs for room enough: 40 rounds and a pool of 200 on the oracle variant", () => {
    const at = (flag: string) => ORACLE_FLAGS[ORACLE_FLAGS.indexOf(flag) + 1];
    expect(at("--variant")).toBe("oracle");
    expect(at("--types")).toBe("multi-session,temporal-reasoning");
    // No oracle history of these types has more than 36 rounds or 72 messages (the S file's evidence sessions).
    expect(Number(at("--top-k"))).toBeGreaterThanOrEqual(36);
    expect(Number(at("--aggregate-top-k"))).toBeGreaterThanOrEqual(36);
    expect(Number(at("--recall-pool")) / 2).toBeGreaterThanOrEqual(72);
    expect(ORACLE_FLAGS).toEqual(expect.arrayContaining(["--expand", "--chain-of-note"]));
    // The sweep is the review's: the 50-question gain set, twice the pool, held to +5.
    expect(SWEEP_FLAGS.join(" ")).toBe("--limit 50 --types multi-session,temporal-reasoning --expand --aggregate-top-k 40 --recall-pool 200 --gain-bar 5");
  });
});
