import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { Findings } from "../src/policy.js";
import {
  buildDidNotRunReport,
  buildReport,
  costUsd,
  extractJson,
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

  test("git-judge did not run", () => {
    expect(buildDidNotRunReport("TypeSafe returned 529 Overloaded after 5 attempts.", false)).toMatchSnapshot();
    expect(buildDidNotRunReport("TypeSafe returned 529 Overloaded after 5 attempts.", true).check.conclusion).toBe(
      "failure",
    );
  });

  test("starts with the marker used to find and update it", () => {
    expect(isSummaryComment(buildReport(CLEAN).summary)).toBe(true);
    expect(isSummaryComment(buildDidNotRunReport("down", false).summary)).toBe(true);
    expect(isSummaryComment("## git-judge looks nice")).toBe(false);
  });

  test("unflagged hunks are cut to a handful in the comment but complete in the JSON", () => {
    const many = Array.from({ length: 40 }, (_, index) => hunk(`src/file${index}.ts`, 1, 5));
    const report = buildReport({
      ...CLEAN,
      hunks: many,
      findings: findings({ readingOrder: many.map((entry) => ({ hunkId: entry.id, attention: 1 })) }),
    });
    expect(report.summary).toContain("5. `src/file4.ts`");
    expect(report.summary).not.toContain("6. `");
    expect(report.summary).toContain("And 35 more hunks");
    expect(report.json.readingOrder).toHaveLength(40);
  });

  test("a hunk with a confirmed finding is read before an unflagged hunk with higher attention", () => {
    const report = buildReport(
      input(
        findings({
          readingOrder: [
            { hunkId: "src/util/format.ts#0", attention: 3.1 },
            { hunkId: "src/auth/session.ts#0", attention: 2.9 },
            { hunkId: "db/migrations/007_drop_legacy.sql#0", attention: 0.2 },
          ],
        }),
        {
          tldr: "x",
          verdicts: [
            verdict("src/auth/session.ts", "safety_check_weakened"),
            verdict("db/migrations/007_drop_legacy.sql", "destructive_data", { kind: "gate" }),
          ],
        },
      ),
    );
    expect(report.json.readingOrder.map((entry) => entry.path)).toEqual([
      "db/migrations/007_drop_legacy.sql",
      "src/auth/session.ts",
      "src/util/format.ts",
    ]);
  });
});

test("a hunk that only removes lines shows no bogus line number", () => {
  const removed = hunk("src/old.ts", 0, -1);
  const report = buildReport({
    ...CLEAN,
    hunks: [removed],
    findings: findings({ readingOrder: [{ hunkId: removed.id, attention: 1 }] }),
  });
  expect(report.summary).toContain("1. `src/old.ts` (lines removed)");
});

describe("JSON block", () => {
  test("round-trips and equals the action output", () => {
    const report = buildReport(WARNINGS);
    expect(extractJson(report.summary)).toEqual(report.json);
  });

  test("text that would close the HTML comment early is escaped and still round-trips", () => {
    const hostile = "Ends the comment --> <script>alert(1)</script>";
    const report = buildReport(input(findings(), { tldr: hostile, verdicts: [] }));
    const block = report.summary.slice(report.summary.indexOf("<!-- git-judge:json"));
    expect(block.match(/-->/g)).toHaveLength(1);
    expect(extractJson(report.summary)!.tldr).toBe(hostile);
  });

  test("a comment without the block gives null", () => {
    expect(extractJson(buildDidNotRunReport("down", false).summary)).toBeNull();
  });
});

describe("changes the description does not mention", () => {
  const paths = ["src/auth/session.ts", "test/invoice.test.ts", "src/util/format.ts"];
  const report = buildReport(
    input(findings({ readingOrder: paths.map((path) => ({ hunkId: `${path}#0`, attention: 1 })) }), {
      tldr: "Renames things.",
      verdicts: [
        ...paths.map((path) => verdict(path, "unrelated_to_description")),
        verdict("src/auth/session.ts", "safety_check_weakened"),
      ],
    }),
  );

  test("are reported once in the summary, with the files, not once per hunk", () => {
    expect(report.summary).toMatchSnapshot();
    expect(report.summary.match(/not covered by what the PR says/g)).toHaveLength(1);
    expect(report.summary).toContain("Changes in 3 files");
  });

  test("are not repeated as findings, other findings on the same hunk still are", () => {
    expect(report.summary.match(/\*\*Verify:\*\*/g)).toHaveLength(1);
    expect(report.summary).not.toContain("**Not mentioned in the description** (");
    expect(report.json.verdicts).toHaveLength(4);
  });
});

describe("one complete comment", () => {
  test("every finding carries what changed and what to verify, in reading order", () => {
    const { summary } = buildReport(WARNINGS);
    const first = summary.indexOf("**Safety check weakened** (high) in `src/auth/session.ts` L1-13");
    const second = summary.indexOf("**Test loosened** (medium) in `test/invoice.test.ts` L2-6");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(summary).toContain(
      "L1-13<br>\n  The expiry check on the token claims was removed.<br>\n  **Verify:** Confirm expired tokens are still rejected somewhere else.\n",
    );
  });

  test("unflagged hunks follow under their own heading", () => {
    const { summary } = buildReport(WARNINGS);
    expect(summary).toContain("### Then read\n\n1. `src/util/format.ts` L10");
    expect(buildReport(CLEAN).summary).toContain("### Read in this order\n\n1. `src/util/format.ts` L10");
  });

  test("with the PR URL every location links to its first changed line in the diff", () => {
    const moved = HUNKS.map((entry) =>
      entry.path === "test/invoice.test.ts" ? { ...entry, anchor: { line: 5, side: "LEFT" as const } } : entry,
    );
    const { summary } = buildReport({ ...WARNINGS, hunks: moved, prUrl: "https://github.com/o/r/pull/7" });
    // sha256("src/auth/session.ts") and sha256("test/invoice.test.ts")
    expect(summary).toContain(
      "[`src/auth/session.ts` L1-13](https://github.com/o/r/pull/7/files#diff-947e1ee9f63eea17",
    );
    expect(summary).toMatch(/\[`test\/invoice\.test\.ts` L2-6\]\(https:\/\/github\.com\/o\/r\/pull\/7\/files#diff-[0-9a-f]{64}L5\)/);
    expect(summary).toMatch(/\[`src\/util\/format\.ts` L10\]\(.*#diff-[0-9a-f]{64}R10\)/);
  });

  test("the report has no inline comments to post", () => {
    expect(Object.keys(buildReport(WARNINGS)).sort()).toEqual(["check", "json", "labels", "summary"]);
  });
});

describe("check", () => {
  test.each([
    ["clean", CLEAN, "success", "Nothing flagged"],
    ["warnings", WARNINGS, "success", "2 findings to check"],
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
