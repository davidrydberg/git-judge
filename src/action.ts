import * as core from "@actions/core";
import { context } from "@actions/github";
import { createGenerator } from "./generators.js";
import { createGitHub } from "./github.js";
import { createJudgeClient } from "./judge.js";
import { runPipeline } from "./pipeline.js";
import { parsePolicy } from "./policy.js";
import { buildDidNotRunReport } from "./report.js";

async function main(): Promise<void> {
  const pull = context.payload.pull_request;
  if (!pull) {
    core.setFailed("readfirst only runs on pull_request events.");
    return;
  }
  // A fork PR gets no secrets under pull_request, and pull_request_target has not had its security review.
  if (pull.head.repo?.full_name !== pull.base.repo.full_name) {
    core.notice("readfirst does not run on pull requests from forks yet.");
    return;
  }

  const github = createGitHub(core.getInput("github-token", { required: true }), {
    owner: context.repo.owner,
    repo: context.repo.repo,
    number: pull.number,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
  });

  // A broken policy file is the maintainer's bug, not an outage. It fails loudly instead of passing quietly.
  const policy = parsePolicy(await github.fetchPolicy());

  let report;
  try {
    const keys = {
      openai: core.getInput("openai-api-key") || undefined,
      anthropic: core.getInput("anthropic-api-key") || undefined,
    };
    const { escalation } = policy.generator;
    report = await runPipeline({
      diff: await github.fetchDiff(),
      title: pull.title,
      description: pull.body ?? "",
      policy,
      judgeClient: createJudgeClient(core.getInput("typesafe-api-key", { required: true })),
      generator: createGenerator(policy.generator.model, keys),
      escalationGenerator: escalation ? createGenerator(escalation.model, keys) : undefined,
      now: Date.now,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const didNotRun = buildDidNotRunReport(reason, policy.failOnError);
    await github.upsertSummary(didNotRun.summary);
    core.setOutput("conclusion", "did_not_run");
    if (didNotRun.check.conclusion === "failure") core.setFailed(`readfirst did not run: ${reason}`);
    else core.warning(`readfirst did not run: ${reason}`);
    return;
  }

  await github.upsertSummary(report.summary);
  await github.reconcileInline(report.inline);
  await github.syncLabels(report.labels);
  core.setOutput("conclusion", report.check.conclusion);
  core.setOutput("json", JSON.stringify(report.json));
  if (report.check.conclusion === "failure") core.setFailed(report.check.title);
  else core.info(report.check.title);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
