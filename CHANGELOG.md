# Changelog

All notable Gatefile changes are recorded here. Gatefile is experimental alpha
software; prerelease interfaces and file formats may still change before a
stable release.

## Unreleased

- No unreleased changes documented.

## 0.3.0-alpha.0

The npm distribution policy for this prerelease uses the `next` tag. Promotion
to the unversioned `latest` tag requires a separate stable-release decision;
confirm registry availability with `npm view gatefile@next version`.

### Breaking changes

- Replaced legacy plans with the strict v2 plan contract. Pre-v2 plans remain
  inspectable but cannot be approved or applied; recreate and re-approve them.
- Replaced shell command strings with structured `executable` plus ordered
  `args` arrays. Command policy rules match the exact tuple.
- Moved snapshots, receipts, replay claims, dependency state, and the HMAC key
  out of the repository into an owner-controlled platform state directory.
  Legacy unsigned `.gatefile/state` data is not migrated.
- Tightened file execution to owner-controlled POSIX filesystems. The 0.3
  release baseline is Node.js 22 or newer; Windows execution fails closed.
- Made file-backed CLI and SDK outputs create-only. Plan approval and interactive
  review now replace only the exact artifact revision that was read; delete or
  move an obsolete output explicitly before regenerating it.
- Made configuration strict. Blocking policy hooks remain under `hooks`, while
  lifecycle delivery uses `notifications.onPlanCreated` and
  `notifications.onPlanApproved`.
- Derived signer IDs from canonical Ed25519 public keys. Operator-selected key
  labels are no longer valid signer IDs.
- Restricted installed package specifiers to the reviewed package root, both
  JSON Schemas, and package metadata. `gatefile/dist/*` deep imports are not a
  supported API.
- Changed the packaged MCP server to expose only create, inspect, verify, and
  dry-run tools by default. Approve, apply, and rollback require trusted
  programmatic startup capabilities and out-of-band approval authority.
- Replaced consumer-built PR gating with an action-owned, commit-pinned
  reusable Action that verifies a tracked plan and trusted policy snapshot.

### Added

- `GatefileEngine`, a repository/state-pinned policy boundary shared by the
  CLI, SDK, pipeline, review, PR renderer, and MCP adapters.
- Ed25519 approval attestations, derived signer IDs, signer trust policy, and
  fork-safe artifact-handoff workflow examples.
- Authenticated external snapshots and apply receipts, write-ahead mutation
  records, replay-resistant rollback, and dependency-state invalidation.
- Deterministic dry-run static-gate evidence, fail-closed pipeline discovery,
  and cross-interface conformance tests.
- An explicit installed-package export contract and installed-consumer tests.
- A confined, startup-pinned MCP authority model with strict JSON-RPC and
  bounded command-output handling.
- A manifest-bound reusable GitHub Action that preserves evidence before final
  enforcement.

### Security and compatibility

- File operations now reject symlink traversal, unexpected bytes, unsafe
  ownership/modes, unsupported ACLs or security-sensitive macOS attributes,
  target overlap, and post-apply drift.
- CLI, SDK, review, config, and pipeline JSON inputs now reject user-controlled
  ancestor and all final symlinks, require regular single-link files, and are
  capped at 16 MiB. Approval publication is
  revision-checked and atomic, and webhook failures no longer expose endpoint
  credentials, paths, or query strings in logs.
- Audit output is projected only from authenticated external receipt/snapshot
  chains; repository-local legacy audit JSON is not trusted.
- Signatures prove possession of a signing key. A repository trust policy maps
  that key to an operator-defined person or role; Gatefile does not establish a
  human's legal identity.
- Added an explicit [security policy](SECURITY.md) and
  [0.3 migration guide](docs/migrating-to-0.3.md).
