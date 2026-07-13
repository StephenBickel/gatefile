# Changeset Spec (MVP)

This document defines the initial JSON schema shape used by `gatefile`.
The machine-readable schema for this MVP lives at `schema/gatefile.schema.json`.

## Top-Level Shape

```json
{
  "version": "0.1",
  "id": "plan_...",
  "createdAt": "2026-03-16T00:00:00.000Z",
  "source": "agent-name",
  "summary": "Short intent summary",
  "operations": [],
  "preconditions": [],
  "execution": {
    "commandTimeoutMs": 10000,
    "commandPolicy": {
      "mode": "allow",
      "rules": [
        { "executable": "/usr/local/bin/node", "args": ["--version"] }
      ]
    },
    "filePolicy": {
      "allowedRoots": ["./tmp/safe-root"]
    }
  },
  "risk": {
    "score": 0,
    "level": "low",
    "reasons": []
  },
  "integrity": {
    "algorithm": "sha256",
    "canonicalizer": "gatefile-v1",
    "planHash": "..."
  },
  "approval": {
    "status": "pending"
  }
}
```

## Operation Types

### File Operation

```json
{
  "id": "op_file_1",
  "type": "file",
  "action": "update",
  "path": "src/index.ts",
  "before": "old text (optional in MVP)",
  "after": "new text"
}
```

Allowed actions:
- `create`
- `update`
- `delete`

### Command Operation

```json
{
  "id": "op_cmd_1",
  "type": "command",
  "executable": "/usr/local/bin/npm",
  "args": ["test"],
  "cwd": ".",
  "timeoutMs": 5000,
  "allowFailure": false
}
```

`timeoutMs` is optional and must be an integer from 1 through 2,147,483,647 milliseconds when set.

Gatefile passes `args` directly to the executable with `shell: false`. It does not perform shell parsing, interpolation, globbing, redirects, or command composition. An explicitly selected shell such as `sh` is still an executable and is safe only when its complete argument tuple is deliberately reviewed and allowed.

## Execution Controls (MVP)

Optional top-level `execution` supports lightweight command hardening:
- `commandTimeoutMs`: default timeout for command operations (integer from 1 through 2,147,483,647 milliseconds)
- `commandPolicy`:
  - `rules`: a non-empty list of `{ "executable": string, "args": string[] }` tuples
  - `mode: "allow"` means the executable and complete ordered argument array must exactly match a rule
  - `mode: "deny"` blocks only an exact tuple match; use allow mode for a strong execution boundary
  - rules use lexical executable identity. Prefer absolute executable paths: a bare name such as `node` trusts the process `PATH`
  - `cwd` is hash-bound as reviewed plan content but is not part of a command-policy rule; use a trusted working directory
- `filePolicy`:
  - `allowedRoots`: list of allowed roots for file operations (`create`, `update`, `delete`)
  - if omitted (or empty), allowed roots default to the current working directory (`process.cwd()`) at apply time
  - each file operation path is resolved locally and denied when outside all allowed roots

## Preconditions

MVP precondition kinds:
- `git_clean`
- `branch_is`
- `env_present`

Example:

```json
{
  "kind": "branch_is",
  "value": "main",
  "description": "Only apply on main"
}
```

## Approval

`approval.status` values:
- `pending`
- `approved`
- `rejected`

On approval, add:
- `approvedBy`
- `approvedAt`
- `approvedPlanHash` (must match `integrity.planHash` at approval time)

## Integrity

`integrity.planHash` is computed from a normalized representation of:
- `version`
- `source`
- `summary`
- `operations`
- `preconditions`
- `execution`

MVP note: this is deterministic local hashing, not external signing/attestation.

## Compatibility

- `version` is required
- Unknown fields should be ignored by readers
- Breaking schema changes must bump minor/major version

## Verification Report (`verify-plan`)

`verify-plan` emits a JSON report with:
- `checks.integrityMetadataExists`
- `checks.recordedHashMatchesCurrent`
- `checks.approvalBoundToCurrentHash`
- `readyToApplyFromIntegrityApproval`
- `status` (`ready` or `not-ready`)
- `blockers` (human-readable reasons when not ready)

## Inspect Output (`inspect-plan`)

- Default output is concise, human-readable summary text.
- `inspect-plan --json` emits machine-readable JSON for CI/policy systems.
