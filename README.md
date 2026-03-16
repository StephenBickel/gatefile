# planfile

[![CI](https://github.com/StephenBickel/planfile/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenBickel/planfile/actions/workflows/ci.yml)

**Review exact file and shell changes, approve the plan hash, then apply safely.**

`planfile` is a small CLI for separating agent side effects into explicit phases:
- `create/inspect/verify` for review and governance
- `approve` for human or policy gating
- `apply` for controlled execution with preconditions

## Canonical End-to-End Demo (Public Launch MVP)

Run one terminal-first flow that shows:
1. create plan
2. inspect
3. verify not-ready before approval
4. approve
5. dry-run with human-readable output
6. unsafe denied apply path
7. safe approved apply
8. reusable PR gate adoption path

```bash
npm install
npm run demo:e2e
```

Demo artifacts used by the script:
- `demo/public-launch-e2e.sh`
- `examples/public-launch-safe-draft.json`
- `examples/public-launch-unsafe-draft.json`

Adoption path after local demo:
- `docs/github-pr-gate-example.md`
- `.github/actions/planfile-pr-gate/action.yml`

## The Problem

Agent tooling is good at *doing* things, but weak at *governance* of side effects.

Common failure modes:
- Hidden file edits in large PR-sized bursts
- Shell commands with unclear blast radius
- Missing preconditions (wrong branch, dirty tree, missing env vars)
- No durable artifact for review/approval/audit

Today, many teams rely on prompts and trust. That does not scale.

## Why Existing Testing + Tracing Is Not Enough

Testing and tracing are valuable, but they solve different layers:
- Tests tell you if behavior is acceptable *after* changes
- Traces tell you what happened *during* execution
- Neither gives you a first-class, machine-readable **intent contract** for side effects *before* execution

`planfile` fills that gap with a plan artifact that can be inspected, risk-scored, approved, and then applied.

## Core Concepts

- `Plan`: immutable artifact describing proposed side effects
- `Changeset`: concrete file diffs and command intents
- `Risk Profile`: heuristic score + rationale per action
- `Preconditions`: guard checks that must pass before apply
- `Approval`: explicit human or policy gate
- `Apply Report`: what actually executed, what failed, and why

## Example UX

```bash
# 1) Agent emits a plan
planfile create-plan --from examples/coding-agent-plan.json --out .plan/plan.json

# 2) Human inspects the plan (concise summary)
planfile inspect-plan .plan/plan.json

# 3) CI/policy can request machine-readable inspect data
planfile inspect-plan .plan/plan.json --json

# 4) Human/CI verifies integrity + approval readiness
planfile verify-plan .plan/plan.json

# 5) Optional dry-run preview at any time (even before approval)
planfile apply-plan .plan/plan.json --dry-run

# Optional concise human preview for demos/review sessions
planfile apply-plan .plan/plan.json --dry-run --human

# 6) Approval step (local or policy engine)
planfile approve-plan .plan/plan.json --by steve

# 7) Verify again, then apply
planfile verify-plan .plan/plan.json
planfile apply-plan .plan/plan.json --yes

# Optional concise human apply report with recovery hints
planfile apply-plan .plan/plan.json --yes --human
```

`inspect-plan` defaults to concise human output. Use `inspect-plan --json` for machine-readable CI/policy workflows.

`apply-plan --dry-run` returns a preview report without running preconditions, writing files, or executing commands. It works for pending/approved/tampered plans and includes verification state so readiness is explicit in the output.
Use `--human` for a concise text formatter; omit `--human` for machine-readable JSON.

## Additional Integrity Demo: Verify, Approve, Tamper Detection

Approval is bound to a deterministic hash of the normalized plan content
(`version`, `source`, `summary`, `operations`, `preconditions`, `execution`).

This prevents a common failure mode: review one plan, then apply a modified one.

Concrete flow:

```bash
# create a concrete plan artifact (includes integrity.planHash)
planfile create-plan --from examples/coding-agent-plan.json --out .plan/demo.json

# before approval, verify shows:
# - integrityMetadataExists: true
# - recordedHashMatchesCurrent: true
# - approvalBoundToCurrentHash: false
# - status: "not-ready"
planfile verify-plan .plan/demo.json

# approve binds approval.approvedPlanHash to the exact reviewed hash
planfile approve-plan .plan/demo.json --by steve

# after approval, verify should report status: "ready"
planfile verify-plan .plan/demo.json

# simulate post-approval tampering (change the summary in-place)
node -e 'const fs=require("fs");const p=".plan/demo.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.summary="tampered after approval";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'

# verify now reports status: "not-ready" and hash/approval mismatch
planfile verify-plan .plan/demo.json

# apply also refuses because verification fails
planfile apply-plan .plan/demo.json --yes
```

`planfile` does not claim cryptographic signatures or identity attestation in this MVP.
It enforces deterministic content hashing and approval/hash binding locally.

## Visual Playwright Demo

A static product-style walkthrough lives in `demo/` and mirrors the core flow:
create plan -> verify not-ready -> approve -> verify ready -> tamper -> verify not-ready -> apply refusal.

Run locally:

```bash
# one-time browser setup for Playwright
npm run demo:playwright:install

# execute the walkthrough recorder (opens demo/index.html via file://)
npm run demo:playwright
```

Artifacts are written under `demo/output/` (screenshots plus Playwright video in `demo/output/test-results/`).

## MVP Scope (This Repo)

Current MVP focuses on:
- File-diff operations (`create`, `update`, `delete`)
- Shell command operations with explicit risk and preconditions
- Command safety guardrails (optional allow/deny pattern policy + timeout defaults)
- Dry-run preview reports for planned file/command operations before apply
- Dry-run/apply recovery guidance fields to support practical manual rollback planning
- Local CLI and JSON plan artifacts

Not yet in MVP:
- Browser automation actions
- External API transaction adapters
- Remote signing/attestation services

## Execution Safety (MVP)

`apply-plan` enforces MVP safety layers for commands and file paths:
- Default command timeout: `10000ms` per command operation
- Per-command timeout override: `operations[].timeoutMs`
- Plan-level timeout default override: `execution.commandTimeoutMs`
- Optional plan-level command policy:
  - `execution.commandPolicy.mode: "allow"` requires each command to match at least one substring pattern
  - `execution.commandPolicy.mode: "deny"` blocks commands matching configured substring patterns
- Default file policy keeps file operations inside the current working directory (`process.cwd()`) when apply runs
- Optional file root override: `execution.filePolicy.allowedRoots`
  - Each root may be relative or absolute
  - Relative roots are resolved from `process.cwd()` at apply time
  - File operation paths are resolved locally and denied when outside all allowed roots
- `allowFailure: true` still allows apply to continue for command failures, including timeout/policy denials, with explicit reporting in the apply result
- `apply-plan --dry-run` previews file path safety for each file operation, including resolved path, allowed roots, and explicit denied markers

Example command controls in a draft/plan:

```json
{
  "execution": {
    "commandTimeoutMs": 5000,
    "commandPolicy": {
      "mode": "allow",
      "patterns": ["node -e", "npm test"]
    },
    "filePolicy": {
      "allowedRoots": ["./tmp/safe-root"]
    }
  },
  "operations": [
    {
      "id": "op_cmd_1",
      "type": "command",
      "command": "node -e \"console.log('ok')\"",
      "timeoutMs": 2000,
      "allowFailure": false
    }
  ]
}
```

## Architecture Docs

- [Architecture](docs/architecture.md)
- [Changeset Spec](docs/changeset-spec.md)
- [JSON Schema](schema/planfile.schema.json)
- [Public Launch Demo Script](demo/public-launch-e2e.sh)
- [Coding Agent Demo](docs/coding-agent-demo.md)
- [Use Cases](docs/use-cases.md)
- [GitHub PR Gate Example](docs/github-pr-gate-example.md)

## Quick Start

```bash
npm install
npm test
npm run build
npm run cli -- create-plan --from examples/coding-agent-plan.json --out .plan/quickstart.json
npm run cli -- inspect-plan .plan/quickstart.json
npm run cli -- verify-plan .plan/quickstart.json

# Type-check only
npm run typecheck
```

## Project Status

Early MVP skeleton. Interfaces are coherent and opinionated, but many execution paths are intentionally stubs with explicit `TODO` markers.

## Roadmap

See [TODO.md](TODO.md) for the near-term roadmap and scoped backlog.

## Contributing

Contributions are welcome, especially around:
- Spec clarity and ergonomics
- Safer apply strategies
- Real-world use-case feedback

Process:
1. Open an issue (or pick one from `TODO.md`)
2. Propose a small design in the issue or draft PR
3. Keep changes focused and documented
4. Include examples and docs updates when behavior changes

## License

MIT
