import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { Findings } from "../src/policy.js";
import {
  buildDidNotRunReport,
  buildReport,
  costUsd,
  extractJson,
  inlineKey,
  isSummaryComment,
  type ReportInput,
} from "../src/report.js";
import type { Verdict, Written } from "../src/writer.js";

function hunk(path: string, startLine: number, endLine: number, overrides: Partial<Hunk> = {}): Hunk {
  return {
    id: `${path}#0`,
    path,
    language: "TypeScript",
    isTest: false,
    startLine,
    endLine,
    added: 3,
    deleted: 3,
    size: 6,
    preClass: null,
    anchor: { line: startLine, side: "RIGHT" },
    content: "",
    hash: `${"ab12".repeat(4)}${path.length}`.padEnd(64, "0"),
    ...overrides,
  };
}

const HUNKS = [
  hunk("src/auth/session.ts", 1, 13),
  hunk("test/invoice.test.ts", 2, 6),
  hunk("db/migrations/007_drop_legacy.sql", 1, 4),
  hunk("src/util/format.ts", 10, 10),
  hunk("package-lock.json", 1, 900, { preClass: "lockfile" }),
];

function verdict(path: string, flagId: Verdict["flagId"], overrides: Partial<Verdict> = {}): Verdict {
  return {
    hunkId: `${path}#0`,
    flagId,
    kind: "warning",
    probability: 0.8,
    confirmed: true,
    severity: "medium",
    whatChanged: `Something changed in ${path}.`,
    whatToVerify: `Check ${path} before approving.`,
    model: "gpt-5.6-luna",
    ...overrides,
  };
}

function findings(overrides: Partial<Findings> = {}): Findings {
  return {
    flags: [],
    prWarnings: [],
    readingOrder: [],
    skipped: { mechanical: 0, lockfile: 1, generated: 0, vendored: 0, overCap: 0 },
    lowCoverage: [],
    labels: ["size: S"],
    conclusion: "success",
    ...overrides,
  };
}

function input(found: Findings, written: Partial<Written> = {}): ReportInput {
  return {
    hunks: HUNKS,
    findings: found,
    written: {
      verdicts: [],
      tldr: null,
      usage: { "gpt-5.6-luna": { requests: 3, inputTokens: 3000, outputTokens: 400 } },
      ...written,
    },
    judgement: { model: "jev-1.13.0", inputTokens: 60_000 },
    durationMs: 3240,
  };
}

const CLEAN = input(
  findings({
    readingOrder: [{ hunkId: "src/util/format.ts#0", attention: 1 }],
    skipped: { mechanical: 3, lockfile: 1, generated: 0, vendored: 0, overCap: 0 },
  }),
  { usage: {} },
);

const WARNINGS = input(
  findings({
    readingOrder: [
      { hunkId: "src/auth/session.ts#0", attention: 4.8 },
      { hunkId: "test/invoice.test.ts#0", attention: 2.4 },
      { hunkId: "src/util/format.ts#0", attention: 1 },
    ],
    prWarnings: [
      { id: "weak_description", score: 0.4 },
      { id: "split_suggested", changeTypes: ["chore", "feature", "refactor"] },
    ],
    lowCoverage: ["src/auth/session.ts#0"],
    labels: ["area: auth", "size: S", "type: refactor"],
  }),
  {
    tldr: "Presented as a refactor, but it removes the token expiry check. One test was loosened to match.",
    verdicts: [
      verdict("src/auth/session.ts", "safety_check_weakened", {
        severity: "high",
        whatChanged: "The expiry check on the token claims was removed.",
        whatToVerify: "Confirm expired tokens are still rejected somewhere else.",
      }),
      verdict("test/invoice.test.ts", "test_loosened"),
    ],
  },
);

const GATED = input(
  findings({
    conclusion: "failure",
    readingOrder: [{ hunkId: "db/migrations/007_drop_legacy.sql#0", attention: 4 }],
    skipped: { mechanical: 0, lockfile: 1, generated: 0, vendored: 0, overCap: 0 },
  }),
  {
    tldr: "Drops the legacy_orders table.",
    verdicts: [
      verdict("db/migrations/007_drop_legacy.sql", "destructive_data", {
        kind: "gate",
        severity: "high",
        confirmed: false,
      }),
    ],
  },
);

const OVER_CAP = input(
  findings({
    readingOrder: [{ hunkId: "src/util/format.ts#0", attention: 1 }],
    skipped: { mechanical: 0, lockfile: 1, generated: 0, vendored: 0, overCap: 140 },
    prWarnings: [{ id: "no_description" }],
  }),
);

describe("summary comment", () => {
  test.each([
    ["clean PR", CLEAN],
    ["PR with warnings", WARNINGS],
    ["gated PR", GATED],
    ["PR over the hunk cap", OVER_CAP],
  ])("%s", (_name, reportInput) => {
    expect(buildReport(reportInput).summary).toMatchSnapshot();
  });

  test("readfirst did not run", () => {
    expect(buildDidNotRunReport("TypeSafe returned 529 Overloaded after 5 attempts.", false)).toMatchSnapshot();
    expect(buildDidNotRunReport("TypeSafe returned 529 Overloaded after 5 attempts.", true).check.conclusion).toBe(
      "failure",
    );
  });

  test("starts with the marker used to find and update it", () => {
    expect(isSummaryComment(buildReport(CLEAN).summary)).toBe(true);
    expect(isSummaryComment(buildDidNotRunReport("down", false).summary)).toBe(true);
    expect(isSummaryComment("## readfirst looks nice")).toBe(false);
  });

  test("a long reading order is cut in the comment but complete in the JSON", () => {
    const many = Array.from({ length: 40 }, (_, index) => hunk(`src/file${index}.ts`, 1, 5));
    const report = buildReport({
      ...CLEAN,
      hunks: many,
      findings: findings({ readingOrder: many.map((entry) => ({ hunkId: entry.id, attention: 1 })) }),
    });
    expect(report.summary).toContain("15. `src/file14.ts`");
    expect(report.summary).not.toContain("16. `");
    expect(report.summary).toContain("And 25 more hunks");
    expect(report.json.readingOrder).toHaveLength(40);
  });
});

describe("JSON block", () => {
  test("round-trips and equals the action output", () => {
    const report = buildReport(WARNINGS);
    expect(extractJson(report.summary)).toEqual(report.json);
  });

  test("text that would close the HTML comment early is escaped and still round-trips", () => {
    const hostile = "Ends the comment --> <script>alert(1)</script>";
    const report = buildReport(input(findings(), { tldr: hostile, verdicts: [] }));
    const block = report.summary.slice(report.summary.indexOf("<!-- readfirst:json"));
    expect(block.match(/-->/g)).toHaveLength(1);
    expect(extractJson(report.summary)!.tldr).toBe(hostile);
  });

  test("a comment without the block gives null", () => {
    expect(extractJson(buildDidNotRunReport("down", false).summary)).toBeNull();
  });
});

describe("inline comments", () => {
  test("one per verdict, anchored to the hunk", () => {
    const report = buildReport(WARNINGS);
    expect(report.inline.map((comment) => [comment.path, comment.anchor])).toEqual([
      ["src/auth/session.ts", { line: 1, side: "RIGHT" }],
      ["test/invoice.test.ts", { line: 2, side: "RIGHT" }],
    ]);
    expect(report.inline[0]!.body).toMatchSnapshot();
  });

  test("the key is recoverable from the body and changes with file, flag, or hunk content", () => {
    const [first, second] = buildReport(WARNINGS).inline;
    expect(inlineKey(first!.body)).toBe(first!.key);
    expect(first!.key).not.toBe(second!.key);
    expect(inlineKey("A human comment")).toBeNull();

    const edited = HUNKS.map((entry) => (entry.path === "src/auth/session.ts" ? { ...entry, hash: "f".repeat(64) } : entry));
    expect(buildReport({ ...WARNINGS, hunks: edited }).inline[0]!.key).not.toBe(first!.key);
  });

  test("a path with spaces still gives a key without spaces", () => {
    const spaced = hunk("docs/my notes/plan.md", 1, 2);
    const report = buildReport({
      ...CLEAN,
      hunks: [spaced],
      findings: findings(),
      written: { verdicts: [verdict("docs/my notes/plan.md", "comment_drift")], tldr: "x", usage: {} },
    });
    expect(inlineKey(report.inline[0]!.body)).toBe(report.inline[0]!.key);
  });
});

describe("check", () => {
  test.each([
    ["clean", CLEAN, "success", "Nothing flagged"],
    ["warnings", WARNINGS, "success", "2 findings to read first"],
    ["gated", GATED, "failure", "Blocked: destructive data change"],
  ])("%s", (_name, reportInput, conclusion, title) => {
    expect(buildReport(reportInput).check).toMatchObject({ conclusion, title });
  });
});

describe("cost", () => {
  test("Jev input tokens plus generator input and output tokens", () => {
    // 60k * 0.042 / 1M + 3000 * 0.2 / 1M + 400 * 1.2 / 1M
    expect(costUsd(WARNINGS)).toBeCloseTo(0.00252 + 0.0006 + 0.00048);
  });

  test("an unknown generator model gives no cost instead of a wrong one", () => {
    const unknown = input(findings(), { usage: { "some-new-model": { requests: 1, inputTokens: 1, outputTokens: 1 } } });
    expect(costUsd(unknown)).toBeNull();
    expect(buildReport(unknown).summary).toContain("cost unknown");
  });
});
