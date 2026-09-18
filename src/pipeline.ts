import { parseDiff } from "./diff.js";
import { judge, type JudgeClient } from "./judge.js";
import { evaluate, hasUsableDescription, selectForJudging, type Policy } from "./policy.js";
import { buildReport, type Report } from "./report.js";
import { write, type Generator } from "./writer.js";

export interface PipelineInput {
  diff: string;
  title: string;
  description: string;
  policy: Policy;
  judgeClient: JudgeClient;
  generator: Generator;
  escalationGenerator?: Generator | undefined;
  /** Milliseconds clock, injected so the reported duration is testable. */
  now: () => number;
}

/** Diff in, report out. Touches no network except through the injected clients. */
export async function runPipeline(input: PipelineInput): Promise<Report> {
  const started = input.now();
  const { policy, title, description } = input;

  const { files, hunks } = parseDiff(input.diff, policy.exclude);
  const { judged } = selectForJudging(hunks, policy);
  const judgement = await judge(
    input.judgeClient,
    judged,
    { title, description, files: files.map((file) => file.path) },
    {
      customQuestions: Object.fromEntries(policy.customQuestions.map((question) => [question.id, question.question])),
      skipMismatch: !hasUsableDescription(description, policy),
      model: policy.judge.model,
    },
  );
  const findings = evaluate(hunks, judgement, description, policy);

  const typesByFile = new Map<string, Set<string>>();
  for (const hunk of judged) {
    const type = judgement.hunks[hunk.id]?.code.change_type.choice;
    if (type) typesByFile.set(hunk.path, (typesByFile.get(hunk.path) ?? new Set()).add(type));
  }
  const overview = [...typesByFile].map(([path, types]) => ({ path, changeTypes: [...types].sort() }));

  const written = await write({
    flags: findings.flags,
    overview,
    hunks,
    title,
    description,
    policy,
    generator: input.generator,
    escalationGenerator: input.escalationGenerator,
  });
  return buildReport({ hunks, findings, written, judgement, durationMs: input.now() - started });
}
