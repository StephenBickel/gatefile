# Changeset Spec (MVP)

This document defines the initial JSON schema shape used by `planfile`.
The machine-readable schema for this MVP lives at `schema/planfile.schema.json`.

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
      "patterns": ["node -e", "npm test"]
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
    "canonicalizer": "planfile-v1",
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
  "command": "npm test",
  "cwd": ".",
  "timeoutMs": 5000,
  "allowFailure": false
}
```

`timeoutMs` is optional and must be > 0 when set.

## Execution Controls (MVP)

Optional top-level `execution` supports lightweight command hardening:
- `commandTimeoutMs`: default timeout for command operations (ms, > 0)
- `commandPolicy`:
  - `mode: "allow"` means command text must include at least one pattern substring
  - `mode: "deny"` means command text must not include any matching pattern substring
  - `patterns`: string list used for substring matching
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
