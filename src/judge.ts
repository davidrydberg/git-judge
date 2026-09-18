import {
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type { Hunk } from "./diff.js";
import { CODE_QUESTIONS, MISMATCH_QUESTIONS, PR_QUESTIONS } from "./questions.js";

/** The slice of the TypeSafe SDK the judge uses. Tests pass a fake that records requests. */
export interface JudgeClient {
  systemOne<Q extends Questions>(request: SystemOneRequest<Q>): PromiseLike<SystemOneResult<Q>>;
}

export interface PullRequestMeta {
  title: string;
  description: string;
  /** Paths of every changed file, including pre-classified and binary ones. */
  files: string[];
}

export interface JudgeOptions {
  /** Custom noul questions from the policy file, id to wording. They run in call A. */
  customQuestions?: Record<string, string>;
  /** Set when the description is too short to compare against. Call B is not made. */
  skipMismatch?: boolean;
  model?: string;
  concurrency?: number;
}

type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

export interface HunkAnswers {
  code: Answers<typeof CODE_QUESTIONS>;
  /** Probability of yes per custom question id. */
  custom: Record<string, number>;
  mismatch: Answers<typeof MISMATCH_QUESTIONS> | null;
  /** The hunk did not fit the state cap and was judged on its first part only. */
  lowCoverage: boolean;
}

export interface Judgement {
  hunks: Record<string, HunkAnswers>;
  pr: Answers<typeof PR_QUESTIONS>;
  /** The versioned model id that answered, as reported by TypeSafe. */
  model: string;
  requests: number;
  inputTokens: number;
}

// Jev allows 32k tokens for the state plus the longest question, and 64k for the state plus
// all questions. TypeSafe documents no tokenizer, so tokens are estimated from characters.
// Three characters per token overestimates for code, which keeps requests under the cap.
const STATE_AND_LONGEST_QUESTION_TOKENS = 32_000;
const STATE_AND_ALL_QUESTIONS_TOKENS = 64_000;
const CHARS_PER_TOKEN = 3;
const MAX_DESCRIPTION_CHARS = 6_000;
const DEFAULT_CONCURRENCY = 8;
const CUSTOM_PREFIX = "custom:";

export function createJudgeClient(apiKey: string): JudgeClient {
  // The SDK retries 408, 429, and 5xx (which covers 529 Overloaded) with backoff and honours
  // retry-after. A PR fans out into many requests, so allow more attempts than the default 2.
  return new TypeSafeClient({ apiKey, retry: { maxRetries: 4 } });
}

export async function judge(
  client: JudgeClient,
  hunks: Hunk[],
  pr: PullRequestMeta,
  options: JudgeOptions = {},
): Promise<Judgement> {
  const model = options.model ?? "jev-latest";
  const description = pr.description.slice(0, MAX_DESCRIPTION_CHARS);
  const codeQuestions: Questions = { ...CODE_QUESTIONS };
  for (const [id, instructions] of Object.entries(options.customQuestions ?? {})) {
    codeQuestions[CUSTOM_PREFIX + id] = { type: "noul", instructions };
  }

  let requests = 0;
  let inputTokens = 0;
  let answeredBy = model;
  const ask = async <Q extends Questions>(state: SystemOneRequest<Q>["state"], questions: Q) => {
    const result = await client.systemOne({ state, questions, model });
    requests++;
    inputTokens += result.usage.input_tokens;
    answeredBy = result.model;
    for (const [id, question] of Object.entries(questions)) {
      const answer: { type: string } | undefined = result.answers[id];
      if (answer?.type !== question.type) {
        throw new Error(`TypeSafe returned no ${question.type} answer for question "${id}"`);
      }
    }
    return result.answers;
  };

  const judgeHunk = async (hunk: Hunk): Promise<[string, HunkAnswers]> => {
    const codeState = fitDiff({ file: hunk.path, language: hunk.language }, hunk.content, codeQuestions);
    const mismatchState = fitDiff(
      { pr_title: pr.title, pr_description: description, file: hunk.path },
      hunk.content,
      MISMATCH_QUESTIONS,
    );
    const [all, mismatch] = await Promise.all([
      ask(codeState.state, codeQuestions),
      options.skipMismatch ? null : ask(mismatchState.state, MISMATCH_QUESTIONS),
    ]);

    const custom: Record<string, number> = {};
    for (const [key, answer] of Object.entries(all)) {
      if (key.startsWith(CUSTOM_PREFIX) && answer.type === "noul") {
        custom[key.slice(CUSTOM_PREFIX.length)] = answer.noul;
      }
    }
    return [
      hunk.id,
      {
        code: all as unknown as Answers<typeof CODE_QUESTIONS>,
        custom,
        mismatch,
        lowCoverage: codeState.truncated || (!options.skipMismatch && mismatchState.truncated),
      },
    ];
  };

  // Lockfile, generated, and vendored hunks never reach the model.
  const judged = hunks.filter((hunk) => hunk.preClass === null);
  const [perHunk, prAnswers] = await Promise.all([
    mapPool(judged, options.concurrency ?? DEFAULT_CONCURRENCY, judgeHunk),
    ask(fitFileList({ title: pr.title, description }, pr.files), PR_QUESTIONS),
  ]);

  return {
    hunks: Object.fromEntries(perHunk),
    pr: prAnswers,
    model: answeredBy,
    requests,
    inputTokens,
  };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

function stateBudgetChars(questions: Questions): number {
  const sizes = Object.values(questions).map(estimateTokens);
  const tokens = Math.min(
    STATE_AND_LONGEST_QUESTION_TOKENS - Math.max(...sizes),
    STATE_AND_ALL_QUESTIONS_TOKENS - sizes.reduce((sum, size) => sum + size, 0),
  );
  return tokens * CHARS_PER_TOKEN;
}

/** Adds the hunk to the state as `diff`, cut at a line boundary if the state would exceed the cap. */
function fitDiff(
  context: Record<string, string | null>,
  diff: string,
  questions: Questions,
): { state: Record<string, string | null>; truncated: boolean } {
  const budget = stateBudgetChars(questions) - JSON.stringify({ ...context, diff: "" }).length;
  if (JSON.stringify(diff).length <= budget) return { state: { ...context, diff }, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const line of diff.split("\n")) {
    used += JSON.stringify(line).length + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return { state: { ...context, diff: kept.join("\n") }, truncated: true };
}

function fitFileList(
  context: Record<string, string>,
  files: string[],
): Record<string, string | string[]> {
  const budget = stateBudgetChars(PR_QUESTIONS) - JSON.stringify({ ...context, changed_files: [] }).length;
  const kept: string[] = [];
  let used = 0;
  for (const file of files) {
    used += JSON.stringify(file).length + 1;
    if (used > budget) break;
    kept.push(file);
  }
  return { ...context, changed_files: kept };
}

/** Maps with at most `limit` calls in flight. Stops starting new calls once one has failed. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
