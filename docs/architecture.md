# Architecture

`planfile` is intentionally small: it separates intent creation from execution.

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
- Applies MVP command safety controls (timeout defaults + optional allow/deny policy matching)
- Returns per-operation result report
- Hard-stops on unsafe or unmet preconditions

6. Risk Engine (`src/risk.ts`)
- Heuristic risk scoring for operations
- Produces rationale to support reviewer decisions

## Data Flow

1. Agent/tool emits draft changeset JSON
2. `create-plan` normalizes + scores risk
3. Reviewer runs `inspect-plan`
4. Reviewer/CI runs `verify-plan`
5. Reviewer or policy system runs `approve-plan`
6. Optional `apply-plan --dry-run` previews plan operations at any stage (pending/approved/tampered)
7. `verify-plan` confirms ready status
8. `apply-plan` re-checks verification, validates preconditions, and applies operations
9. Report emitted for audit/logging

## Design Principles

- Plans are explicit and portable JSON artifacts
- Apply should be deterministic and policy-aware
- Risk is explainable, not magical
- Stubs should be honest and visible
- File and shell actions come first; integrations come later

## Non-goals (MVP)

- Fully sandboxed runtime
- Distributed execution framework
- Rich policy DSL
- Browser/API side-effect executors
