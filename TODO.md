# Roadmap

This project stays intentionally MVP-sized: local CLI, schema-backed plans, hash-bound approvals, and verification before apply.

## Public Launch (MVP)

1. Publish one end-to-end demo from plan creation through rejected/approved apply.

## Recently Completed

1. Added `gatefile inspect-plan --json` for machine-readable CI and policy checks, while keeping concise default human inspect output.
2. Added inspect CLI coverage for both default and `--json` output modes.
3. Documented a practical GitHub PR gate flow using `verify-plan` and uploaded plan artifacts.
4. Added `apply-plan --dry-run` preview mode that reports planned file/command actions without executing writes, commands, or precondition checks, and includes readiness/verification state even before approval.
5. Added MVP command hardening for apply: optional allow/deny substring policy and default/per-command timeout behavior with explicit failure reporting.
6. Expanded apply tests for allowed commands, denied commands, timeout failures, and `allowFailure` continuation behavior.
7. Added MVP file path hardening for apply: deterministic allowed-root checks (defaulting to workspace cwd), explicit deny reporting for outside-root paths, and dry-run path safety previews.
8. Added `apply-plan --human` condensed output for dry-run/apply previews while preserving JSON output by default.
9. Added MVP recovery guidance in dry-run/apply reports (affected paths, per-operation manual recovery hints, and partial-apply context) without claiming transactional rollback.
10. Added reusable GitHub PR gate composite action and copy-paste workflow examples for fast adoption.
11. Updated CI and workflow examples to current GitHub Action majors (`checkout/setup-node/upload-artifact` v5) and Node 22.
12. Added repo-local `.gatefile/state` apply receipts and pre-apply file snapshots, plus `rollback-apply` restore support for Gatefile-managed file operations.
13. Added `gatefile.config.json` policy hooks for `beforeApprove` and `beforeApply`, including structured stdin/env context and clear block errors.
14. Added plan dependency sequencing via `dependsOn` with apply-time enforcement against successful prior receipts, surfaced in inspect/dry-run/apply output.
15. Added signer trust policy in `gatefile.config.json` (`trustedKeyIds` / `trustedPublicKeys`) with verify/apply enforcement and trust-state reporting.
16. Added GitHub-native signed approval workflow example with secrets-safe key handling for PR branches.
17. Added `gatefile lint-config` plus strict signer trust config validation (malformed PEM, empty trust policy, invalid shapes) and canonical PEM matching for trust checks.
18. Added fork-safe GitHub signed-approval artifact handoff workflow examples (no push to fork PR branches from signing workflow).

## After Launch (Small Backlog)

1. Add optional branch-protection wiring examples for artifact-based signed approval checks.
