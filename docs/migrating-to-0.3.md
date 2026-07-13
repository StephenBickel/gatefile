# Migrating from Gatefile 0.2 to 0.3 Alpha

Gatefile `0.3.0-alpha.0` is a hardening release, not an in-place data migration.
It intentionally refuses several 0.2 artifacts and execution environments.
Read the [changelog](../CHANGELOG.md) and test the complete workflow in a
disposable checkout before adopting it.

Check whether the exact prerelease is available under npm's `next` tag:

```bash
npm view gatefile@next version
```

If that returns `0.3.0-alpha.0`, install it explicitly; otherwise use a source
checkout:

```bash
npm install --save-dev gatefile@0.3.0-alpha.0
npx --no-install gatefile lint-config
```

Do not use unversioned `npm install gatefile` or `npx gatefile` to evaluate 0.3;
the `latest` tag follows a separate stable-release policy.

## 1. Recreate v1 plans

Pre-v2 plans remain inspectable for forensic and migration work, but Gatefile
0.3 will not approve or apply them. There is no approval migration because the
v2 repository context, risk profile, and hash envelope must be reviewed as new
content.

1. Inspect and archive the old plan.
2. Convert only its intended operations into a new draft.
3. Replace shell strings as described below.
4. Run `create-plan` in the intended repository to generate v2 context, risk,
   integrity, and pending approval metadata.
5. Inspect, verify, and approve the new plan as a new authorization decision.

## 2. Replace shell strings with structured commands

Each command operation now carries an executable and an ordered argument array:

```json
{
  "id": "op_test",
  "type": "command",
  "executable": "npm",
  "args": ["test"],
  "cwd": ".",
  "allowFailure": false
}
```

Gatefile invokes this with `shell: false`. It does not expand variables, parse
redirects, interpolate command substitutions, or perform globbing. If a shell
is deliberately required, make the shell itself the executable and review its
complete argument tuple. Command allow/deny rules now match the exact
`executable` plus ordered `args` tuple; substring rules from 0.2 do not migrate.

## 3. Start with fresh authenticated state

Gatefile 0.3 stores its HMAC key, snapshots, receipts, dependency records, and
rollback claims in the current user's platform state directory outside the
repository. `GATEFILE_STATE_HOME` may override that location, but it must be an
absolute owner-controlled path.

Legacy unsigned `.gatefile/state` records are not migrated. They cannot satisfy
dependencies, appear in authenticated audit output, or authorize rollback in
0.3. Preserve any old checkout and records needed for manual recovery, but do
not copy or rewrite them into the new state home.

State is also bound to the checkout's canonical path and directory identity.
Use a fresh state home after deleting, replacing, or recloning a checkout.

## 4. Migrate configuration and notifications

The runtime and published configuration Schema now share one strict shape.
Unknown fields fail closed. Use this canonical layout:

```json
{
  "hooks": {
    "beforeApprove": { "command": "node ./scripts/before-approve.js" },
    "beforeApply": { "command": "node ./scripts/before-apply.js" }
  },
  "notifications": {
    "onPlanCreated": { "webhook": "https://example.com/plan-created" },
    "onPlanApproved": { "shell": "notify-send 'plan approved'" }
  },
  "signers": {
    "trustedKeyIds": ["gfk1_581597490e0f9380"],
    "trustedPublicKeys": ["-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3BpXovQEPSywMnUz4IdaCBTGcIH+6gRV9kt1SMjg7bE=\n-----END PUBLIC KEY-----"]
  }
}
```

`hooks.beforeApprove` and `hooks.beforeApply` are blocking policy commands.
Lifecycle notifications are best-effort and belong under `notifications`.
Deprecated `hooks.onPlanCreated` and `hooks.onApprovalNeeded` inputs have a
limited compatibility normalization path, but new 0.3 configurations should
move them to `notifications.onPlanCreated` and
`notifications.onPlanApproved`. Run `lint-config` before rollout.

## 5. Regenerate signer identities

Signer IDs are derived from the canonical Ed25519 public key and have the form
`gfk1_` followed by 16 lowercase hexadecimal characters. Do not reuse arbitrary
0.2 labels as key IDs.

```bash
npx --no-install gatefile generate-attestation-key \
  --out-private "$HOME/.config/gatefile/approver.pem" \
  --out-public .gatefile/approver.pub.pem
```

Copy the generated key ID and public key into the trust policy. Keep the private
key outside the repository. A valid signature proves possession of that key;
your key-distribution and trust-policy process supplies the mapping to a person
or organizational role.

## 6. Update MCP launchers

The packaged `gatefile-mcp` and `gatefile mcp` entrypoints pin repository and
state authority from their startup context. Their default tools can create,
inspect, verify, and preview plans but cannot approve, apply, or roll back.
Remove any automation that expects request arguments to select a repository,
state home, signer, or mutation authority.

Trusted operator-owned code may import `startMcpServer` and enable mutation
capabilities at startup. Approval identity and signing material must also be
provided out of band by that launcher; tool requests cannot supply them.

## 7. Replace deep imports

Imports such as `gatefile/dist/applier` are blocked by the package export map.
Use only:

- the documented `gatefile` package root;
- `gatefile/schema/gatefile.schema.json`;
- `gatefile/schema/gatefile.config.schema.json`; or
- `gatefile/package.json`.

`GatefileEngine` is the primary in-memory lifecycle boundary. Package-root
lifecycle helpers remain alpha compatibility wrappers around it.

## 8. Replace consumer-built GitHub gates

Do not build or run pull-request-controlled Gatefile code as the gate. Use the
commit-pinned reusable Action shown in
[the GitHub PR gate guide](github-pr-gate-example.md). The workflow must:

- run before any consumer pull-request code;
- pin every Action by full commit SHA;
- provide a full trusted base commit and the expected policy-file SHA-256;
- require the plan to be tracked and unchanged from `HEAD`; and
- enforce the result through a protected required workflow or ruleset.

Repositories intentionally evaluating without signer policy must opt in with
`allow-unsigned-no-policy: "true"`; that mode does not establish signer trust.

## 9. Update file-backed artifact handling

CLI, SDK, interactive-review, configuration, and pipeline JSON inputs must now
be regular files with exactly one hard link. User-controlled ancestor symlinks,
all final symlinks, and special files are rejected; root-owned platform path
aliases such as macOS `/var` remain usable. The input limit is 16 MiB. File-backed private signing keys
are capped at 64 KiB.

Commands that produce a new artifact, including `create-plan`, `adapt-agent`,
and file-backed PR-comment rendering, are create-only: they refuse to replace
an existing path or follow a symlink. Move or delete an obsolete output
explicitly before regenerating it. `approve-plan`, the SDK approval helper, and
interactive review are the exception: they atomically replace only the exact
regular-file revision they read. If a hook, editor, or generator changes the
plan in between, approval fails and the reviewer must reopen the new plan.

These rules intentionally trade some 0.2 convenience for a consistent
fail-closed boundary across the file-backed interfaces.

## 10. Confirm the platform boundary

Gatefile 0.3 requires Node.js 22 or newer for its supported release baseline.
File execution and authenticated state require POSIX ownership and permission
semantics. Windows fails closed until equivalent private-DACL enforcement
exists.

On POSIX systems, managed roots and files must be owned by the effective user
and must not be group/world writable. Extended ACLs are rejected. macOS targets
with security-sensitive extended attributes are refused; Linux updates preserve
extended attributes or fail closed. Every target parent directory must already
exist.

## Verification checklist

Before using 0.3 outside a disposable checkout:

1. Run `npx --no-install gatefile lint-config`.
2. Recreate, inspect, and approve a representative v2 plan.
3. Confirm `verify-plan` reports the expected repository and signer trust state.
4. Run `apply-plan --dry-run` and require `staticGate.passed` before execution.
5. Apply and roll back an inert file-only plan with a fresh state home.
6. Exercise the pinned GitHub Action on both a ready and a rejected plan.
7. Archive the exact package version, policy digest, and evidence artifacts used
   for the evaluation.
