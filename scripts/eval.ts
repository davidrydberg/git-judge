// Runs the real pipeline over every case in eval/cases and scores it against the case's labels.
// Usage: npm run eval -- [--label name] [--policy path/to/policy.yml] [--case name]
// Every model answer is cached in eval/.cache by request, so a rerun after a policy change is free
// and a rerun after a question change pays only for what the change touched. Nothing is posted.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff } from "../src/diff.js";
import { createGenerator } from "../src/generators.js";
import { createJudgeClient, type JudgeClient } from "../src/judge.js";
import { runPipeline } from "../src/pipeline.js";
import { parsePolicy } from "../src/policy.js";
import type { Generator } from "../src/writer.js";
import { scoreCase, totals, type CaseScore, type EvalCase } from "./eval-score.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const typesafeKey = process.env.TYPESAFE_API_KEY;
if (!typesafeKey) throw new Error("TYPESAFE_API_KEY is empty in .env");

const CASES = "eval/cases";
const CACHE = "eval/.cache";
mkdirSync(CACHE, { recursive: true });
let cacheHits = 0;
let cacheMisses = 0;

async function cached<T>(request: unknown, call: () => Promise<T>): Promise<T> {
  const file = join(CACHE, `${createHash("sha256").update(JSON.stringify(request)).digest("hex")}.json`);
  if (existsSync(file)) {
    cacheHits++;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  cacheMisses++;
  const result = await call();
  writeFileSync(file, JSON.stringify(result));
  return result;
}

const realJudge = createJudgeClient(typesafeKey);
const judgeClient: JudgeClient = {
  systemOne: (request) => cached(request, async () => await realJudge.systemOne(request)),
};

const policy = parsePolicy(option("policy") ? readFileSync(option("policy")!, "utf8") : "");
const realGenerator = createGenerator(policy.generator.model, {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
});
const generator: Generator = {
  model: realGenerator.model,
  generate: ({ schema, ...request }) =>
    cached({ model: realGenerator.model, ...request }, () => realGenerator.generate({ schema, ...request })),
};

const only = option("case");
const names = readdirSync(CASES).filter((name) => existsSync(join(CASES, name, "case.json")) && (!only || name === only));
const results: { name: string; score: CaseScore; costUsd: number | null }[] = [];
for (const name of names) {
  const spec = JSON.parse(readFileSync(join(CASES, name, "case.json"), "utf8")) as EvalCase;
  const diff = readFileSync(join(CASES, name, "pr.diff"), "utf8");
  const report = await runPipeline({
    diff,
    title: spec.title,
    description: spec.description,
    policy,
    judgeClient,
    generator,
    now: Date.now,
  });
  const score = scoreCase(spec, parseDiff(diff, policy.exclude).hunks, report.json);
  results.push({ name, score, costUsd: report.json.costUsd });
}

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
console.log("case | must-read ranks | top5 | top10 | flags hit | missed | false positives");
console.log("---|---|---|---|---|---|---");
for (const { name, score } of results) {
  console.log(
    [
      name,
      score.ranks.map((rank) => rank ?? "-").join(", ") || "none",
      `${score.inTop5}/${score.mustRead}`,
      `${score.inTop10}/${score.mustRead}`,
      `${score.truePositives}/${score.expectedFlags}`,
      score.missedFlags.join(" ") || "-",
      score.falsePositives.join(" ") || "-",
    ].join(" | "),
  );
}
const all = totals(results.map((result) => result.score));
const cost = results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
console.log(
  `\n${all.cases} cases | must-read in top 5: ${percent(all.recallTop5)}, in top 10: ${percent(all.recallTop10)} | flag recall ${percent(all.flagRecall)}, precision ${percent(all.flagPrecision)}`,
);
console.log(`cost at list price $${cost.toFixed(4)} | cache: ${cacheHits} hits, ${cacheMisses} paid requests`);

const label = option("label");
if (label) {
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(`eval/results/${label}.json`, `${JSON.stringify({ totals: all, results }, null, 2)}\n`);
}
