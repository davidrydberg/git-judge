import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { ReportJson } from "../src/report.js";
import { resolve, scoreCase, totals, type EvalCase } from "../scripts/eval-score.js";

const hunk = (id: string, path: string, content: string) => ({ id, path, content }) as Hunk;
const HUNKS = [
  hunk("src/a.ts#0", "src/a.ts", "+import x"),
  hunk("src/a.ts#1", "src/a.ts", "-  if (allowed(user)) {"),
  hunk("src/b.ts#0", "src/b.ts", "+const LIMIT = 10;"),
];
const report = (order: string[], verdicts: [string, string][]) =>
  ({
    readingOrder: order.map((hunkId) => ({ hunkId })),
    verdicts: verdicts.map(([hunkId, flagId]) => ({ hunkId, flagId })),
  }) as unknown as ReportJson;

const CASE: EvalCase = {
  title: "t",
  description: "d",
  mustRead: [{ path: "src/a.ts", contains: "allowed(user)" }],
  flags: [{ path: "src/a.ts", contains: "allowed(user)", id: "safety_check_weakened" }],
  acceptable: [{ path: "src/b.ts", contains: "LIMIT", id: "safety_check_weakened" }],
};

describe("eval scoring", () => {
  test("a label names exactly one hunk, by file and a string in its diff", () => {
    expect(resolve({ path: "src/a.ts", contains: "allowed" }, HUNKS).id).toBe("src/a.ts#1");
    expect(() => resolve({ path: "src/a.ts", contains: "nowhere" }, HUNKS)).toThrow("matches 0 hunks");
    expect(() => resolve({ path: "src/a.ts", contains: "" }, HUNKS)).toThrow("matches 2 hunks");
  });

  test("ranks the must-read hunk, counts the true flag, and lets an acceptable verdict pass", () => {
    const json = report(["src/b.ts#0", "src/a.ts#1"], [["src/a.ts#1", "safety_check_weakened"], ["src/b.ts#0", "safety_check_weakened"]]);
    expect(scoreCase(CASE, HUNKS, json)).toMatchObject({ ranks: [2], inTop5: 1, truePositives: 1, falsePositives: [], missedFlags: [] });
  });

  test("a hunk outside the reading order has no rank, a missing flag is missed, any other verdict is false", () => {
    const json = report(["src/b.ts#0"], [["src/a.ts#0", "comment_drift"]]);
    expect(scoreCase(CASE, HUNKS, json)).toMatchObject({
      ranks: [null],
      inTop10: 0,
      truePositives: 0,
      falsePositives: ["src/a.ts#0|comment_drift"],
      missedFlags: ["src/a.ts#1|safety_check_weakened"],
    });
  });

  test("totals are ratios over all cases, and an empty ratio is 1", () => {
    const hit = scoreCase(CASE, HUNKS, report(["src/a.ts#1"], [["src/a.ts#1", "safety_check_weakened"]]));
    const miss = scoreCase(CASE, HUNKS, report([], [["src/a.ts#0", "comment_drift"]]));
    expect(totals([hit, miss])).toEqual({ cases: 2, recallTop5: 0.5, recallTop10: 0.5, flagRecall: 0.5, flagPrecision: 0.5 });
    expect(totals([])).toMatchObject({ recallTop5: 1, flagPrecision: 1 });
  });
});
