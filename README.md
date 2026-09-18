# readfirst

A GitHub Action that tells the reviewer where to look and when a PR's story does not match its diff.
The full spec is in [`prd.md`](prd.md).

Status: in development.
The pipeline stages `diff`, `questions`, `judge`, and `policy` are built and tested.
`writer`, `report`, `github`, and `action` are not built yet, so there is nothing to install or deploy.

## Run it

Needs Node 24 or newer.

```sh
npm install
npm test
npm run typecheck
npm run lint
```

No test needs an API key.

## Deploy it

Not deployable yet.
It will ship as a JavaScript GitHub Action, installed with one workflow file and the secrets listed in the PRD.
