# GitHub PR Review + Gate Example

This keeps policy simple and local while making GitHub the primary review surface:
- Require a committed plan artifact at `.plan/plan.json`
- Generate `inspect-plan --json`, `verify-plan`, and `apply-plan --dry-run` artifacts
- Render a markdown review summary using `render-pr-comment`
- Post/update a sticky PR comment for every PR update
- Gate PRs on `verify-plan.status === "ready"`
- Optionally sign approvals in GitHub Actions and enforce trusted signer identities

## Option A: Reusable Action (Fastest Adoption)

Copy this workflow into your repo:

```yaml
name: PR Planfile Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  gatefile-gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Planfile PR gate
        uses: StephenBickel/gatefile/.github/actions/gatefile-pr-gate@main
        with:
          plan-path: .plan/plan.json
          verify-report-path: verify-report.json
          node-version: "22"
```

Reusable action source: `.github/actions/gatefile-pr-gate/action.yml`.

## Option B: Fully Inlined Workflow

If you do not want an external `uses:` dependency, copy the inlined example:
`docs/examples/github-pr-gate.inlined.yml`.

Primary example file using the reusable action:
`docs/examples/github-pr-gate.yml`.

## Option C: GitHub-Native Sticky PR Review Comment + Gate (Recommended)

Copy this workflow into your repo:
`docs/examples/github-pr-review-comment.yml`

This flow:
1. Builds `gatefile` in CI.
2. Produces `inspect-report.json`, `verify-report.json`, and `dry-run-report.json`.
3. Renders markdown via:
   - `node dist/cli.js render-pr-comment .plan/plan.json --inspect inspect-report.json --verify verify-report.json --dry-run dry-run-report.json --out gatefile-pr-comment.md`
4. Posts/updates a sticky PR comment using `marocchino/sticky-pull-request-comment`.
5. Fails the job if `verify-report.json` is not `status: "ready"`.
6. PR comment includes signer trust state (`trusted`, `untrusted`, etc.) when configured.

## Option D: Fork-Safe Signed Approval (Two-Workflow Artifact Handoff)

Use this pair when PRs come from forks and you do not want signing workflows to push to fork branches:

- `docs/examples/github-native-signed-approval-fork-request.yml`
- `docs/examples/github-native-signed-approval-fork-sign.yml`

Flow:
1. PR workflow builds Gatefile outputs and uploads unsigned plan + context as an artifact.
2. Trusted `workflow_dispatch` workflow downloads that artifact, signs a copy, verifies trust/readiness, and uploads a signed artifact.
3. Signing workflow comments on the PR with the signed artifact name and run ID.

The PR workflow runs with read-only permissions and no signing secret. The trusted signing workflow treats the downloaded plan and context as inert artifacts: it checks out and builds trusted default-branch code, signs an artifact copy, and never executes code or hooks from the PR. It never pushes commits to the PR head branch.

For key setup and rotation, see `docs/signed-approvals.md`.

### Local command usage

Render directly from a plan:

```bash
node dist/cli.js render-pr-comment .plan/plan.json
```

Render with precomputed artifacts (recommended in CI):

```bash
node dist/cli.js render-pr-comment .plan/plan.json \
  --inspect inspect-report.json \
  --verify verify-report.json \
  --dry-run dry-run-report.json \
  --out gatefile-pr-comment.md
```
