# gatefile

[![CI](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gatefile)](https://www.npmjs.com/package/gatefile)

**Terraform for AI agent side effects.**

Your AI agent wants to edit 14 files and run 3 shell commands. Do you trust it?

`gatefile` makes agent side effects explicit, reviewable, and approvable — before anything executes.

```bash
npx gatefile inspect-plan .plan/plan.json    # see exactly what the agent wants to do
npx gatefile approve-plan .plan/plan.json    # approve the hash-locked plan
npx gatefile generate-attestation-key --out-private .gatefile/approval-key.pem
npx gatefile approve-plan .plan/plan.json --by steve --signing-key .gatefile/approval-key.pem
npx gatefile apply-plan .plan/plan.json      # execute with safety guardrails
npx gatefile rollback-apply <receipt-id> --yes
```

## Why

Agent tooling is good at *doing* things but weak at *governing* side effects.

- Hidden file edits buried in PR-sized bursts
- Shell commands with unclear blast radius
- No durable artifact for review, approval, or audit
- Tests verify behavior *after* changes. Traces show what happened *during*. Neither gives you a machine-readable **intent contract** *before* execution

Today, teams rely on prompts and trust. That doesn't scale.

## How It Works

```
Agent emits plan → Human reviews → Approve hash → Apply with guardrails
```

1. **Create** — agent declares intended file changes + commands as a JSON plan
2. **Inspect** — human or CI reviews the plan (concise summary or `--json` for machines)
3. **Verify** — integrity check confirms the plan hasn't been tampered with
4. **Approve** — human or policy engine approves, binding to the exact plan hash
5. **Apply** — execute with precondition checks, path sandboxing, command policies, and timeouts
6. **Rollback (files)** — restore Gatefile-managed file operations from the pre-apply snapshot/receipt

Approval is hash-bound: if anyone modifies the plan after approval, `verify` catches it and `apply` refuses. Signed attestation adds cryptographic proof of approval identity, and optional signer trust policy enforces trusted signer identities.

## Quick Start

```bash
# Install
npm install gatefile

# Or run directly
npx gatefile --help
```

### End-to-End Demo

```bash
git clone https://github.com/StephenBickel/gatefile.git
cd gatefile
npm install
npm run demo:e2e
```

This runs the full flow: create → inspect → verify → approve → dry-run → denied unsafe path → safe apply → PR gate adoption.

### Basic Usage

```bash
# Agent creates a plan
gatefile create-plan --from examples/coding-agent-plan.json --out .plan/plan.json

# Review what it wants to do
gatefile inspect-plan .plan/plan.json

# Machine-readable for CI
gatefile inspect-plan .plan/plan.json --json

# Check integrity
gatefile verify-plan .plan/plan.json

# Preview without executing
gatefile apply-plan .plan/plan.json --dry-run

# Approve (binds to exact hash)
gatefile approve-plan .plan/plan.json --by steve

# Optional: generate local Ed25519 key and sign approval attestation
gatefile generate-attestation-key --out-private .gatefile/approval-key.pem --out-public .gatefile/approval-key.pub.pem
gatefile lint-config
gatefile approve-plan .plan/plan.json --by steve --signing-key .gatefile/approval-key.pem

# Execute
gatefile apply-plan .plan/plan.json --yes

# Roll back file operations from a prior apply receipt
gatefile rollback-apply <receipt-id> --yes
```

### Agent Adapter (MVP)

Use `adapt-agent` when an external agent emits concise proposal-style JSON:

```bash
gatefile adapt-agent --from examples/agent-adapter-input.json --out .plan/adapter-draft.json
gatefile create-plan --from .plan/adapter-draft.json --out .plan/plan.json
gatefile inspect-plan .plan/plan.json
```

See [docs/agent-adapter.md](docs/agent-adapter.md) for supported input formats and full workflow details.

## Safety Guardrails

`apply-plan` enforces multiple safety layers:

| Layer | What it does |
|-------|-------------|
| **Hash binding** | Approval locks to exact plan content — tampering detected |
| **Signer trust policy** | Optional trusted signer allowlist (`gatefile.config.json`) for signed approvals |
| **File sandboxing** | Writes restricted to workspace root (configurable via `filePolicy.allowedRoots`) |
| **Command policy** | Allow/deny patterns for shell commands |
| **Timeouts** | Default 10s per command, configurable per-operation or plan-wide |
| **Preconditions** | Guard checks (branch, clean tree, env vars) must pass before apply |
| **Policy hooks** | Optional `beforeApprove`/`beforeApply` hooks from `gatefile.config.json` |
| **Dependencies** | Plan-level `dependsOn` IDs require prior successful apply receipts |
| **Dry-run** | Preview everything without executing — works before or after approval |
| **Snapshots + receipts** | Real apply writes pre-apply file snapshots + apply receipts under `.gatefile/state` |
| **Rollback command** | `rollback-apply` restores file content from snapshot metadata (commands are not auto-reverted) |

## GitHub PR Gate

Drop a gatefile check into any CI pipeline:

```yaml
- uses: StephenBickel/gatefile/.github/actions/gatefile-pr-gate@main
  with:
    plan-path: .plan/plan.json
```

See [docs/github-pr-gate-example.md](docs/github-pr-gate-example.md) for full workflow examples.

For CI-native signed approvals on PR branches, use:
- [docs/examples/github-native-signed-approval.yml](docs/examples/github-native-signed-approval.yml)

For fork-safe signing without pushing to fork branches, use:
- [docs/examples/github-native-signed-approval-fork-request.yml](docs/examples/github-native-signed-approval-fork-request.yml)
- [docs/examples/github-native-signed-approval-fork-sign.yml](docs/examples/github-native-signed-approval-fork-sign.yml)

## `gatefile.config.json` Hooks (MVP)

Use a repo-local config file to run lightweight policy hooks before approval/apply:

```json
{
  "hooks": {
    "beforeApprove": { "command": "node ./scripts/before-approve.js" },
    "beforeApply": { "command": "node ./scripts/before-apply.js" }
  }
}
```

Hook commands receive structured JSON on `stdin` and env vars like `GATEFILE_HOOK_EVENT`, `GATEFILE_PLAN_ID`, `GATEFILE_PLAN_HASH`, and `GATEFILE_REPO_ROOT`. Non-zero exit blocks the action.

You can also define signer trust policy:

```json
{
  "signers": {
    "trustedKeyIds": ["security-team-prod-1"],
    "trustedPublicKeys": [
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3BpXovQEPSywMnUz4IdaCBTGcIH+6gRV9kt1SMjg7bE=\n-----END PUBLIC KEY-----"
    ]
  }
}
```

Validate config anytime with:

```bash
gatefile lint-config
```

## Core Concepts

| Concept | Description |
|---------|------------|
| **Plan** | Immutable JSON artifact describing proposed side effects |
| **Changeset** | File diffs (`create`, `update`, `delete`) and command intents |
| **Risk Profile** | Heuristic score + rationale per operation |
| **Preconditions** | Guards that must pass before apply |
| **Approval** | Hash-bound human or policy gate |
| **Apply Report** | What executed, what failed, and why |
| **Apply Receipt** | Repo-local record used for rollback and dependency checks |
| **Approval Attestation** | Optional Ed25519 signature proving who approved the exact plan hash |

## Architecture

- [Architecture](docs/architecture.md)
- [Signed Approvals](docs/signed-approvals.md)
- [Agent Adapter (MVP)](docs/agent-adapter.md)
- [Changeset Spec](docs/changeset-spec.md)
- [JSON Schema](schema/gatefile.schema.json)
- [Use Cases](docs/use-cases.md)
- [GitHub PR Gate](docs/github-pr-gate-example.md)

## Roadmap

See [Product Roadmap](docs/product-roadmap.md) for the full product path and [TODO.md](TODO.md) for near-term execution.

- [x] CLI with create/inspect/verify/approve/apply
- [x] Hash-bound approval with tamper detection
- [x] Command + file path safety policies
- [x] Dry-run preview mode
- [x] GitHub PR gate action
- [x] Recovery guidance in apply reports
- [x] Agent adapter command (`adapt-agent`) for proposal-to-draft conversion
- [x] Policy hook interfaces (`beforeApprove`, `beforeApply`)
- [x] Rollback / pre-apply snapshots + receipt-backed restore path
- [x] Plan dependencies (`dependsOn`) enforced via successful apply receipts
- [x] Signing/attestation workflows + signer trust policy
- [ ] Agent SDK integrations

## Contributing

Contributions welcome — especially around spec clarity, safer apply strategies, and real-world use-case feedback.

1. Open an issue (or pick from TODO.md)
2. Keep changes focused and documented
3. Include examples when behavior changes

## License

MIT
