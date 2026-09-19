// Pure scoring for `npm run eval`: one case's labels against one report. No network, unit-tested.

import type { Hunk } from "../src/diff.js";
import type { ReportJson } from "../src/report.js";

/** A hunk is named by its file and a string its diff contains, so a label survives a regenerated diff. */
export interface HunkRef {
  path: string;
  contains: string;
}

export interface EvalCase {
  title: string;
  description: string;
  /** Hunks a careful human reviewer has to read. The report should put them near the top. */
  mustRead: HunkRef[];
  /** Findings that are true. A confirmed verdict that is not listed here or in `acceptable` is a false positive. */
  flags: (HunkRef & { id: string })[];
  /** Verdicts that are defensible but not required. They count neither for nor against. */
  acceptable?: (HunkRef & { id: string })[];
}

export interface CaseScore {
  mustRead: number;
  /** Must-read hunks within the first five and the first ten entries of the reading order. */
  inTop5: number;
  inTop10: number;
  /** 1-based rank per must-read hunk, null when the hunk is not in the reading order at all. */
  ranks: (number | null)[];
  expectedFlags: number;
  truePositives: number;
  falsePositives: string[];
  missedFlags: string[];
}

export function resolve(ref: HunkRef, hunks: Hunk[]): Hunk {
  const found = hunks.filter((hunk) => hunk.path === ref.path && hunk.content.includes(ref.contains));
  if (found.length !== 1) {
    throw new Error(`"${ref.contains}" in ${ref.path} matches ${found.length} hunks, a label must match exactly one`);
  }
  return found[0]!;
}

export function scoreCase(spec: EvalCase, hunks: Hunk[], json: ReportJson): CaseScore {
  const order = json.readingOrder.map((entry) => entry.hunkId);
  const ranks = spec.mustRead.map((ref) => {
    const index = order.indexOf(resolve(ref, hunks).id);
    return index === -1 ? null : index + 1;
  });
  const within = (limit: number) => ranks.filter((rank) => rank !== null && rank <= limit).length;

  const key = (hunkId: string, id: string) => `${hunkId}|${id}`;
  const label = (ref: HunkRef & { id: string }) => key(resolve(ref, hunks).id, ref.id);
  const expected = new Set(spec.flags.map(label));
  const acceptable = new Set((spec.acceptable ?? []).map(label));
  const raised = new Set(json.verdicts.map((verdict) => key(verdict.hunkId, verdict.flagId)));

  return {
    mustRead: spec.mustRead.length,
    inTop5: within(5),
    inTop10: within(10),
    ranks,
    expectedFlags: expected.size,
    truePositives: [...expected].filter((flag) => raised.has(flag)).length,
    falsePositives: [...raised].filter((flag) => !expected.has(flag) && !acceptable.has(flag)),
    missedFlags: [...expected].filter((flag) => !raised.has(flag)),
  };
}

export interface Totals {
  cases: number;
  recallTop5: number;
  recallTop10: number;
  flagRecall: number;
  flagPrecision: number;
}

/** A ratio with nothing to measure is 1: a suite with no expected flags has missed none. */
export function totals(scores: CaseScore[]): Totals {
  const sum = (pick: (score: CaseScore) => number) => scores.reduce((total, score) => total + pick(score), 0);
  const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);
  const truePositives = sum((score) => score.truePositives);
  return {
    cases: scores.length,
    recallTop5: ratio(sum((score) => score.inTop5), sum((score) => score.mustRead)),
    recallTop10: ratio(sum((score) => score.inTop10), sum((score) => score.mustRead)),
    flagRecall: ratio(truePositives, sum((score) => score.expectedFlags)),
    flagPrecision: ratio(truePositives, truePositives + sum((score) => score.falsePositives.length)),
  };
}
