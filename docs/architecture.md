# Architecture

`gatefile` is intentionally small: it separates intent creation from execution.

## Layers

1. First-party adapters (`src/cli.ts`, `src/sdk.ts`, `src/pipeline.ts`,
   `src/review.ts`, `src/pr-review.ts`, `src/mcp.ts`)
- Parse CLI, file, pipeline, review, and MCP transports
- Construct or receive a `GatefileEngine` for the selected runtime context
- Delegate policy-sensitive lifecycle decisions to the engine
- Retain adapter-owned plan JSON I/O, presentation, audit calls, and outbound
  notification delivery

2. Policy engine (`src/engine.ts`)
- `GatefileEngine` is the primary supported in-memory lifecycle boundary
- Pins an immutable canonical repository root, repository ID, and external state
  home when constructed
- Reloads default repository config once per policy-sensitive method, or uses
  the normalized defensive snapshot supplied explicitly at construction
- Passes one effective config snapshot and the pinned context through every
  policy check performed by that method
- Keeps authenticated rollback independent of repository config parsing so
  malformed policy cannot make recovery unavailable
- Exposes create, inspect/format, approve, verify, preview, apply, and rollback

3. Planner (`src/planner.ts`)
- Validates shape
- Adds metadata (ids, timestamps)
- Computes risk profile
- Computes deterministic plan hash over normalized content
- Returns a normalized plan artifact

4. Preconditions (`src/preconditions.ts`)
- Runs guard checks before apply
- Evaluates Git state in the engine's pinned canonical repository
- Examples: clean Git tree, expected branch, required environment variables

5. Verifier and inspector (`src/verify.ts`, `src/inspect.ts`)
- Computes current deterministic hash
- Checks integrity metadata presence + hash match
- Checks approval/hash binding
- Evaluates signer trust and dependency status using engine-supplied context
- Returns structured readiness, blockers, and inspection data

6. Applier and authenticated state (`src/applier.ts`, `src/state.ts`)
- `previewPlan` returns side-effect-free operation previews and includes verification status/blockers
- `applyPlan` executes approved operations in order
- Executes structured executable/argument arrays with `shell: false`
- Applies timeout defaults plus optional exact-tuple allow/deny policy matching
- Writes versioned, HMAC-authenticated snapshots and apply receipts in an
  owner-controlled state home outside the repository
- Publishes an authenticated write-ahead receipt before widening staged-file
  metadata or committing a target, then finalizes it after execution; once the
  intent is durable, rollback can distinguish an unchanged before-state from a
  committed after-state after a crash or late receipt-publication failure
- Enforces plan dependency sequencing (`dependsOn`) via authenticated successful
  apply state, with a durable write-ahead deny marker that prevents an
  fsync-ambiguous cache from authorizing dependents
- Applies symlink-resistant, exact-byte file operations with atomic replacement
- Refuses rollback on state tampering, post-apply drift, unsafe paths, or replay
- Invalidates direct and transitive dependency state as soon as rollback is
  claimed; successful authenticated rollback also clears a matching stale
  dependency-publication marker so the plan can be applied again
- Returns per-operation result report with rollback receipt/snapshot metadata
- Hard-stops on unsafe or unmet preconditions

7. Risk engine and pure helpers (`src/risk.ts` and focused modules)
- Heuristic risk scoring for operations
- Produces rationale to support reviewer decisions
- Keeps hashing, validation, adaptation, formatting, attestation cryptography,
  and key generation reusable outside the authorization boundary

## Supported API boundary

All first-party lifecycle adapters now pass through `GatefileEngine`. The
package-root lifecycle exports `createPlanFromDraft`, `approvePlan`, `verifyPlan`,
`buildInspectReport`, `previewPlan`, `applyPlan`, and `rollbackApply` are
engine-backed compatibility wrappers, not independent policy implementations.

The planner, verifier, inspector, and applier kernels remain internal building
blocks. Deep `dist/*` imports are unsupported, but they are not yet technically
blocked: this alpha still ships the complete `dist` tree without a package
`exports` map. PR7 will define that installed-package boundary. PR6 also does not
redesign legacy audit storage or the split best-effort notification-hook config;
those audit/config/package contracts remain separate PR7 work.

## Adapter Data Flow

1. An adapter parses arguments, transport input, and any plan JSON.
2. It constructs or receives an engine pinned to the requested runtime context.
3. The selected top-level method resolves one config snapshot and delegates to
   the focused lifecycle kernels with that snapshot and pinned context.
4. Only after the engine method succeeds does the adapter persist plan JSON or
   render/return the result.

## Plan Lifecycle

1. Agent/tool emits draft changeset JSON
2. `create-plan` normalizes + scores risk
3. Reviewer runs `review` (interactive TUI) or `inspect-plan` (non-interactive)
4. Reviewer/CI runs `verify-plan`
5. Reviewer or policy system runs `approve-plan`
6. Optional `apply-plan --dry-run` previews plan operations at any stage (pending/approved/tampered)
7. `verify-plan` confirms ready status
8. `apply-plan` re-checks verification, validates preconditions, and applies operations
9. Apply report includes receipt/snapshot IDs and rollback command guidance
10. Optional `rollback-apply` verifies the authenticated receipt/snapshot chain,
    preflights every current file state, claims the receipt against replay, and
    restores Gatefile-managed file operations

Authenticated state is bound to the canonical checkout path and its directory
device/inode. Moving or replacing a live checkout changes that binding. Portable
Node.js does not expose inode generations, so an immediate delete/recreate that
reuses the same inode at the same path is indistinguishable; operators must use a
fresh state home after deleting or recloning a checkout. Rollback claims are deliberately one-shot in this alpha: a
failure or crash after claiming invalidates dependencies and prevents automatic
retry of that receipt.

## Design Principles

- Plans are explicit and portable JSON artifacts
- Apply should be deterministic and policy-aware
- Risk is explainable, not magical
- Stubs should be honest and visible
- File and structured command actions come first; integrations come later

## Non-goals (MVP)

- Fully sandboxed runtime
- Distributed execution framework
- Rich policy DSL
- Automatic rollback for arbitrary command side effects
- Protection from any concurrent actor that can mutate the allowed filesystem
  namespace between validation and commit
- Transactional rollback across multiple files
- Browser/API side-effect executors
