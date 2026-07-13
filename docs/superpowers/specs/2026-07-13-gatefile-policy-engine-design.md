# Gatefile policy engine design

Date: 2026-07-13

## Problem

Gatefile currently exposes one plan lifecycle through several independent call
graphs. The CLI usually loads `gatefile.config.json`, but the SDK and pipeline do
not. MCP approval and the interactive reviewer call the planner directly, so
they bypass `beforeApprove`. Git preconditions are evaluated against the process
working directory instead of the repository selected by the caller. These are
policy differences, not presentation differences: the same approved plan can be
blocked by one interface and applied by another.

PR6 must give every first-party plan-lifecycle interface one authorization path
without expanding Gatefile's alpha feature set.

## Considered approaches

### 1. Add a facade and leave adapters unchanged

This is the smallest source change, but it does not remove any bypass. The class
would be optional documentation rather than an enforceable boundary. Rejected.

### 2. One orchestration engine with compatibility wrappers

`GatefileEngine` owns the canonical runtime context and all policy-sensitive
lifecycle decisions. CLI, SDK, MCP, interactive review, pipeline execution, and
PR review rendering delegate to it. Existing package-root lifecycle functions
remain available as compatibility wrappers that construct the same engine. Pure
algorithms and formatters stay separate. Chosen because it closes current
bypasses while keeping the implementation reviewable.

### 3. Move every pure algorithm and all file I/O into a monolithic class

This would make the class the physical owner of hashing, validation, rendering,
and persistence as well as authorization. It creates unnecessary mutable state,
large circular dependencies, and a high-risk rewrite. Rejected.

## Engine boundary

Construction accepts a `GatefileEngineOptions` object:

- `repoRoot`: resolved once to the canonical Git top-level, or canonical selected
  directory outside Git.
- `repositoryId`: explicit integration override, otherwise derived once from the
  canonical root.
- `stateHome`: optional trusted external state directory input. The effective
  explicit/environment/platform-default path is resolved once at construction
  and forwarded consistently to inspection, preview, apply, rollback, and
  pipeline operations.
- `config`: optional explicit configuration. It is normalized and defensively
  copied at construction.

When no explicit config is supplied, the engine reloads config from its pinned
repository before each policy-sensitive operation. This makes signer revocation
and hook changes visible to a long-running MCP process. A single operation loads
one normalized config snapshot and uses it for all checks in that operation.

The engine exposes read-only runtime context and these methods:

- `createPlan(draft)`
- `inspectPlan(plan)` and `formatInspectPlan(plan, report)`
- `approvePlan(plan, approvedBy, signing/options)`
- `verifyPlan(plan)`
- `previewPlan(plan, options)`
- `applyPlan(plan, options)`
- `rollbackApply(receiptId)`

Approval validates the plan, checks that its repository context matches the
engine, and runs `beforeApprove` before producing an approval. Preview and apply
use the same signer policy, repository identity, state home, and config snapshot.
Apply continues to run `beforeApply` only after non-mutating command, file, state,
and size preflight succeeds.

## What remains outside the engine

Canonical hashing, schema validation, risk scoring, formatting, agent-input
adaptation, attestation cryptography, and key generation are pure or
presentation-only functions. They cannot authorize an apply and remain reusable
modules. Plan JSON reading/writing remains in adapters, but every decision made
from the parsed plan goes through the engine.

Legacy package-root lifecycle functions are policy-aware compatibility wrappers,
not alternate implementations. The alpha package currently ships its whole
`dist` tree without an `exports` map, so unsupported deep imports remain
physically reachable. PR6 closes supported package-root and first-party adapter
bypasses; PR7 will make the installed-package export contract explicit.

Audit storage and the split best-effort notification-hook config are deliberately
not redesigned in PR6. Their legacy repository-local/config contracts and
installed-artifact behavior are part of the explicitly separate PR7 repair.
Notification hooks remain adapter-owned in this PR because they are outbound
events, not authorization checks.

## Adapter data flow

1. An adapter parses arguments and plan JSON.
2. It constructs one engine for the requested canonical runtime context.
3. It calls one engine lifecycle method.
4. It performs presentation or plan-file persistence only after the method
   returns successfully.

Specific migrations:

- CLI commands share engine construction and stop importing planner, verifier,
  inspector, and applier lifecycle functions directly.
- SDK file helpers construct an engine from SDK options. Approval gains signing
  and runtime options; rollback gains a file-level SDK entry point.
- MCP creates one pinned engine per tool call. Approval accepts the same optional
  repository context needed to locate policy config.
- Interactive review accepts an engine and uses it for both non-TTY inspection
  and TTY approval.
- Pipeline constructs one engine and reuses it for every plan in the run.
- PR review rendering obtains missing inspect/verify reports from an engine.

## Policy invariants

- No first-party adapter imports or calls raw lifecycle primitives.
- A configured signer allowlist has identical results in CLI, SDK, MCP, preview,
  apply, inspect formatting, and pipeline.
- `beforeApprove` blocks CLI, SDK, MCP, and interactive approval before any plan
  file is rewritten.
- `beforeApply` and its configured `cwd` behave identically on every apply path.
- Git branch and cleanliness preconditions execute in the engine's canonical
  repository, never ambient process CWD.
- Repository ID and state home cannot vary between verification and execution in
  one engine operation.
- Invalid or changed config fails closed before approval or execution.

## Error handling

Engine methods keep the existing typed reports for expected apply/rollback
failures and throw for invalid input, policy denial, or context mismatch. Adapters
retain their transport conventions: CLI nonzero exit, MCP `isError`, SDK rejected
promise, and pipeline failed plan result. A blocked approval never writes the
plan file. No adapter catches a policy denial and retries through a lower-level
primitive.

## Test strategy

Tests are added before implementation and cover:

1. engine context canonicalization and per-operation config reload;
2. repository mismatch rejection during approval;
3. signer policy parity for engine verify, preview, apply, SDK, MCP, and pipeline;
4. `beforeApprove` parity and no-write behavior;
5. `beforeApply` configured working directory;
6. Git preconditions from a process CWD outside the selected repository;
7. static adapter import conformance, preventing future raw-primitive bypasses;
8. package-root compatibility wrappers and installed TypeScript declarations;
9. existing full unit/integration suite, typecheck, public demo E2E, and packed
   package consumer checks.

## Acceptance criteria

PR6 is complete when all supported package-root and first-party lifecycle call
graphs pass through `GatefileEngine`, the new parity regressions fail on the
pre-PR6 code and pass on the implementation, all existing behavior remains green,
an independent review finds no policy bypass in that boundary, and GitHub CI
passes before merge.
