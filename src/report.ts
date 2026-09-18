import { createHash } from "node:crypto";
import type { Anchor, Hunk } from "./diff.js";
import type { Judgement } from "./judge.js";
import type { Findings, PrWarning } from "./policy.js";
import type { Verdict, Written } from "./writer.js";

export const SUMMARY_MARKER = "<!-- git-judge:summary -->";
const JSON_OPEN = "<!-- git-judge:json";
const MAX_FLAGGED_LISTED = 15;
const MAX_UNFLAGGED_LISTED = 5;
const MAX_FILES_LISTED = 10;
// A statement about the PR rather than about a line, so it is reported once with its files
// and not per hunk. One PR raised it on 18 hunks with the same sentence.
const PR_LEVEL_FLAG = "unrelated_to_description";

// US dollars per million tokens, input then output. A model missing here is left out of the cost.
const PRICES: Record<string, [number, number]> = {
  jev: [0.042, 0],
  "gpt-5.6-luna": [0.2, 1.2],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

export interface ReportInput {
  hunks: Hunk[];
  findings: Findings;
  written: Written;
  judgement: Pick<Judgement, "model" | "inputTokens">;
  durationMs: number;
  /** For example https://github.com/owner/repo/pull/12. With it, every location links to its line in the diff. */
  prUrl?: string | undefined;
}

// git-judge posts exactly one comment per PR and updates it in place. It posts no inline review
// comments: each push would add a review to the timeline and a notification per comment.
export interface Report {
  summary: string;
  labels: string[];
  check: { conclusion: "success" | "failure"; title: string; summary: string };
  /** The same data as the hidden block in the summary, for the action output. */
  json: ReportJson;
}

export interface ReportJson {
  version: 1;
  conclusion: "success" | "failure";
  tldr: string | null;
  verdicts: (Verdict & Location)[];
  readingOrder: ({ hunkId: string; attention: number } & Location)[];
  prWarnings: PrWarning[];
  skipped: Findings["skipped"];
  lowCoverage: string[];
  labels: string[];
  models: string[];
  costUsd: number | null;
  durationMs: number;
}

interface Location {
  path: string;
  startLine: number;
  endLine: number;
  /** First changed line, the target of the link into the diff. */
  anchor: Anchor;
}

const FLAG_TITLES: Record<string, string> = {
  secret_semantic: "Possible secret",
  destructive_data: "Destructive data change",
  test_loosened: "Test loosened",
  safety_check_weakened: "Safety check weakened",
  refactor_changes_behaviour: "Called a refactor, changes behaviour",
  comment_drift: "Comment no longer matches the code",
  unrelated_to_description: "Not mentioned in the description",
};

function flagTitle(flagId: string): string {
  return FLAG_TITLES[flagId] ?? `Custom check: ${flagId.replace(/^custom:/, "")}`;
}

function lines(hunk: Pick<Hunk, "startLine" | "endLine">): string {
  if (hunk.endLine < hunk.startLine) return "(lines removed)";
  return hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}-${hunk.endLine}`;
}

function prWarningText(warning: PrWarning): string {
  switch (warning.id) {
    case "no_description":
      return "The PR has no usable description, so the diff was not compared against it. Write what changed and why.";
    case "weak_description":
      return "The description is generic. State what changed and why.";
    case "tests_missing":
      return "No changed test plausibly covers the described change.";
    case "split_suggested":
      return `This PR mixes ${warning.changeTypes.join(", ")} changes. Consider splitting it.`;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function costUsd(input: Pick<ReportInput, "judgement" | "written">): number | null {
  let total = (input.judgement.inputTokens * PRICES.jev![0]) / 1e6;
  for (const [model, usage] of Object.entries(input.written.usage)) {
    const price = PRICES[model];
    if (!price) return null;
    total += (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1e6;
  }
  return total;
}

export function buildReport(input: ReportInput): Report {
  const { findings, written } = input;
  const hunks = new Map(input.hunks.map((hunk) => [hunk.id, hunk]));
  const hunkOf = (id: string) => {
    const hunk = hunks.get(id);
    if (!hunk) throw new Error(`Report refers to unknown hunk ${id}`);
    return hunk;
  };

  const json: ReportJson = {
    version: 1,
    conclusion: findings.conclusion,
    tldr: written.tldr,
    verdicts: written.verdicts.map((verdict) => ({ ...verdict, ...locationOf(hunkOf(verdict.hunkId)) })),
    readingOrder: orderForReading(findings.readingOrder, written.verdicts).map((entry) => ({
      ...entry,
      ...locationOf(hunkOf(entry.hunkId)),
    })),
    prWarnings: findings.prWarnings,
    skipped: findings.skipped,
    lowCoverage: findings.lowCoverage,
    labels: findings.labels,
    models: [input.judgement.model, ...Object.keys(written.usage)],
    costUsd: costUsd(input),
    durationMs: input.durationMs,
  };

  const gates = json.verdicts.filter((verdict) => verdict.kind === "gate");
  return {
    summary: renderSummary(json, input.hunks.length, input.prUrl),
    labels: findings.labels,
    check: {
      conclusion: findings.conclusion,
      title:
        findings.conclusion === "failure"
          ? `Blocked: ${[...new Set(gates.map((gate) => flagTitle(gate.flagId).toLowerCase()))].join(", ")}`
          : written.verdicts.length > 0
            ? `${plural(written.verdicts.length, "finding")} to check`
            : "Nothing flagged",
      summary: written.tldr ?? "No hunk needed a second look.",
    },
    json,
  };
}

function locationOf(hunk: Hunk): Location {
  return { path: hunk.path, startLine: hunk.startLine, endLine: hunk.endLine, anchor: hunk.anchor };
}

/** "`path` L1-13", linked to the first changed line in the PR's Files tab when the PR URL is known. */
function where(location: Location, prUrl: string | undefined): string {
  const text = `\`${location.path}\` ${lines(location)}`;
  if (!prUrl) return text;
  // GitHub anchors a file in the diff view by the SHA-256 of its path, then the side and line.
  const file = createHash("sha256").update(location.path).digest("hex");
  const side = location.anchor.side === "LEFT" ? "L" : "R";
  return `[${text}](${prUrl}/files#diff-${file}${side}${location.anchor.line})`;
}

// Policy ranks by attention before the writer has looked at anything. Here the verdicts are in:
// a gate first, then hunks with a finding that survived, then the rest, each group by attention.
function orderForReading(order: Findings["readingOrder"], verdicts: Verdict[]): Findings["readingOrder"] {
  const rank = (hunkId: string) => {
    // The PR-level flag has its own section, so it does not make a hunk a finding to read first.
    const own = verdicts.filter((verdict) => verdict.hunkId === hunkId && verdict.flagId !== PR_LEVEL_FLAG);
    if (own.some((verdict) => verdict.kind === "gate")) return 0;
    return own.length > 0 ? 1 : 2;
  };
  return [...order].sort((a, b) => rank(a.hunkId) - rank(b.hunkId) || b.attention - a.attention);
}

function renderSummary(json: ReportJson, hunkCount: number, prUrl: string | undefined): string {
  const out: string[] = [SUMMARY_MARKER, "## git-judge", ""];
  out.push(json.tldr ? `**TL;DR** ${json.tldr}` : "Nothing flagged.", "");

  // Markdown folds the lines of a list item into one paragraph, so the breaks are explicit.
  const finding = (verdict: ReportJson["verdicts"][number], note?: string): string =>
    [
      `- **${flagTitle(verdict.flagId)}** (${verdict.severity}) in ${where(verdict, prUrl)}`,
      verdict.whatChanged,
      `**Verify:** ${verdict.whatToVerify}`,
      ...(note ? [note] : []),
    ].join("<br>\n  ");

  const gates = json.verdicts.filter((verdict) => verdict.kind === "gate");
  if (gates.length > 0) {
    out.push("### Blocking", "", "The check fails until a human clears these.", "");
    for (const gate of gates) {
      const disputed = "The writer model did not see this in the code, but a gate is cleared only by a human.";
      out.push(finding(gate, gate.confirmed ? undefined : disputed));
    }
    out.push("");
  }

  // Findings come in reading order, which already puts the most important hunk first.
  const located = new Set(json.verdicts.filter((verdict) => verdict.flagId !== PR_LEVEL_FLAG).map((verdict) => verdict.hunkId));
  const warnings = json.readingOrder.flatMap((entry) =>
    json.verdicts.filter(
      (verdict) => verdict.hunkId === entry.hunkId && verdict.kind === "warning" && verdict.flagId !== PR_LEVEL_FLAG,
    ),
  );
  if (warnings.length > 0) {
    out.push("### Read first", "");
    for (const warning of warnings.slice(0, MAX_FLAGGED_LISTED)) out.push(finding(warning));
    const rest = warnings.length - MAX_FLAGGED_LISTED;
    if (rest > 0) out.push("", `And ${plural(rest, "more finding")}, in the JSON block of this comment.`);
    out.push("");
  }

  const unflagged = json.readingOrder.filter((entry) => !located.has(entry.hunkId));
  if (unflagged.length > 0) {
    out.push(located.size > 0 ? "### Then read" : "### Read in this order", "");
    unflagged.slice(0, MAX_UNFLAGGED_LISTED).forEach((entry, index) => {
      out.push(`${index + 1}. ${where(entry, prUrl)}`);
    });
    const rest = unflagged.length - MAX_UNFLAGGED_LISTED;
    if (rest > 0) out.push("", `And ${plural(rest, "more hunk")} with no finding, in the JSON block of this comment.`);
    out.push("");
  }

  const undescribed = [...new Set(json.verdicts.filter((verdict) => verdict.flagId === PR_LEVEL_FLAG).map((verdict) => verdict.path))];
  if (undescribed.length > 0) {
    const shown = undescribed.slice(0, MAX_FILES_LISTED).map((path) => `\`${path}\``);
    const more = undescribed.length > shown.length ? `, and ${undescribed.length - shown.length} more` : "";
    out.push(
      "### Not mentioned in the description",
      "",
      `Changes in ${plural(undescribed.length, "file")} are not covered by what the PR says it does: ${shown.join(", ")}${more}.`,
      "Update the description, or move them to their own PR.",
      "",
    );
  }

  const { skipped } = json;
  const skippedParts = [
    skipped.mechanical > 0 ? `${skipped.mechanical} mechanical` : "",
    skipped.lockfile > 0 ? `${skipped.lockfile} lockfile` : "",
    skipped.generated > 0 ? `${skipped.generated} generated` : "",
    skipped.vendored > 0 ? `${skipped.vendored} vendored` : "",
  ].filter(Boolean);
  if (skippedParts.length > 0) {
    out.push("### Skip", "", `${skippedParts.join(", ")}.`);
    if (skipped.mechanical > 0) {
      out.push("Mechanical hunks were judged by Jev only, no generative model read them.");
    }
    out.push("");
  }

  const notes = json.prWarnings.map(prWarningText);
  if (skipped.overCap > 0) notes.push(`${plural(skipped.overCap, "hunk")} over the hunk cap were not judged at all.`);
  if (json.lowCoverage.length > 0) {
    const files = [...new Set(json.lowCoverage.map((id) => `\`${id.replace(/#\d+$/, "")}\``))];
    notes.push(`Too large to judge in full, only the first part was read: ${files.join(", ")}.`);
  }
  if (notes.length > 0) out.push("### Notes", "", ...notes.map((note) => `- ${note}`), "");

  const cost = json.costUsd === null ? "cost unknown" : `about $${json.costUsd.toFixed(4)}`;
  out.push("---", `<sub>${plural(hunkCount, "hunk")} | ${(json.durationMs / 1000).toFixed(1)} s | ${cost} | ${json.models.join(", ")}</sub>`);

  // "-->" inside the JSON would end the HTML comment early. The escaped form parses to the same character.
  out.push("", JSON_OPEN, JSON.stringify(json).replaceAll("-->", "--\\u003e"), "-->");
  return out.join("\n");
}

/** The summary posted when the judge or the generator could not be reached. */
export function buildDidNotRunReport(reason: string, failOnError: boolean): Pick<Report, "summary" | "check"> {
  const conclusion = failOnError ? "failure" : "success";
  return {
    summary: [
      SUMMARY_MARKER,
      "## git-judge",
      "",
      "**git-judge did not run on this push.** This PR has not been judged.",
      "",
      `Reason: ${reason}`,
      "",
      failOnError
        ? "The check fails because the policy sets `failOnError`."
        : "The check passes so that an outage does not block the merge.",
    ].join("\n"),
    check: { conclusion, title: "git-judge did not run", summary: reason },
  };
}

export function isSummaryComment(body: string): boolean {
  return body.startsWith(SUMMARY_MARKER);
}

export function extractJson(summary: string): ReportJson | null {
  const start = summary.indexOf(JSON_OPEN);
  if (start === -1) return null;
  const end = summary.indexOf("\n-->", start);
  return JSON.parse(summary.slice(start + JSON_OPEN.length, end)) as ReportJson;
}
