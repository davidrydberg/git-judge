import { readFileSync } from "node:fs";
import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import { expect, test } from "vitest";
import type { JudgeClient } from "../src/judge.js";
import { runPipeline } from "../src/pipeline.js";
import { parsePolicy } from "../src/policy.js";
import type { Generator } from "../src/writer.js";

const MIXED = readFileSync(new URL("./fixtures/mixed.diff", import.meta.url), "utf8");

/** Probability of yes per file and noul id. Everything not listed is 0.05, and every hunk is mechanical unless listed. */
const NOULS: Record<string, Record<string, number>> = {
  "src/auth/session.ts": { mechanical: 0.05, safety_check_weakened: 0.92, refactor_changes_behaviour: 0.9 },
  "test/invoice.test.ts": { mechanical: 0.1, test_loosened: 0.88 },
  "schema.sql": { mechanical: 0.2 },
};
const CHOICES: Record<string, Record<string, string>> = {
  "src/auth/session.ts": { change_type: "refactor", sensitive_area: "auth", blast_radius: "end users" },
  "test/invoice.test.ts": { change_type: "test" },
};

function fakeJudge(overrides: Record<string, Record<string, number>> = {}) {
  const seenFiles = new Set<string>();
  const client: JudgeClient = {
    async systemOne(request: SystemOneRequest) {
      const file = String((request.state as Record<string, unknown>).file ?? "");
      if (file) seenFiles.add(file);
      const answers = Object.fromEntries(
        Object.entries(request.questions as Questions).map(([id, question]) => {
          if (question.type === "noul") {
            const fallback = id === "mechanical" ? 0.95 : 0.05;
            return [id, { type: "noul", noul: overrides[file]?.[id] ?? NOULS[file]?.[id] ?? fallback }];
          }
          if (question.type === "choice") {
            const options = Object.keys(question.criteria);
            const chosen = CHOICES[file]?.[id] ?? (id === "sensitive_area" ? "none" : options[options.length - 1]!);
            const probabilities = Object.fromEntries(options.map((option) => [option, option === chosen ? 1 : 0]));
            return [id, { type: "choice", choice: chosen, confidence: 0.9, probabilities }];
          }
          return [id, { type: "score", score: 1.8, confidence: 0.8, legend: {}, probabilities: {} }];
        }),
      );
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 400, output_tokens: 0 } } as never;
    },
  };
  return { client, seenFiles };
}

const tldrPrompts: string[] = [];
const generator: Generator = {
  model: "gpt-5.6-luna",
  async generate(request) {
    if (request.schemaName === "tldr") tldrPrompts.push(request.prompt);
    const value =
      request.schemaName === "tldr"
        ? { tldr: "Removes the token expiry check under the name of a refactor." }
        : { confirmed: true, severity: "high", what_changed: "A check was removed.", what_to_verify: "Confirm it is enforced elsewhere." };
    return { value: request.schema.parse(value), inputTokens: 300, outputTokens: 40 };
  },
};

function run(judgeClient: JudgeClient) {
  const clock = [1000, 4500];
  return runPipeline({
    diff: MIXED,
    title: "Refactor session handling",
    description: "Pure refactor of session handling. No behaviour change. Also tidies the invoice test.",
    policy: parsePolicy(""),
    judgeClient,
    generator,
    now: () => clock.shift()!,
  });
}

test("a mixed PR: the auth change and the loosened test are read first, the rest is set aside", async () => {
  const { client, seenFiles } = fakeJudge();
  const report = await run(client);

  expect(report.json.readingOrder.map((entry) => entry.path)).toEqual([
    "src/auth/session.ts",
    "test/invoice.test.ts",
    "schema.sql",
  ]);
  expect(report.json.verdicts.map((verdict) => [verdict.path, verdict.flagId])).toEqual([
    ["src/auth/session.ts", "safety_check_weakened"],
    ["src/auth/session.ts", "refactor_changes_behaviour"],
    ["test/invoice.test.ts", "test_loosened"],
  ]);
  expect(report.json.verdicts[0]!.anchor).toEqual({ line: 1, side: "LEFT" });
  expect(report.json.skipped).toEqual({ mechanical: 4, lockfile: 0, generated: 0, vendored: 1, overCap: 0 });
  expect(report.labels).toEqual(["area: auth", "size: S", "type: refactor"]);
  expect(report.check).toMatchObject({ conclusion: "success", title: "3 findings to check" });
  expect(tldrPrompts.at(-1)).toContain("- src/auth/session.ts: refactor");
  expect(tldrPrompts.at(-1)).toContain("- test/invoice.test.ts: test");
  expect(tldrPrompts.at(-1)).not.toContain("vendor/lib/index.js");
  expect(report.json.durationMs).toBe(3500);
  expect(report.summary).toContain("<summary>Jev answers for 7 hunks</summary>");
  expect(report.summary).toMatch(/\| `src\/auth\/session\.ts` L1-13 \| \d\.\d\d \| 0\.05 \| .*\*\*0\.92\*\* .*\| refactor 0\.90 \| auth 0\.90 \|/);
  expect(seenFiles.has("vendor/lib/index.js")).toBe(false);
  expect(seenFiles.has("assets/logo.png")).toBe(false);
});

test("a secret in an otherwise mechanical hunk fails the check", async () => {
  const { client } = fakeJudge({ "src/legacy.txt": { secret_semantic: 0.97 } });
  const report = await run(client);

  expect(report.check).toMatchObject({ conclusion: "failure", title: "Blocked: possible secret" });
  expect(report.json.readingOrder[0]!.path).toBe("src/legacy.txt");
  expect(report.summary).toContain("### Blocking");
});
