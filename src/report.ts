import { createHash } from "node:crypto";
import type { Anchor, Hunk } from "./diff.js";
import type { HunkAnswers, Judgement } from "./judge.js";
import type { Findings, PrWarning } from "./policy.js";
import type { Verdict, Written } from "./writer.js";

export const SUMMARY_MARKER = "<!-- git-judge:summary -->";
const JSON_OPEN = "<!-- git-judge:json";
const MAX_FLAGGED_LISTED = 15;
const MAX_UNFLAGGED_LISTED = 10;
const MAX_FILES_LISTED = 10;
const MAX_TABLE_ROWS = 60;
// GitHub rejects a comment over 65,536 characters. Past this size the raw answers leave the JSON block.
const MAX_COMMENT_CHARS = 60_000;
const MAX_EMBEDDED_READING_ORDER = 50;
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
  judgement: Pick<Judgement, "model" | "inputTokens" | "hunks" | "pr">;
  durationMs: number;
  /** For example https://github.com/owner/repo/pull/12. With it, every location links to its line in the diff. */
  prUrl?: string | undefined;
  /** The commit the diff was read at. It ties the report to what was judged. */
  headSha?: string | undefined;
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
  /** The commit this report describes, or null when the caller did not say. */
  headSha: string | null;
  conclusion: "success" | "failure";
  tldr: string | null;
  /** `id` survives a push that leaves the flagged lines alone, so a reader can tell a standing finding from a new one. */
  verdicts: (Verdict & Location & { id: string })[];
  readingOrder: (Findings["readingOrder"][number] & Location)[];
  /** Every raw Jev answer, per judged hunk and for the PR. Dropped only if the comment would be too large. */
  jev: { hunks: Record<string, JevRow>; pr: { descriptionQuality: number; testsCoverChange: number } } | null;
  prWarnings: PrWarning[];
  skipped: Findings["skipped"];
  lowCoverage: string[];
  labels: string[];
  models: string[];
  costUsd: number | null;
  durationMs: number;
}

type Chosen = { choice: string; confidence: number };

/** One judged hunk: the probability of yes per noul, and the pick with its confidence per choice. */
export interface JevRow extends Location {
  nouls: Record<string, number>;
  changeType: Chosen;
  sensitiveArea: Chosen;
  blastRadius: Chosen;
  lowCoverage: boolean;
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

  const seen = new Map<string, number>();
  const json: ReportJson = {
    version: 1,
    headSha: input.headSha ?? null,
    conclusion: findings.conclusion,
    tldr: written.tldr,
    verdicts: written.verdicts.map((verdict) => {
      const hunk = hunkOf(verdict.hunkId);
      const id = findingId(verdict.flagId, hunk);
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      // The same edit twice in one file hashes the same, so the later one is numbered.
      return { id: count === 1 ? id : `${id}-${count}`, ...verdict, ...locationOf(hunk) };
    }),
    readingOrder: orderForReading(findings.readingOrder, written.verdicts).map((entry) => ({
      ...entry,
      ...locationOf(hunkOf(entry.hunkId)),
    })),
    jev: {
      hunks: Object.fromEntries(
        input.hunks.flatMap((hunk) => {
          const answers = input.judgement.hunks[hunk.id];
          return answers ? [[hunk.id, jevRow(hunk, answers)]] : [];
        }),
      ),
      pr: {
        descriptionQuality: input.judgement.pr.description_quality.score,
        testsCoverChange: input.judgement.pr.tests_cover_change.noul,
      },
    },
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
    summary: renderWithinLimit(json, input),
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

function renderWithinLimit(json: ReportJson, input: ReportInput): string {
  const flagged = new Set(input.findings.flags.map((flag) => `${flag.hunkId}|${flag.id}`));
  // The visible comment is capped everywhere, so what grows without bound is the embedded JSON.
  // The raw answers leave it first, then the tail of the reading order. The action output keeps both.
  const embedded: ReportJson[] = [
    json,
    { ...json, jev: null },
    { ...json, jev: null, readingOrder: json.readingOrder.slice(0, MAX_EMBEDDED_READING_ORDER) },
  ];
  let summary = "";
  for (const candidate of embedded) {
    summary = renderSummary(json, input.hunks, input.prUrl, flagged, candidate);
    if (summary.length <= MAX_COMMENT_CHARS) break;
  }
  return summary;
}

function jevRow(hunk: Hunk, answers: HunkAnswers): JevRow {
  const { code, mismatch, custom } = answers;
  const chosen = (answer: Chosen): Chosen => ({ choice: answer.choice, confidence: answer.confidence });
  const nouls: Record<string, number> = {};
  for (const [id, answer] of Object.entries(code)) if (answer.type === "noul") nouls[id] = answer.noul;
  if (mismatch) nouls.unrelated_to_description = mismatch.unrelated_to_description.noul;
  for (const [id, value] of Object.entries(custom)) nouls[`custom:${id}`] = value;
  return {
    ...locationOf(hunk),
    nouls,
    changeType: chosen(code.change_type),
    sensitiveArea: chosen(code.sensitive_area),
    blastRadius: chosen(code.blast_radius),
    lowCoverage: answers.lowCoverage,
  };
}

const NOUL_COLUMNS: [id: string, heading: string][] = [
  ["mechanical", "mech"],
  ["secret_semantic", "secret"],
  ["destructive_data", "destr"],
  ["refactor_changes_behaviour", "behav"],
  ["test_loosened", "t.loos"],
  ["safety_check_weakened", "safety"],
  ["comment_drift", "drift"],
  ["unrelated_to_description", "undesc"],
];

/** Every answer Jev gave, one row per judged hunk, most important first. Bold marks a value that raised a flag. */
function renderJevTable(
  json: ReportJson,
  jev: NonNullable<ReportJson["jev"]>,
  prUrl: string | undefined,
  flagged: Set<string>,
): string[] {
  const ids = json.readingOrder.map((entry) => entry.hunkId).filter((id) => jev.hunks[id]);
  for (const id of Object.keys(jev.hunks)) if (!ids.includes(id)) ids.push(id);
  if (ids.length === 0) return [];

  const attention = new Map(json.readingOrder.map((entry) => [entry.hunkId, entry.attention]));
  const custom = [...new Set(ids.flatMap((id) => Object.keys(jev.hunks[id]?.nouls ?? {})))].filter((id) =>
    id.startsWith("custom:"),
  );
  const columns: [string, string][] = [...NOUL_COLUMNS, ...custom.map((id): [string, string] => [id, id.slice(7)])];
  const pick = (chosen: Chosen) => `${chosen.choice} ${chosen.confidence.toFixed(2)}`;

  const rows = ids.slice(0, MAX_TABLE_ROWS).flatMap((id) => {
    const row = jev.hunks[id];
    if (!row) return [];
    const cells = columns.map(([column]) => {
      const value = row.nouls[column];
      if (value === undefined) return "-";
      return flagged.has(`${id}|${column}`) ? `**${value.toFixed(2)}**` : value.toFixed(2);
    });
    const score = attention.get(id);
    return [
      `| ${where(row, prUrl)}${row.lowCoverage ? " (cut)" : ""} | ${score === undefined ? "skip" : score.toFixed(2)} | ${cells.join(" | ")} | ${pick(row.changeType)} | ${pick(row.sensitiveArea)} | ${pick(row.blastRadius)} |`,
    ];
  });

  const more = ids.length - rows.length;
  return [
    "<details>",
    `<summary>Jev answers for ${plural(ids.length, "hunk")}</summary>`,
    "",
    "Probability of yes per question, and Jev's pick with its confidence for type, area, and blast radius.",
    "`attn` is the attention score, `skip` means below the cutoff. Bold raised a flag. `undesc` is `-` when the description was too short to compare.",
    "",
    `| hunk | attn | ${columns.map(([, heading]) => heading).join(" | ")} | type | area | blast |`,
    `|---|---|${columns.map(() => "---").join("|")}|---|---|---|`,
    ...rows,
    "",
    ...(more > 0 ? [`And ${plural(more, "more hunk")}, in the JSON block of this comment.`, ""] : []),
    `PR level: description quality ${jev.pr.descriptionQuality.toFixed(2)} of 2, tests cover the change ${jev.pr.testsCoverChange.toFixed(2)}.`,
    "",
    "</details>",
    "",
  ];
}

// The hunk id is a position in the diff and moves when a push adds a hunk above it. This id is the
// flag, the file, and the hunk's changed lines, so it survives edits elsewhere in the file. It covers
// the whole hunk, not only the lines the flag is about: an edit within three lines merges into the
// hunk and changes the id, which then reads as a new finding.
function findingId(flagId: string, hunk: Hunk): string {
  const changed = hunk.content.split("\n").filter((line) => /^[+-]/.test(line));
  return createHash("sha256").update([flagId, hunk.path, ...changed].join("\n")).digest("hex").slice(0, 12);
}

const MAX_SNIPPET_LINES = 8;
const MAX_SNIPPET_LINE_CHARS = 200;

// A diff block inside a list item. The lines are author-controlled, so the fence is made longer
// than any run of backticks in them and nothing inside it can close the block.
function snippet(lines: string[], indent = "  "): string {
  const shown = lines.slice(0, MAX_SNIPPET_LINES).map((line) => line.slice(0, MAX_SNIPPET_LINE_CHARS));
  if (lines.length > shown.length) shown.push(`  ... ${plural(lines.length - shown.length, "more changed line")}`);
  const longest = Math.max(2, ...shown.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = "`".repeat(longest + 1);
  return ["", "", `${fence}diff`, ...shown, fence].map((line) => (line ? indent + line : "")).join("\n");
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

const AREA_TEXT: Record<string, string> = {
  auth: "auth",
  payments: "payments",
  data_migration: "data migration",
  public_api: "public API",
};

// Why an unflagged hunk is on the list, from answers Jev already gave. No model writes this.
// Policy has already dropped the picks Jev was not confident in, so a guess is never stated as a fact.
function whyRead(entry: ReportJson["readingOrder"][number]): string {
  const parts: string[] = [];
  if (entry.changeType) parts.push(entry.changeType);
  const area = entry.area ? AREA_TEXT[entry.area] : undefined;
  if (area) parts.push(`touches ${area}`);
  if (entry.blastRadius && entry.blastRadius !== "nobody") parts.push(`${entry.blastRadius} would notice`);
  const close = entry.nearMisses.map(
    (miss) => `${flagTitle(miss.id).toLowerCase()} ${miss.probability.toFixed(2)}, flags at ${miss.threshold}`,
  );
  return [parts.join(", "), close.length > 0 ? `Close to a flag: ${close.join("; ")}` : ""].filter(Boolean).join(". ");
}

// A near miss has no model to point at lines, so the hunk's own changed lines are shown, cut short.
// Never for a possible secret: the comment would keep it after a force-push removed it from the branch.
function closeCall(entry: ReportJson["readingOrder"][number], hunks: Hunk[]): string {
  if (entry.nearMisses.length === 0 || entry.nearMisses.some((miss) => miss.id === "secret_semantic")) return "";
  const changed = hunks
    .find((hunk) => hunk.id === entry.hunkId)
    ?.content.split("\n")
    .filter((line) => /^[+-]/.test(line));
  return changed && changed.length > 0 ? snippet(changed, "   ") : "";
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

function renderSummary(
  json: ReportJson,
  hunks: Hunk[],
  prUrl: string | undefined,
  flagged: Set<string>,
  /** What goes in the hidden block. The visible comment is always rendered from the full `json`. */
  embedded: ReportJson = json,
): string {
  const out: string[] = [SUMMARY_MARKER, "## git-judge", ""];
  out.push(json.tldr ? `**TL;DR** ${json.tldr}` : "Nothing flagged.", "");

  // Markdown folds the lines of a list item into one paragraph, so the breaks are explicit.
  const finding = (verdict: ReportJson["verdicts"][number], note?: string): string =>
    [
      `- **${flagTitle(verdict.flagId)}** (${verdict.severity}) in ${where(verdict, prUrl)}`,
      verdict.whatChanged,
      `**Verify:** ${verdict.whatToVerify}`,
      ...(note ? [note] : []),
    ].join("<br>\n  ") + (verdict.evidence.length > 0 ? snippet(verdict.evidence) : "");

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
      const reason = whyRead(entry);
      out.push(`${index + 1}. ${where(entry, prUrl)}${reason ? ` - ${reason}` : ""}${closeCall(entry, hunks)}`);
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

  if (json.jev) out.push(...renderJevTable(json, json.jev, prUrl, flagged));

  const cost = json.costUsd === null ? "cost unknown" : `about $${json.costUsd.toFixed(4)}`;
  const commit = json.headSha ? `judged at ${json.headSha.slice(0, 7)} | ` : "";
  out.push("---", `<sub>${commit}${plural(hunks.length, "hunk")} | ${(json.durationMs / 1000).toFixed(1)} s | ${cost} | ${json.models.join(", ")}</sub>`);

  // "-->" inside the JSON would end the HTML comment early. The escaped form parses to the same character.
  out.push("", JSON_OPEN, JSON.stringify(embedded).replaceAll("-->", "--\\u003e"), "-->");
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
