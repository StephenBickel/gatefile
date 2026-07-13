# Architecture

`gatefile` is intentionally small: it separates intent creation from execution.

## Layers

1. CLI (`src/cli.ts`)
- Parses commands
- Reads/writes plan files
- Calls planner/verify/applier modules

2. Planner (`src/planner.ts`)
- Validates shape
- Adds metadata (ids, timestamps)
- Computes risk profile
- Computes deterministic plan hash over normalized content
- Returns a normalized plan artifact

3. Preconditions (`src/preconditions.ts`)
- Runs guard checks before apply
- Examples: clean git tree, expected branch, required env vars

4. Verifier (`src/verify.ts`)
- Computes current deterministic hash
- Checks integrity metadata presence + hash match
- Checks approval/hash binding
- Returns a simple ready/not-ready status with blockers

5. Applier (`src/applier.ts`)
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

6. Review TUI (`src/review.ts`)
- Interactive terminal UI for reviewing plans
- Colored diff preview, keyboard navigation, approve/reject
- Falls back to inspect output if stdin is not a TTY

7. Risk Engine (`src/risk.ts`)
- Heuristic risk scoring for operations
- Produces rationale to support reviewer decisions

## Data Flow

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
