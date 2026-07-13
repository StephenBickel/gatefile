# Gatefile contract hardening design

Date: 2026-07-13

## Problem

Gatefile's policy engine now gives first-party lifecycle adapters one decision
path, but several surrounding contracts still fail open or disagree. The
installed package exposes unsupported kernels, configuration schema and runtime
accept different keys, inspect and pipeline reports omit facts needed by
automation, audit reads unauthenticated repository-local JSON, MCP requests can
select their own authority and signing key, and the reusable Action executes a
consumer repository's `dist/cli.js`. These are release-boundary defects, not
documentation polish.

PR7 makes every machine-facing boundary explicit and testable without changing
plan version 2, the hash envelope, or authenticated state record version 1.

## Considered approaches

### 1. Patch each observed symptom in place

This is the smallest diff, but leaves duplicated schemas, ambient authority, and
several ways to reinterpret the same plan. It would regress easily. Rejected.

### 2. Make each boundary strict around the existing engine

Keep `GatefileEngine` as the lifecycle authority. Normalize configuration once,
embed verification in inspect, make pipeline discovery deterministic, derive
audit from authenticated receipts, expose an allowlisted package root, pin MCP
authority at startup, and make the Action execute action-owned code. Chosen
because it closes the discovered gaps without a plan-format migration.

### 3. Replace the CLI, SDK, MCP, and Action with a new service

A service could centralize all authority, but it would add deployment,
authentication, and compatibility work unrelated to this alpha release.
Rejected.

## Configuration and notifications

`GatefileConfig` has one strict structural runtime and JSON Schema contract:

- `signers` configures trusted signer key IDs and public keys.
- `hooks.beforeApprove` and `hooks.beforeApply` are blocking authorization
  commands owned by the engine.
- `notifications.onPlanCreated` and `notifications.onPlanApproved` are
  best-effort adapter notifications using HTTP(S) webhooks and/or non-empty
  shell commands.

Webhook URL validation is deliberately layered: the schema provides a portable
lowercase HTTP(S) lexical prefilter, while the runtime additionally parses the
authority and port with Node.js before dispatch so undispatchable values fail
closed.

Unknown keys fail closed at every level. Legacy `hooks.onPlanCreated` and
`hooks.onApprovalNeeded` remain a migration alias for notifications, but cannot
be combined with their canonical replacements. Normalization validates and
defensively copies the complete object. CLI adapters pass their engine-pinned
repository root and normalized snapshot to notifications; notification helpers
do not reread ambient CWD config. Existing notification helper names remain as
deprecated compatibility aliases. The `fireOnApprovalNeeded` alias reuses the
canonical approved-plan action but preserves its legacy `approval_needed`
webhook event identifier.

## Inspect, preview, and pipeline reports

`InspectReport` embeds the complete `VerifyPlanReport`. Human formatting and
JSON output consume that same snapshot, so signer trust, readiness, hashes, and
approval state cannot diverge through a second config load. Convenience SDK and
package-root wrappers derive repository identity from the trusted runtime unless
the caller explicitly supplies a trusted runtime override; they never adopt the
plan's asserted repository ID.

Dry-run continues to mean that no mutation was attempted. Its report gains a
static-gate result that separately records verification readiness, dependency
satisfaction, and whether every operation is policy-allowed. It explicitly says
that runtime preconditions were not executed. A completed preview may therefore
have `success: true` while `staticGate.passed` is false. Pipeline dry-run maps a
failed static gate to a failed plan result and retains the full preview report.

Pipeline discovery sorts filenames, validates every JSON input before any
mutation, rejects malformed plan-like documents, reports duplicate IDs and
cycles structurally, and never silently converts an invalid/empty candidate set
into a successful apply. Valid unrelated JSON remains ignorable. Input errors
prevent the entire run. Stable topological ordering makes identical directories
produce identical reports.

## Authenticated audit

Audit becomes a read-only projection of the external authenticated receipt
chains managed by state storage. Repository-local `.gatefile` audit JSON is not
trusted and is ignored. Receipt bodies gain optional, strictly validated audit
metadata: summary, source, approver, approval time, signed/unsigned identity,
and signer key ID. New applies always write it; old authenticated receipts remain
readable with absent metadata.

Receipt enumeration uses the same canonical state layout and verifies each
record and snapshot chain before returning events. Unexpected files, traversal,
symlinks, malformed records, or authentication failures fail closed. Audit CLI
flags select repository root, repository identity, and state home explicitly.
Legacy audit writer exports remain callable only to throw a deprecation error;
they never write unauthenticated state.

## Installed package contract

`package.json` defines an `exports` map for the package root, both JSON schemas,
and package metadata. Unsupported `dist/*` deep imports throw
`ERR_PACKAGE_PATH_NOT_EXPORTED`. The package root becomes an explicit allowlist
of supported engine, SDK, report, attestation, and utility APIs; raw mutation
kernels and legacy audit writers are not root exports.

The packed-package contract test installs the generated tarball into a clean
consumer and exercises CommonJS, ESM, TypeScript declarations, both binaries,
both schemas, exact root keys, and rejected deep imports. It also verifies the
packed file allowlist.

## MCP security and protocol boundary

The MCP server constructs one `GatefileEngine` from trusted startup options.
Tool arguments cannot choose repository root, repository identity, state home,
or signing-key paths. Plan and output paths are relative, no-follow paths
confined beneath the pinned repository. Approval is disabled by default and
never accepts a request-selected private key; apply and rollback are also
disabled unless startup capabilities explicitly enable them. Read-only
inspection and verification remain enabled.

The JSON-RPC decoder validates plain-object messages, exact `jsonrpc: "2.0"`,
non-empty methods, object params, and string or integer request IDs. It never
responds to notifications and keeps the server alive after malformed lines.
Tool schemas and runtime validators reject unknown, missing, or wrongly typed
arguments before I/O. Parse, request, method, and parameter errors map to
`-32700`, `-32600`, `-32601`, and `-32602` respectively.

Command operations invoked through MCP use bounded captured stdout/stderr;
child processes never inherit protocol stdout. Oversized request lines are
rejected before JSON parsing. Server shutdown restores any console interception
used by the adapter.

## Trusted reusable Action

The composite Action resolves the Gatefile package root from
`GITHUB_ACTION_PATH`, installs/builds that action-owned checkout, and executes
its CLI by absolute path. It never executes the consumer workspace's verifier or
caller-supplied install/build commands. The selected plan must be Git-tracked
and unchanged in the checked-out commit.

The Action emits inspect, verify, dry-run, and manifest JSON artifacts. The
manifest binds Gatefile version, plan ID, semantic hash, raw file hash, and head
commit. Evidence upload runs with `if: always()` and fails if artifacts are
missing; the readiness enforcement step runs after evidence generation. Example
workflows pin the Action to an immutable release tag or full commit rather than
`@main`.

For a pull request, policy used to authorize the plan must come from a trusted
base/ref input with a caller-pinned digest. The Action fails closed without that
trusted policy unless the workflow explicitly opts into unsigned/no-policy
mode. A consumer-repository fixture containing a malicious `dist/cli.js` proves
that action-owned code is used.

## Cross-interface invariant

One fixture exercises an installed CommonJS consumer, ESM consumer, CLI, MCP,
and Action harness. All interfaces must report the same plan ID, semantic hash,
verification status, signer trust, and static-gate readiness. No interface may
adopt authority embedded in the plan or reload a different policy snapshot
inside one operation.

## Error handling

Configuration, pipeline input, package resolution, JSON-RPC, path confinement,
trusted-policy, and authenticated-state failures are explicit and fail closed.
Expected apply and rollback failures keep structured reports. Notification
delivery remains best-effort and cannot change an authorization result. Errors
must not include signing-key material or private state contents.

## Test strategy

Tests are written before production changes and cover:

1. runtime/schema config shape parity, layered webhook URL validation,
   unknown-key rejection, legacy migration, and pinned notification execution;
2. single-snapshot inspect JSON/human parity and foreign-repository rejection;
3. deterministic pipeline ordering, malformed input, duplicates, cycles, and
   dry-run static-gate reporting;
4. real authenticated audit events, legacy-file exclusion, old-record
   compatibility, and tamper failure;
5. installed CJS/ESM/TypeScript/bin/schema/export boundaries;
6. MCP malformed messages, notifications, authority override, traversal,
   symlink escape, capability gating, self-approval rejection, and clean stdout;
7. Action consumer isolation, tracked-plan/policy binding, failure artifact
   preservation, and manifest contents;
8. the cross-interface invariant plus the complete unit/integration suite,
   typecheck, public demo E2E, packed consumer, production audit, and GitHub CI.

## Acceptance criteria

PR7 is complete when each contract above is enforced by a regression that fails
on the PR6 tree and passes on the implementation; no supported interface can
select or bypass its authority; all reports agree on identity and readiness; an
independent security/API review finds no critical, important, or minor defect in
the changed boundary; all local validation and GitHub CI pass before merge.
