# git-judge

A GitHub Action that tells the reviewer where to look, and when a pull request's story does not match its diff.

A typical agent-written PR is 30 files, and a handful of them hold the actual change.
git-judge reads every hunk, sets the mechanical ones aside, and posts one comment: what the PR really does, the few hunks that need a human, and what to verify in each.
It does not find logic bugs and it does not suggest code.

It is early.
It runs on its own pull requests in this repo, but the thresholds it ships with are guesses.

## What you get on a pull request

One comment, updated in place on every push.
No inline comments and no review entries, so a PR with ten pushes still has one git-judge comment.

| Section | What it holds |
|---|---|
| TL;DR | Two sentences: what the PR does as a whole, then what deserves attention |
| Blocking | Gates that fail the check: a possible secret, a destructive data change |
| Read first | Each confirmed finding, linked to its line in the Files tab, with what changed and what to verify |
| Then read | The next five hunks by attention, linked |
| Not mentioned in the description | Files with changes the PR text does not cover |
| Skip | How many hunks were mechanical, lockfile, generated, or vendored |
| Notes | A weak or missing description, missing tests, a suggestion to split the PR |
| Jev answers | Collapsed table of every raw answer per hunk, the value that raised a flag in bold |

The comment ends with the hunk count, duration, and cost of the run.
The same data is embedded as JSON in a hidden HTML comment and exposed as the `json` output, so another agent can read the findings without reading the diff.

git-judge also applies labels (`area: auth`, `size: M`, `type: refactor`) and removes the ones that no longer apply.
The workflow job is the check.
It fails only on a gate, never on a warning.

The findings it looks for:

- A test made to pass by loosening or removing an assertion.
- Validation, error handling, a permission check, or a limit removed or weakened.
- A change presented as a refactor that alters behaviour.
- A comment that no longer matches the code beside it.
- Changes the PR description does not mention.
- Gate: a credential, key, or token in the added lines.
- Gate: a table or column deleted, renamed, or truncated, or stored data rewritten.
- Your own yes/no questions from the policy file.

## Install

You need a [TypeSafe](https://typesafe.ai) API key and an OpenAI API key.
TypeSafe's Jev model is in early access behind a waitlist.

1. Add two repository secrets under Settings, Secrets and variables, Actions: `TYPESAFE_API_KEY` and `OPENAI_API_KEY`.
   Add `ANTHROPIC_API_KEY` only if your policy names a Claude model.
2. Add `.github/workflows/git-judge.yml`:

```yaml
name: git-judge
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, edited]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  git-judge:
    runs-on: ubuntu-latest
    steps:
      - uses: davidrydberg/git-judge@main
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

3. Open a pull request.

No checkout step is needed, git-judge reads the diff through the GitHub API and never runs the PR's code.
`edited` re-runs it when the description changes, so fixing the description clears the findings about it.
There are no releases yet, so `@main` is the only ref.
Pin a commit SHA instead if you do not want to follow `main`.

Pull requests from forks are skipped.
GitHub gives them no secrets, and running with `pull_request_target` has not had a security review.

### Inputs and outputs

| Input | Required | |
|---|---|---|
| `typesafe-api-key` | yes | Judges every hunk with Jev |
| `openai-api-key` | when the writer model is an OpenAI model, which is the default | Confirms findings and writes the text |
| `anthropic-api-key` | when the policy names a Claude model | Same, for Claude |
| `github-token` | no, defaults to the workflow token | Reads the diff, writes the comment and labels |

| Output | |
|---|---|
| `conclusion` | `success`, `failure`, or `did_not_run` |
| `json` | The full findings, verdicts, reading order, and raw Jev answers |

If TypeSafe or the writer model cannot be reached, the check passes and the comment says git-judge did not run.
Set `failOnError: true` in the policy to fail instead.

## How it works

1. The diff is split into hunks.
   Lockfiles, generated files, and vendored code are set aside by path and are never sent anywhere.
2. Jev answers a fixed set of yes/no and multiple-choice questions about each hunk, with calibrated probabilities.
   The questions live in [`src/questions.ts`](src/questions.ts).
   The questions that can fail the check never see the PR description, since a description saying "safe refactor" is exactly what would sway them.
3. Code, not a model, turns the answers into an attention score, flags, labels, and the check result.
   A gate is a probability against a threshold and nothing else.
4. Only flagged hunks go to a generative model, GPT-5.6 Luna by default, one call per flag.
   It confirms or rejects the flag while reading the code and writes one sentence on what changed and one on what to verify.
   A rejected warning is dropped.
   A gate is kept either way, the writer model cannot clear one.
5. One more call writes the TL;DR from the title, the file list with Jev's change type per file, and the confirmed findings.
   It never sees the diff.

A 90-hunk pull request takes about ten seconds and costs about one cent.

### What is sent where

| To | What |
|---|---|
| TypeSafe | Every hunk that is not a lockfile, generated, or vendored, with its file path. Also the PR title, description, and list of changed files |
| OpenAI, or Anthropic if configured | Only hunks that raised a flag, with the PR description. Also the title and file paths for the TL;DR |
| Neither | A hunk flagged as a possible secret is never sent to the writer model, it has already gone to one vendor |

## Policy

Every threshold and weight lives in `.git-judge.yml` in the repo root.
The file is optional, and a missing file means the defaults.
It is read from the base branch, so a PR cannot loosen the policy it is judged by.
Unknown keys are errors.
The schema with every default is at the top of [`src/policy.ts`](src/policy.ts).

```yaml
minAttention: 0.5          # hunks scoring below this count as mechanical. 0 keeps every hunk
minDescriptionLength: 30   # shorter than this and the description counts as missing
maxHunks: 200
thresholds:
  gates:
    secret_semantic: 0.9
  warnings:
    test_loosened: 0.7
exclude:
  generated: ["**/*.gen.ts"]
  vendored: ["third_party/**"]
generator:
  model: gpt-5.6-luna
  escalation:              # off unless present
    model: claude-opus-5
    areas: [auth, payments]
customQuestions:
  - id: invoicing
    question: This chunk touches invoicing.
    threshold: 0.6
    label: touches-invoicing
failOnError: false
```

A custom question raises a warning and a label.
It can never fail the check.

## Limits you should know

- The shipped thresholds are guesses. Jev's calibration differs per repo and per language, so expect to tune them. The Jev answers table in the comment is there to help with that.
- A hunk that Jev marks mechanical is never read by a generative model, so a subtle bug inside one gets no second look. Set `minAttention: 0` to have every hunk considered.
- The area and type labels are often wrong on small PRs.
- A PR over GitHub's diff limit, about 300 files, ends as "did not run".
- A hunk too large for Jev's context is judged on its first part only and listed as such in the comment.
- Jev works best on English and on high-level languages.
- Jev does not treat its input as hostile. Code comments can sway it. That is why gates never see the description and why the writer model re-reads the code.

## Develop

Needs Node 24 or newer.

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

No test needs an API key or the network.

To run the real pipeline on a local diff, put `TYPESAFE_API_KEY` and `OPENAI_API_KEY` in a `.env` file, which git ignores, and run:

```sh
npm run try -- test/fixtures/mixed.diff "PR title" "PR description"
```

It prints the comment and posts nothing.

## Release

GitHub runs the committed bundle `dist/index.cjs`.
Run `npm run build` and commit `dist/` in the same commit as any change under `src/`.
This repo runs git-judge on its own pull requests from the PR's checkout, so every PR tests its own bundle.

## License

MIT
