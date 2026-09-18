// Runs the real pipeline on a local diff file with the keys from .env and prints the summary comment.
// Usage: npm run try -- path/to/file.diff ["PR title"] ["PR description"]
// Nothing is posted to GitHub.

import { readFileSync } from "node:fs";
import { createGenerator } from "../src/generators.js";
import { createJudgeClient, estimateTokens, REQUEST_OVERHEAD_TOKENS, type JudgeClient } from "../src/judge.js";
import { runPipeline } from "../src/pipeline.js";
import { parsePolicy } from "../src/policy.js";

const [diffPath, title = "Untitled", description = ""] = process.argv.slice(2);
if (!diffPath) throw new Error('Usage: npm run try -- path/to/file.diff ["PR title"] ["PR description"]');
const typesafeKey = process.env.TYPESAFE_API_KEY;
if (!typesafeKey) throw new Error("TYPESAFE_API_KEY is empty in .env");

// Compares the character-based token estimate in judge.ts with what TypeSafe actually counted.
let estimated = 0;
let actual = 0;
const real = createJudgeClient(typesafeKey);
const measuring: JudgeClient = {
  async systemOne(request) {
    const result = await real.systemOne(request);
    estimated += estimateTokens(request.state) + estimateTokens(request.questions) + REQUEST_OVERHEAD_TOKENS;
    actual += result.usage.input_tokens;
    return result;
  },
};

const policy = parsePolicy("");
const report = await runPipeline({
  diff: readFileSync(diffPath, "utf8"),
  title,
  description,
  policy,
  judgeClient: measuring,
  generator: createGenerator(policy.generator.model, {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  }),
  now: Date.now,
});

console.log(report.summary.slice(0, report.summary.indexOf("<!-- git-judge:json")));
console.log(`Check: ${report.check.conclusion} - ${report.check.title}`);
console.log(`Labels: ${report.labels.join(", ")}`);
console.log(`Jev tokens: estimated ${estimated}, actual ${actual} (estimate is ${(estimated / actual).toFixed(2)}x)`);
