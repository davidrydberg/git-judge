# README

A GitHub Action that tells the reviewer where to look and when a PR's story does not match its diff.

On every push to a PR it ranks each hunk by how much human attention it deserves, flags a small fixed set of things only judgement can catch, and posts one summary comment with a reading order.
It does not find logic bugs and does not suggest code.

Status: the whole pipeline is built and tested with fake clients.
It has not yet run against the real TypeSafe, OpenAI, or GitHub APIs.

## Install it in a repo

Add three repository secrets: `TYPESAFE_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` only if you configure escalation.
Then add `.github/workflows/git-judge.yml`:

```yaml
name: git-judge
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

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

Pull requests from forks are skipped.

## Policy

Every threshold and weight lives in `.git-judge.yml` in the repo root.
The file is optional, and a missing file means the defaults.
git-judge reads it from the base branch, so a PR cannot loosen the policy it is judged by.
The schema with every default is at the top of [`src/policy.ts`](src/policy.ts).

```yaml
minAttention: 0.5          # 0 sends every hunk to the writer model
thresholds:
  warnings:
    test_loosened: 0.7
generator:
  escalation:              # off unless present
    areas: [auth, payments]
customQuestions:
  - id: invoicing
    question: This chunk touches invoicing.
    label: touches-invoicing
```

The shipped thresholds are guesses.
Jev's calibration differs per repo and per language, so expect to tune them.

A hunk that Jev marks mechanical is never read by a generative model.
A subtle bug inside such a hunk gets no second look.
Set `minAttention: 0` if you want every hunk read.

## Develop

Needs Node 24 or newer.

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

No test needs an API key.

## Deploy

GitHub runs the committed bundle `dist/index.cjs`.
Run `npm run build` and commit `dist/` in the same commit as any change under `src/`.
A release is a tag on a commit whose `dist/` is current.
