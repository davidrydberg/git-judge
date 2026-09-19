import { getOctokit } from "@actions/github";
import { isSummaryComment } from "./report.js";

export const POLICY_PATH = ".git-judge.yml";

// Label prefixes git-judge owns. Labels with these prefixes are removed when they no longer apply.
const MANAGED_LABEL = /^(area|size|type): /;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface GitHub {
  fetchDiff(): Promise<string>;
  fetchPolicy(): Promise<string>;
  /** True when the PR has a newer head than the one this run judged. */
  headMoved(): Promise<boolean>;
  upsertSummary(body: string): Promise<void>;
  syncLabels(labels: string[]): Promise<void>;
}

export function createGitHub(token: string, pr: PullRequestRef): GitHub {
  const octokit = getOctokit(token);
  const repo = { owner: pr.owner, repo: pr.repo };

  return {
    async fetchDiff() {
      const response = await octokit.rest.pulls.get({
        ...repo,
        pull_number: pr.number,
        mediaType: { format: "diff" },
      });
      // With the diff media type the body is the raw diff, whatever the response type says.
      return response.data as unknown as string;
    },

    // Read from the base commit, never the head. A PR must not be able to loosen the policy it is judged by.
    async fetchPolicy() {
      try {
        const response = await octokit.rest.repos.getContent({
          ...repo,
          path: POLICY_PATH,
          ref: pr.baseSha,
          mediaType: { format: "raw" },
        });
        return response.data as unknown as string;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return "";
        throw error;
      }
    },

    // Runs finish out of order. A run that lost the race must not write its report over a newer one.
    async headMoved() {
      const response = await octokit.rest.pulls.get({ ...repo, pull_number: pr.number });
      return response.data.head.sha !== pr.headSha;
    },

    async upsertSummary(body) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        ...repo,
        issue_number: pr.number,
        per_page: 100,
      });
      const existing = comments.find((comment) => isSummaryComment(comment.body ?? ""));
      if (existing) {
        await octokit.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
      } else {
        await octokit.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
      }
    },

    async syncLabels(labels) {
      const current = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
        ...repo,
        issue_number: pr.number,
        per_page: 100,
      });
      const stale = current.filter((label) => MANAGED_LABEL.test(label.name) && !labels.includes(label.name));
      for (const label of stale) {
        await octokit.rest.issues.removeLabel({ ...repo, issue_number: pr.number, name: label.name });
      }
      // Adding a label that does not exist yet creates it.
      if (labels.length > 0) await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels });
    },
  };
}
