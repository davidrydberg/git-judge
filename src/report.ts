import type { Anchor, Hunk } from "./diff.js";
import type { Judgement } from "./judge.js";
import type { Findings, PrWarning } from "./policy.js";
import type { Verdict, Written } from "./writer.js";

export const SUMMARY_MARKER = "<!-- git-judge:summary -->";
const JSON_OPEN = "<!-- git-judge:json";
const INLINE_MARKER = /<!-- git-judge:inline key=(\S+) -->/;
const MAX_FLAGGED_LISTED = 15;
const MAX_UNFLAGGED_LISTED = 5;
const MAX_FILES_LISTED = 10;
// A statement about the PR rather than about a line, so it is reported once in the summary
// and never as an inline comment. One PR raised it on 18 hunks with the same sentence.
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
}

export interface InlineComment {
  /** File, flag id, and hunk hash. An existing comment with the same key is still valid and is left alone. */
  key: string;
  path: string;
  anchor: Anchor;
  body: string;
}

export interface Report {
  summary: string;
  inline: InlineComment[];
  labels: string[];
  check: { conclusion: "success" | "failure"; title: string; summary: string };
  /** The same data as the hidden block in the summary, for the action output. */
  json: ReportJson;
}

export interface ReportJson {
  version: 1;
  conclusion: "success" | "failure";
  tldr: string | null;
  verdicts: (Verdict & { path: string; startLine: number; endLine: number })[];
  readingOrder: { hunkId: string; path: string; startLine: number; endLine: number; attention: number }[];
  prWarnings: PrWarning[];
  skipped: Findings["skipped"];
  lowCoverage: string[];
  labels: string[];
  models: string[];
  costUsd: number | null;
  durationMs: number;
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
    verdicts: written.verdicts.map((verdict) => {
      const { path, startLine, endLine } = hunkOf(verdict.hunkId);
      return { ...verdict, path, startLine, endLine };
    }),
    readingOrder: orderForReading(findings.readingOrder, written.verdicts).map((entry) => {
      const { path, startLine, endLine } = hunkOf(entry.hunkId);
      return { ...entry, path, startLine, endLine };
    }),
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
    summary: renderSummary(json, input.hunks.length),
    inline: written.verdicts.filter((verdict) => verdict.flagId !== PR_LEVEL_FLAG).map((verdict) => {
      const hunk = hunkOf(verdict.hunkId);
      const key = `${encodeURIComponent(hunk.path)}:${verdict.flagId}:${hunk.hash.slice(0, 16)}`;
      return { key, path: hunk.path, anchor: hunk.anchor, body: renderInline(verdict, key) };
    }),
    labels: findings.labels,
    check: {
      conclusion: findings.conclusion,
      title:
        findings.conclusion === "failure"
          ? `Blocked: ${[...new Set(gates.map((gate) => flagTitle(gate.flagId).toLowerCase()))].join(", ")}`
          : written.verdicts.length > 0
            ? `${plural(new Set(written.verdicts.map((verdict) => verdict.hunkId)).size, "hunk")} to read first`
            : "Nothing flagged",
      summary: written.tldr ?? "No hunk needed a second look.",
    },
    json,
  };
}

// Policy ranks by attention before the writer has looked at anything. Here the verdicts are in:
// a gate first, then hunks with a finding that survived, then the rest, each group by attention.
function orderForReading(order: Findings["readingOrder"], verdicts: Verdict[]): Findings["readingOrder"] {
  const rank = (hunkId: string) => {
    const own = verdicts.filter((verdict) => verdict.hunkId === hunkId);
    if (own.some((verdict) => verdict.kind === "gate")) return 0;
    return own.length > 0 ? 1 : 2;
  };
  return [...order].sort((a, b) => rank(a.hunkId) - rank(b.hunkId) || b.attention - a.attention);
}

function renderSummary(json: ReportJson, hunkCount: number): string {
  const out: string[] = [SUMMARY_MARKER, "## git-judge", ""];
  out.push(json.tldr ? `**TL;DR** ${json.tldr}` : "Nothing flagged.", "");

  const gates = json.verdicts.filter((verdict) => verdict.kind === "gate");
  if (gates.length > 0) {
    out.push("### Blocking", "");
    for (const gate of gates) {
      const disputed = gate.confirmed ? "" : " The writer model did not see this in the code, but a gate is cleared only by a human.";
      out.push(`- **${flagTitle(gate.flagId)}** in \`${gate.path}\` ${lines(gate)}. ${gate.whatToVerify}${disputed}`);
    }
    out.push("");
  }

  if (json.readingOrder.length > 0) {
    const verdictsOf = (hunkId: string) => json.verdicts.filter((verdict) => verdict.hunkId === hunkId);
    const flagged = json.readingOrder.filter((entry) => verdictsOf(entry.hunkId).length > 0);
    const unflagged = json.readingOrder.filter((entry) => verdictsOf(entry.hunkId).length === 0);
    const listed = [...flagged.slice(0, MAX_FLAGGED_LISTED), ...unflagged.slice(0, MAX_UNFLAGGED_LISTED)];

    out.push("### Read in this order", "");
    listed.forEach((entry, index) => {
      const why = verdictsOf(entry.hunkId).map((verdict) =>
        verdict.flagId === PR_LEVEL_FLAG
          ? "**Not in the description.**"
          : `**${flagTitle(verdict.flagId)}** (${verdict.severity}). ${verdict.whatChanged}`,
      );
      out.push(`${index + 1}. \`${entry.path}\` ${lines(entry)}${why.length > 0 ? ` - ${why.join(" ")}` : ""}`);
    });
    const rest = json.readingOrder.length - listed.length;
    if (rest > 0) out.push("", `And ${plural(rest, "more hunk")}, in the JSON block of this comment.`);
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

  // "-->" inside the JSON would end the HTML comment early. ">" is the same character to a JSON parser.
  out.push("", JSON_OPEN, JSON.stringify(json).replaceAll("-->", "--\\u003e"), "-->");
  return out.join("\n");
}

function renderInline(verdict: Verdict, key: string): string {
  const head = verdict.kind === "gate" ? "Blocking" : "Read first";
  return [
    `**${head}: ${flagTitle(verdict.flagId)}** (${verdict.severity})`,
    "",
    verdict.whatChanged,
    "",
    `**Verify:** ${verdict.whatToVerify}`,
    "",
    `<!-- git-judge:inline key=${key} -->`,
  ].join("\n");
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

/** The reconciliation key of a git-judge inline comment, or null for anyone else's comment. */
export function inlineKey(body: string): string | null {
  return INLINE_MARKER.exec(body)?.[1] ?? null;
}

export function extractJson(summary: string): ReportJson | null {
  const start = summary.indexOf(JSON_OPEN);
  if (start === -1) return null;
  const end = summary.indexOf("\n-->", start);
  return JSON.parse(summary.slice(start + JSON_OPEN.length, end)) as ReportJson;
}
