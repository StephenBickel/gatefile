# Roadmap

This project stays intentionally MVP-sized: local CLI, schema-backed plans, hash-bound approvals, and verification before apply.

## Public Launch (MVP)

1. Publish one end-to-end demo from plan creation through rejected/approved apply.
2. Add an optional condensed human formatter for dry-run previews.
3. Add rollback guidance for multi-step apply failures.

## Recently Completed

1. Added `planfile inspect-plan --json` for machine-readable CI and policy checks, while keeping concise default human inspect output.
2. Added inspect CLI coverage for both default and `--json` output modes.
3. Documented a practical GitHub PR gate flow using `verify-plan` and uploaded plan artifacts.
4. Added `apply-plan --dry-run` preview mode that reports planned file/command actions without executing writes, commands, or precondition checks, and includes readiness/verification state even before approval.
5. Added MVP command hardening for apply: optional allow/deny substring policy and default/per-command timeout behavior with explicit failure reporting.
6. Expanded apply tests for allowed commands, denied commands, timeout failures, and `allowFailure` continuation behavior.
7. Added MVP file path hardening for apply: deterministic allowed-root checks (defaulting to workspace cwd), explicit deny reporting for outside-root paths, and dry-run path safety previews.

## After Launch (Small Backlog)

1. Introduce policy hook interfaces (`beforeApprove`, `beforeApply`).
2. Add extension points for signing/attestation workflows.
