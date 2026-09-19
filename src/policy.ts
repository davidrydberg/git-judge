import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Hunk } from "./diff.js";
import type { HunkAnswers, Judgement } from "./judge.js";
import { GATES, type GateId } from "./questions.js";

const probability = z.number().min(0).max(1);
const weight = z.number().min(0);

const AREAS = ["auth", "payments", "data_migration", "public_api", "none"] as const;
const BLAST_RADII = ["nobody", "other developers", "end users", "money or data"] as const;

// Every number below is a guess until the calibrate command exists.
// Jev's calibration differs per repo and per language, so expect to tune these.
const policySchema = z.strictObject({
  thresholds: z
    .strictObject({
      gates: z
        .strictObject({
          secret_semantic: probability.default(0.9),
          destructive_data: probability.default(0.9),
        })
        .prefault({}),
      warnings: z
        .strictObject({
          test_loosened: probability.default(0.6),
          safety_check_weakened: probability.default(0.6),
          refactor_changes_behaviour: probability.default(0.6),
          comment_drift: probability.default(0.7),
          unrelated_to_description: probability.default(0.7),
        })
        .prefault({}),
      /** Warn when the description scores below this. 0 is generic, 2 states what changed and why. */
      descriptionQuality: z.number().min(0).max(2).default(1),
      /** Warn when the probability that tests cover the change is below this. */
      testsCoverChange: probability.default(0.3),
      /** A choice answer counts for labels and cross rules only at or above this confidence. */
      choiceConfidence: probability.default(0.5),
    })
    .prefault({}),
  weights: z
    .strictObject({
      area: z
        .strictObject({
          auth: weight.default(2),
          payments: weight.default(2),
          data_migration: weight.default(2),
          public_api: weight.default(1.5),
          none: weight.default(1),
        })
        .prefault({}),
      blastRadius: z
        .strictObject({
          nobody: weight.default(0.5),
          "other developers": weight.default(1),
          "end users": weight.default(1.5),
          "money or data": weight.default(2),
        })
        .prefault({}),
      /** Scales area and blast radius for a hunk in a test file. A loosened test still counts in full. */
      testFile: weight.default(0.5),
    })
    .prefault({}),
  /** Hunks scoring below this are counted as mechanical. Set to 0 to rank every hunk and let every warning fire on it. */
  minAttention: z.number().min(0).default(0.5),
  /** Below this many characters the description is treated as missing. */
  minDescriptionLength: z.number().int().min(0).default(30),
  maxHunks: z.number().int().min(1).default(200),
  /** Upper bound of changed lines per size label. Anything larger is XL. */
  sizeLabels: z
    .strictObject({
      S: z.number().int().default(50),
      M: z.number().int().default(250),
      L: z.number().int().default(1000),
    })
    .prefault({}),
  exclude: z
    .strictObject({
      generated: z.array(z.string()).default([]),
      vendored: z.array(z.string()).default([]),
    })
    .prefault({}),
  judge: z.strictObject({ model: z.string().default("jev-latest") }).prefault({}),
  generator: z
    .strictObject({
      model: z.string().default("gpt-5.6-luna"),
      /** Off by default. When set, flags in these areas or blast radii go to the stronger model. */
      escalation: z
        .strictObject({
          model: z.string().default("claude-opus-5"),
          areas: z.array(z.enum(AREAS)).default([]),
          blastRadius: z.array(z.enum(BLAST_RADII)).default([]),
        })
        .nullable()
        .default(null),
    })
    .prefault({}),
  customQuestions: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/),
        question: z.string().min(1),
        threshold: probability.default(0.6),
        label: z.string().min(1).optional(),
      }),
    )
    .default([]),
  failOnError: z.boolean().default(false),
});

export type Policy = z.infer<typeof policySchema>;

/** Parses the policy file. An empty or missing file gives the defaults. Unknown keys are errors. */
export function parsePolicy(yaml: string): Policy {
  const parsed = policySchema.safeParse(parseYaml(yaml) ?? {});
  if (!parsed.success) throw new Error(`Invalid git-judge policy:\n${z.prettifyError(parsed.error)}`);
  const ids = parsed.data.customQuestions.map((question) => question.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Invalid git-judge policy:\ncustom question id "${duplicate}" is used twice`);
  return parsed.data;
}

export type WarningId =
  | "test_loosened"
  | "safety_check_weakened"
  | "refactor_changes_behaviour"
  | "comment_drift"
  | "unrelated_to_description";

export interface Flag {
  hunkId: string;
  /** A gate id, a warning id, or "custom:<id>" for a question from the policy file. */
  id: GateId | WarningId | `custom:${string}`;
  kind: "gate" | "warning";
  probability: number;
  /** Send this flag to the escalation generator instead of the default one. */
  escalate: boolean;
}

export type PrWarning =
  | { id: "no_description" }
  | { id: "weak_description"; score: number }
  | { id: "tests_missing"; probability: number }
  | { id: "split_suggested"; changeTypes: string[] };

/** A question that scored under its threshold but close enough to tell the reader what to look for. */
export interface NearMiss {
  id: Flag["id"];
  probability: number;
  threshold: number;
}

export interface Findings {
  flags: Flag[];
  prWarnings: PrWarning[];
  /** Hunks worth reading, most important first. */
  readingOrder: {
    hunkId: string;
    attention: number;
    nearMisses: NearMiss[];
    /** Jev's picks for the hunk, each null when it was not confident enough to be repeated to a reader. */
    changeType: string | null;
    area: string | null;
    blastRadius: string | null;
  }[];
  skipped: { mechanical: number; lockfile: number; generated: number; vendored: number; overCap: number };
  lowCoverage: string[];
  labels: string[];
  conclusion: "success" | "failure";
}

export function hasUsableDescription(description: string, policy: Policy): boolean {
  return description.trim().length >= policy.minDescriptionLength;
}

/** Splits hunks into those sent to the judge and those left out by the hunk cap, in diff order. */
export function selectForJudging(hunks: Hunk[], policy: Policy): { judged: Hunk[]; overCap: Hunk[] } {
  const candidates = hunks.filter((hunk) => hunk.preClass === null);
  return { judged: candidates.slice(0, policy.maxHunks), overCap: candidates.slice(policy.maxHunks) };
}

/** A hunk counts as a refactor only when Jev picks that type with enough confidence. */
function claimsRefactor(answers: HunkAnswers, policy: Policy): boolean {
  const type = answers.code.change_type;
  return type.choice === "refactor" && type.confidence >= policy.thresholds.choiceConfidence;
}

export function attention(answers: HunkAnswers, policy: Policy, isTest = false): number {
  const { code } = answers;
  // Every feature and bugfix changes behaviour, and Jev says so at 0.95. Counted for all hunks it
  // drowned out the other two signals, so it counts only where it is a finding: inside a refactor.
  const judgement = Math.max(
    code.test_loosened.noul,
    code.safety_check_weakened.noul,
    claimsRefactor(answers, policy) ? code.refactor_changes_behaviour.noul : 0,
  );
  // A test that mentions auth is not auth code. Where scores are close, which is most PRs, tests
  // were outranking the production code they cover. The judgement term is left alone.
  return (
    (isTest ? policy.weights.testFile : 1) *
      (1 - code.mechanical.noul) *
      expectedWeight(code.sensitive_area.probabilities, policy.weights.area) *
      expectedWeight(code.blast_radius.probabilities, policy.weights.blastRadius) +
    2 * judgement
  );
}

// The probability-weighted weight, not the weight of the top option, so a hunk that is
// 51% auth and one that is 49% auth score almost the same instead of jumping a whole weight.
function expectedWeight<K extends string>(
  probabilities: Readonly<Record<K, number>>,
  weights: Readonly<Record<K, number>>,
): number {
  let sum = 0;
  for (const option of Object.keys(weights) as K[]) sum += probabilities[option] * weights[option];
  return sum;
}

// Tests and docs accompany any kind of change, so they never count towards a split.
const SPLITTABLE_TYPES = new Set(["feature", "bugfix", "refactor", "chore"]);

// A score from this share of its threshold up to the threshold is a near miss. It raises nothing
// and costs nothing, it only tells the reader why a hunk with no finding is still worth a look.
const NEAR_MISS_SHARE = 0.5;

export function evaluate(
  hunks: Hunk[],
  judgement: Judgement,
  description: string,
  policy: Policy,
): Findings {
  const judged = hunks.flatMap((hunk) => {
    const answers = judgement.hunks[hunk.id];
    return answers ? [{ hunk, answers, attention: attention(answers, policy, hunk.isTest) }] : [];
  });
  const confident = (answer: { confidence: number }) =>
    answer.confidence >= policy.thresholds.choiceConfidence;
  const sure = (answer: { choice: string; confidence: number }) => (confident(answer) ? answer.choice : null);

  const flags: Flag[] = [];
  const gated = new Set<string>();
  const nearMisses = new Map<string, NearMiss[]>();
  const nearMiss = (hunkId: string, id: Flag["id"], probability: number, threshold: number) => {
    if (probability < threshold * NEAR_MISS_SHARE) return;
    nearMisses.set(hunkId, [...(nearMisses.get(hunkId) ?? []), { id, probability, threshold }]);
  };
  for (const { hunk, answers } of judged) {
    // Gates compare a probability with a threshold and nothing else. The generator writes about
    // a gate flag but cannot clear it, since it reads the same author-controlled code.
    for (const id of GATES) {
      const probability = answers.code[id].noul;
      if (probability >= policy.thresholds.gates[id]) {
        flags.push({ hunkId: hunk.id, id, kind: "gate", probability, escalate: escalates(answers, policy) });
        gated.add(hunk.id);
      } else {
        nearMiss(hunk.id, id, probability, policy.thresholds.gates[id]);
      }
    }
  }

  const reading = judged
    .filter((entry) => entry.attention >= policy.minAttention || gated.has(entry.hunk.id))
    .sort(
      (a, b) =>
        Number(gated.has(b.hunk.id)) - Number(gated.has(a.hunk.id)) || b.attention - a.attention,
    );

  for (const { hunk, answers } of reading) {
    const warn = (id: Flag["id"], probability: number, threshold: number) => {
      if (probability >= threshold) {
        flags.push({ hunkId: hunk.id, id, kind: "warning", probability, escalate: escalates(answers, policy) });
        // The description flag is a statement about the PR, so a near miss on it says nothing about this hunk.
      } else if (id !== "unrelated_to_description") {
        nearMiss(hunk.id, id, probability, threshold);
      }
    };
    const { code, mismatch, custom } = answers;
    const thresholds = policy.thresholds.warnings;
    warn("test_loosened", code.test_loosened.noul, thresholds.test_loosened);
    // In a test file a weakened check is a loosened test, which is already its own flag.
    if (!hunk.isTest) {
      warn("safety_check_weakened", code.safety_check_weakened.noul, thresholds.safety_check_weakened);
    }
    warn("comment_drift", code.comment_drift.noul, thresholds.comment_drift);
    // Changing behaviour is only worth a warning when the hunk presents itself as a refactor.
    if (claimsRefactor(answers, policy)) {
      warn(
        "refactor_changes_behaviour",
        code.refactor_changes_behaviour.noul,
        thresholds.refactor_changes_behaviour,
      );
    }
    if (mismatch) {
      warn("unrelated_to_description", mismatch.unrelated_to_description.noul, thresholds.unrelated_to_description);
    }
    for (const question of policy.customQuestions) {
      const probability = custom[question.id];
      if (probability !== undefined) warn(`custom:${question.id}`, probability, question.threshold);
    }
  }

  const prWarnings: PrWarning[] = [];
  if (!hasUsableDescription(description, policy)) {
    prWarnings.push({ id: "no_description" });
  } else {
    const { score } = judgement.pr.description_quality;
    if (score < policy.thresholds.descriptionQuality) prWarnings.push({ id: "weak_description", score });
    const covered = judgement.pr.tests_cover_change.noul;
    if (covered < policy.thresholds.testsCoverChange) {
      prWarnings.push({ id: "tests_missing", probability: covered });
    }
  }
  const changeTypes = new Set(
    reading
      .map(({ answers }) => answers.code.change_type)
      .filter((answer) => confident(answer) && SPLITTABLE_TYPES.has(answer.choice))
      .map((answer) => answer.choice),
  );
  if (changeTypes.size >= 3) prWarnings.push({ id: "split_suggested", changeTypes: [...changeTypes].sort() });

  const count = (preClass: Hunk["preClass"]) => hunks.filter((hunk) => hunk.preClass === preClass).length;
  const unjudged = hunks.filter((hunk) => hunk.preClass === null && !judgement.hunks[hunk.id]);

  return {
    flags,
    prWarnings,
    readingOrder: reading.map((entry) => ({
      hunkId: entry.hunk.id,
      attention: entry.attention,
      nearMisses: nearMisses.get(entry.hunk.id) ?? [],
      changeType: sure(entry.answers.code.change_type),
      area: sure(entry.answers.code.sensitive_area),
      blastRadius: sure(entry.answers.code.blast_radius),
    })),
    skipped: {
      mechanical: judged.length - reading.length,
      lockfile: count("lockfile"),
      generated: count("generated"),
      vendored: count("vendored"),
      overCap: unjudged.length,
    },
    lowCoverage: judged.filter((entry) => entry.answers.lowCoverage).map((entry) => entry.hunk.id),
    labels: labels(hunks, reading, flags, policy),
    conclusion: gated.size > 0 ? "failure" : "success",
  };
}

function escalates(answers: HunkAnswers, policy: Policy): boolean {
  const { escalation } = policy.generator;
  if (!escalation) return false;
  return (
    escalation.areas.includes(answers.code.sensitive_area.choice) ||
    escalation.blastRadius.includes(answers.code.blast_radius.choice)
  );
}

function labels(
  hunks: Hunk[],
  reading: { hunk: Hunk; answers: HunkAnswers }[],
  flags: Flag[],
  policy: Policy,
): string[] {
  const result = new Set<string>();
  const sizeByType = new Map<string, number>();
  for (const { hunk, answers } of reading) {
    const { sensitive_area: area, change_type: type } = answers.code;
    if (area.choice !== "none" && area.confidence >= policy.thresholds.choiceConfidence) {
      result.add(`area: ${area.choice}`);
    }
    sizeByType.set(type.choice, (sizeByType.get(type.choice) ?? 0) + hunk.size);
  }
  const dominant = [...sizeByType].sort((a, b) => b[1] - a[1])[0];
  if (dominant) result.add(`type: ${dominant[0]}`);

  const changed = hunks
    .filter((hunk) => hunk.preClass === null)
    .reduce((sum, hunk) => sum + hunk.size, 0);
  const { S, M, L } = policy.sizeLabels;
  result.add(`size: ${changed <= S ? "S" : changed <= M ? "M" : changed <= L ? "L" : "XL"}`);

  for (const question of policy.customQuestions) {
    if (question.label && flags.some((flag) => flag.id === `custom:${question.id}`)) result.add(question.label);
  }
  return [...result].sort();
}
