import * as core from "@actions/core";
import { context } from "@actions/github";
import { createGenerator } from "./generators.js";
import { createGitHub, type GitHub } from "./github.js";
import { createJudgeClient } from "./judge.js";
import { runPipeline } from "./pipeline.js";
import { parsePolicy } from "./policy.js";
import { buildDidNotRunReport } from "./report.js";

async function main(): Promise<void> {
  const pull = context.payload.pull_request;
  if (!pull) {
    core.setFailed("git-judge only runs on pull_request events.");
    return;
  }
  // A fork PR gets no secrets under pull_request, and pull_request_target has not had its security review.
  if (pull.head.repo?.full_name !== pull.base.repo.full_name) {
    core.notice("git-judge does not run on pull requests from forks yet.");
    return;
  }

  const github = createGitHub(core.getInput("github-token", { required: true }), {
    owner: context.repo.owner,
    repo: context.repo.repo,
    number: pull.number,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
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
      prUrl: pull.html_url,
      headSha: pull.head.sha,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (await skipIfStale(github)) return;
    const didNotRun = buildDidNotRunReport(reason, policy.failOnError);
    await github.upsertSummary(didNotRun.summary);
    core.setOutput("conclusion", "did_not_run");
    if (didNotRun.check.conclusion === "failure") core.setFailed(`git-judge did not run: ${reason}`);
    else core.warning(`git-judge did not run: ${reason}`);
    return;
  }

  if (await skipIfStale(github)) return;
  await github.upsertSummary(report.summary);
  await github.syncLabels(report.labels);
  core.setOutput("conclusion", report.check.conclusion);
  core.setOutput("json", JSON.stringify(report.json));
  if (report.check.conclusion === "failure") core.setFailed(report.check.title);
  else core.info(report.check.title);
}

async function skipIfStale(github: GitHub): Promise<boolean> {
  if (!(await github.headMoved())) return false;
  core.notice("The pull request has a newer commit. This run posts nothing, the run for that commit will.");
  core.setOutput("conclusion", "did_not_run");
  return true;
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
