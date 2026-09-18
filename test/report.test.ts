import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { HunkAnswers, Judgement } from "../src/judge.js";
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
    evidence: [],
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
    judgement: { model: "jev-1.13.0", inputTokens: 60_000, hunks: {}, pr: PR_ANSWERS },
    durationMs: 3240,
  };
}

const PR_ANSWERS = {
  description_quality: { type: "score", score: 1.62 },
  tests_cover_change: { type: "noul", noul: 0.81 },
} as unknown as Judgement["pr"];

function jevAnswers(nouls: Record<string, number>, options: { unrelated?: number | null; custom?: Record<string, number>; lowCoverage?: boolean } = {}): HunkAnswers {
  const noul = (id: string) => ({ type: "noul", noul: nouls[id] ?? 0.05 });
  const pick = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: {} });
  return {
    code: {
      secret_semantic: noul("secret_semantic"),
      destructive_data: noul("destructive_data"),
      mechanical: noul("mechanical"),
      refactor_changes_behaviour: noul("refactor_changes_behaviour"),
      test_loosened: noul("test_loosened"),
      safety_check_weakened: noul("safety_check_weakened"),
      comment_drift: noul("comment_drift"),
      change_type: pick("refactor", 0.91),
      sensitive_area: pick("auth", 0.77),
      blast_radius: pick("end users", 0.64),
    },
    custom: options.custom ?? {},
    mismatch: options.unrelated === null ? null : { unrelated_to_description: { type: "noul", noul: options.unrelated ?? 0.1 } },
    lowCoverage: options.lowCoverage ?? false,
  } as unknown as HunkAnswers;
}

const CLEAN = input(
  findings({
    readingOrder: [{ hunkId: "src/util/format.ts#0", attention: 1, nearMisses: [] }],
    skipped: { mechanical: 3, lockfile: 1, generated: 0, vendored: 0, overCap: 0 },
  }),
  { usage: {} },
);

const WARNINGS = input(
  findings({
    readingOrder: [
      { hunkId: "src/auth/session.ts#0", attention: 4.8, nearMisses: [] },
      { hunkId: "test/invoice.test.ts#0", attention: 2.4, nearMisses: [] },
      { hunkId: "src/util/format.ts#0", attention: 1, nearMisses: [] },
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
    readingOrder: [{ hunkId: "db/migrations/007_drop_legacy.sql#0", attention: 4, nearMisses: [] }],
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
    readingOrder: [{ hunkId: "src/util/format.ts#0", attention: 1, nearMisses: [] }],
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
      findings: findings({ readingOrder: many.map((entry) => ({ hunkId: entry.id, attention: 1, nearMisses: [] })) }),
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
            { hunkId: "src/util/format.ts#0", attention: 3.1, nearMisses: [] },
            { hunkId: "src/auth/session.ts#0", attention: 2.9, nearMisses: [] },
            { hunkId: "db/migrations/007_drop_legacy.sql#0", attention: 0.2, nearMisses: [] },
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
    findings: findings({ readingOrder: [{ hunkId: removed.id, attention: 1, nearMisses: [] }] }),
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

describe("a report another agent can act on", () => {
  const edit = "@@ -2,3 +2,3 @@\n context\n-expect(total).toBe(100);\n+expect(total).toBeDefined();\n context";
  const idOf = (hunks: Hunk[], hunkId: string) =>
    buildReport({
      ...input(findings(), { verdicts: [verdict("test/invoice.test.ts", "test_loosened", { hunkId })] }),
      hunks,
    }).json.verdicts[0]!.id;

  test("names the commit it judged, in the JSON and in the footer", () => {
    const report = buildReport({ ...WARNINGS, headSha: "0123456789abcdef0123456789abcdef01234567" });
    expect(report.json.headSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(report.summary).toContain("<sub>judged at 0123456 | ");
    expect(buildReport(WARNINGS).json.headSha).toBeNull();
  });

  test("a finding keeps its id when a push moves the hunk without touching its changed lines", () => {
    const before = [hunk("test/invoice.test.ts", 2, 6, { content: edit })];
    const after = [
      hunk("test/invoice.test.ts", 40, 44, {
        id: "test/invoice.test.ts#1",
        content: edit.replace("@@ -2,3 +2,3 @@", "@@ -40,3 +40,3 @@").replaceAll("context", "other context"),
      }),
    ];
    expect(idOf(after, "test/invoice.test.ts#1")).toBe(idOf(before, "test/invoice.test.ts#0"));
  });

  test("a finding gets a new id when its changed lines change", () => {
    const before = [hunk("test/invoice.test.ts", 2, 6, { content: edit })];
    const after = [hunk("test/invoice.test.ts", 2, 6, { content: edit.replace("toBeDefined()", "toBeGreaterThan(0)") })];
    expect(idOf(after, "test/invoice.test.ts#0")).not.toBe(idOf(before, "test/invoice.test.ts#0"));
  });

  test("two flags on one hunk, and the same edit twice in one file, all get different ids", () => {
    const hunks = [
      hunk("test/invoice.test.ts", 2, 6, { content: edit }),
      hunk("test/invoice.test.ts", 40, 44, { id: "test/invoice.test.ts#1", content: edit }),
    ];
    const verdicts = [
      verdict("test/invoice.test.ts", "test_loosened"),
      verdict("test/invoice.test.ts", "comment_drift"),
      verdict("test/invoice.test.ts", "test_loosened", { hunkId: "test/invoice.test.ts#1" }),
    ];
    const ids = buildReport({ ...input(findings(), { verdicts }), hunks }).json.verdicts.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(`${ids[0]}-2`);
  });
});

describe("changes the description does not mention", () => {
  const paths = ["src/auth/session.ts", "test/invoice.test.ts", "src/util/format.ts"];
  const report = buildReport(
    input(findings({ readingOrder: paths.map((path) => ({ hunkId: `${path}#0`, attention: 1, nearMisses: [] })) }), {
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

describe("Jev answers table", () => {
  const judged: ReportInput = {
    ...WARNINGS,
    findings: {
      ...WARNINGS.findings,
      flags: [{ hunkId: "src/auth/session.ts#0", id: "safety_check_weakened", kind: "warning", probability: 0.92, escalate: false }],
    },
    judgement: {
      ...WARNINGS.judgement,
      hunks: {
        "src/auth/session.ts#0": jevAnswers({ safety_check_weakened: 0.92, mechanical: 0.03 }, { lowCoverage: true }),
        "test/invoice.test.ts#0": jevAnswers({ test_loosened: 0.88 }, { unrelated: null, custom: { invoicing: 0.7 } }),
        "db/migrations/007_drop_legacy.sql#0": jevAnswers({ mechanical: 0.97 }),
      },
    },
  };
  const report = buildReport(judged);
  const table = report.summary.slice(report.summary.indexOf("<details>"), report.summary.indexOf("</details>"));

  test("is collapsed, one row per judged hunk, reading order first, then the skipped ones", () => {
    expect(table).toMatchSnapshot();
    const rows = table.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows.map((row) => row.split("`")[1])).toEqual([
      "src/auth/session.ts",
      "test/invoice.test.ts",
      "db/migrations/007_drop_legacy.sql",
    ]);
    expect(rows[2]).toContain("| skip |");
  });

  test("bolds the value that raised a flag, and only that one", () => {
    expect(table.match(/\*\*\d\.\d\d\*\*/g)).toEqual(["**0.92**"]);
  });

  test("shows a dash where a question was not asked, custom questions get a column, a cut hunk is marked", () => {
    const [first, second] = table.split("\n").filter((line) => line.startsWith("| `"));
    expect(table).toContain("| undesc | invoicing | type |");
    expect(second).toContain("| - | 0.70 | refactor 0.91 | auth 0.77 | end users 0.64 |");
    expect(first).toContain("L1-13 (cut) | 4.80 |");
    expect(table).toContain("description quality 1.62 of 2, tests cover the change 0.81");
  });

  test("the same answers are in the JSON block", () => {
    const jev = extractJson(report.summary)!.jev!;
    expect(jev.hunks["src/auth/session.ts#0"]).toMatchObject({
      path: "src/auth/session.ts",
      nouls: { safety_check_weakened: 0.92, unrelated_to_description: 0.1 },
      changeType: { choice: "refactor", confidence: 0.91 },
      lowCoverage: true,
    });
    expect(jev.pr).toEqual({ descriptionQuality: 1.62, testsCoverChange: 0.81 });
  });

  test("nothing judged means no table", () => {
    expect(buildReport(WARNINGS).summary).not.toContain("<details>");
  });

  test("a comment too large for GitHub drops the raw answers from the JSON, keeps the capped table", () => {
    const many = Array.from({ length: 200 }, (_, index) => hunk(`src/some/deeply/nested/module/path/file${index}.ts`, 1, 5));
    const big = buildReport({
      ...CLEAN,
      hunks: many,
      findings: findings({ readingOrder: many.map((entry) => ({ hunkId: entry.id, attention: 1, nearMisses: [] })) }),
      judgement: { ...CLEAN.judgement, hunks: Object.fromEntries(many.map((entry) => [entry.id, jevAnswers({})])) },
      prUrl: "https://github.com/owner/repository/pull/123",
    });
    expect(big.summary.length).toBeLessThan(65_536);
    expect(extractJson(big.summary)!.jev).toBeNull();
    expect(big.json.jev).not.toBeNull();
    expect(big.summary.split("\n").filter((line) => line.startsWith("| [`"))).toHaveLength(60);
    expect(big.summary).toContain("And 140 more hunks");
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

  test("an unflagged hunk says why it is on the list, from Jev's answers and what came close to a flag", () => {
    const report = buildReport({
      ...input(
        findings({
          readingOrder: [
            {
              hunkId: "src/auth/session.ts#0",
              attention: 2,
              nearMisses: [{ id: "safety_check_weakened", probability: 0.44, threshold: 0.6 }],
            },
            { hunkId: "src/util/format.ts#0", attention: 1, nearMisses: [] },
          ],
        }),
      ),
      judgement: {
        model: "jev-1.13.0",
        inputTokens: 1000,
        pr: PR_ANSWERS,
        hunks: { "src/auth/session.ts#0": jevAnswers({}) },
      },
    });
    const row = report.json.jev!.hunks["src/auth/session.ts#0"]!;
    expect(report.summary).toContain(
      `1. \`src/auth/session.ts\` L1-13 - ${row.changeType.choice}, touches auth, ${row.blastRadius.choice} would notice. Close to a flag: safety check weakened 0.44, flags at 0.6`,
    );
    // No Jev answers for this hunk, so there is nothing true to say about it.
    expect(report.summary).toContain("2. `src/util/format.ts` L10\n");
  });

  test("a finding shows its evidence as a diff block that the quoted code cannot close", () => {
    const evidence = ["-  if (expired(token)) throw new Error();", "+  const note = `a ``` fence`;"];
    const report = buildReport(
      input(findings({ readingOrder: [{ hunkId: "src/auth/session.ts#0", attention: 2, nearMisses: [] }] }), {
        verdicts: [verdict("src/auth/session.ts", "safety_check_weakened", { evidence })],
      }),
    );
    expect(report.summary).toContain(
      ["**Verify:** Check src/auth/session.ts before approving.", "", "  ````diff", `  ${evidence[0]}`, `  ${evidence[1]}`, "  ````"].join("\n"),
    );
    expect(report.json.verdicts[0]!.evidence).toEqual(evidence);
  });

  test("a near miss shows the hunk's changed lines, cut short, and never for a possible secret", () => {
    const changed = Array.from({ length: 10 }, (_, index) => `+line ${index}`);
    const hunks = [hunk("src/util/format.ts", 10, 20, { content: ["@@ -1 +1,10 @@", " context", ...changed].join("\n") })];
    const render = (id: "safety_check_weakened" | "secret_semantic") =>
      buildReport({
        ...input(
          findings({
            readingOrder: [
              { hunkId: "src/util/format.ts#0", attention: 1, nearMisses: [{ id, probability: 0.5, threshold: 0.9 }] },
            ],
          }),
        ),
        hunks,
      }).summary;

    const shown = render("safety_check_weakened");
    expect(shown).toContain(["   ```diff", "   +line 0"].join("\n"));
    expect(shown).toContain(["   +line 7", "     ... 2 more changed lines", "   ```"].join("\n"));
    expect(shown).not.toContain(" context");
    expect(render("secret_semantic")).not.toContain("+line 0");
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
