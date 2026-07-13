# GitHub PR Gate

The reusable Action evaluates a committed Gatefile plan with code from the
pinned Gatefile release, not build output from the pull-request repository. It
produces inspect, verification, dry-run, and manifest evidence for review, then
enforces readiness only after GitHub has had an opportunity to upload that
evidence.

## Security contract

The gate fails closed unless all of these conditions hold:

- The plan path is repository-relative, Git-tracked, and byte-for-byte
  unchanged from `HEAD`.
- The checkout contains full history so the PR base commit can be resolved.
- `trusted-policy-ref` is a full commit SHA. For pull requests, use
  `github.event.pull_request.base.sha`, not a branch name or PR-controlled ref.
- `trusted-policy-sha256` matches the exact bytes of the policy file at that
  trusted commit.
- Verification reports the plan as ready and the dry-run static gate passes.

The Action reads policy with `git show` from the trusted commit and passes that
snapshot explicitly to an Action-owned Gatefile runner. A pull request cannot
weaken verification by replacing its working-tree `gatefile.config.json` or by
placing malicious build output in the consumer repository.

The Action cannot authenticate or protect the workflow that calls it. Pin every
Action by full commit SHA and enforce the gate from a protected required
workflow or organization/repository ruleset; a pull request allowed to replace
its own required workflow can bypass any in-repository check. Run this gate
before any step that executes pull-request code, preferably on an isolated
GitHub-hosted runner. A hostile same-user process already running on the worker
is outside this Action's isolation boundary and can tamper with runner files.

## Configure the trusted policy digest

Compute the SHA-256 digest of the exact `gatefile.config.json` bytes on the base
branch. For example, from a checkout of that branch:

```bash
shasum -a 256 gatefile.config.json
```

Store the hex digest as a repository Actions variable named
`GATEFILE_POLICY_SHA256`. This value is a policy pin, not a secret. Update it as
part of the trusted base-branch change whenever the policy bytes change.

## Recommended workflow

Copy [`docs/examples/github-pr-gate.yml`](examples/github-pr-gate.yml) into the
consumer repository:

```yaml
name: Gatefile PR Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  gatefile-gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Gatefile PR gate
        uses: StephenBickel/gatefile/.github/actions/gatefile-pr-gate@57689dd2ddc2e8a6bc1c3cb5b46d5239f2d0ced0
        with:
          plan-path: .plan/plan.json
          trusted-policy-ref: ${{ github.event.pull_request.base.sha }}
          trusted-policy-path: gatefile.config.json
          trusted-policy-sha256: ${{ vars.GATEFILE_POLICY_SHA256 }}
          node-version: "22"
          artifact-name: gatefile-artifacts
```

The plan itself must be committed before the workflow runs. Generated or
modified plans are deliberately rejected, because evidence from a different
byte sequence would not describe the reviewed commit.

## Evidence and enforcement order

The Action copies the committed plan blob and these bound evidence files into a
fresh runner-owned staging directory. Artifact upload receives only that
directory, never caller-selected workspace paths:

| File | Purpose |
|---|---|
| `inspect-report.json` | Normalized plan inspection and review details |
| `verify-report.json` | Integrity, approval, signer trust, and readiness result |
| `dry-run-report.json` | Non-executing preview and static-gate result |
| `gatefile-manifest.json` | Gatefile version, Git head, raw and semantic plan hashes, policy pin, and evidence digests |

Evidence upload uses `if: ${{ always() }}` and appears before the final
readiness enforcement step. Enforcement rechecks every manifest digest and the
cross-report plan/hash/decision binding. A not-ready plan therefore leaves inspect,
verification, dry-run, and manifest artifacts for diagnosis before the job is
reported as failed. Failures that occur before evidence can be generated—for
example, an untracked plan or a policy digest mismatch—still fail closed.

## Explicit unsigned evaluation mode

Repositories with no signer policy can opt into unsigned evaluation only by
omitting the trusted-policy inputs and setting:

```yaml
with:
  plan-path: .plan/plan.json
  allow-unsigned-no-policy: "true"
```

This is an explicit alpha evaluation escape hatch. It does not establish signer
trust and should not be used where an approved identity is part of the merge
policy. With the default `"false"`, omitting the trusted policy ref or digest is
an error.

## Expanded workflow

[`docs/examples/github-pr-gate.inlined.yml`](examples/github-pr-gate.inlined.yml)
shows the same sequence expanded into separate steps. It checks out pinned
Gatefile code into runner-owned temporary storage, invokes that checkout's
Action runner, uploads only its staged evidence directory, and then enforces
manifest-bound readiness. It never
installs, builds, or executes Gatefile code from the consumer repository.

For signed-approval artifact handoff from fork pull requests, see:

- [`docs/examples/github-native-signed-approval-fork-request.yml`](examples/github-native-signed-approval-fork-request.yml)
- [`docs/examples/github-native-signed-approval-fork-sign.yml`](examples/github-native-signed-approval-fork-sign.yml)

For key setup and rotation, see [`docs/signed-approvals.md`](signed-approvals.md).
