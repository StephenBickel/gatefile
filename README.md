# gatefile

[![CI](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gatefile)](https://www.npmjs.com/package/gatefile)

**Terraform for AI agent side effects.**

**Status: Experimental alpha — not production-ready.** Gatefile is under stabilization; interfaces, file formats, and security behavior may change before a stable release. Evaluate it in controlled environments, and do not rely on it as the sole security boundary for production agent execution.

![gatefile demo](demo.gif)

Your AI agent wants to edit 14 files and run 3 commands. Do you trust it?

`gatefile` makes agent side effects explicit, reviewable, and approvable — before anything executes.

```bash
npx gatefile review .plan/plan.json          # interactive TUI: inspect, approve, or reject
npx gatefile inspect-plan .plan/plan.json    # see exactly what the agent wants to do
npx gatefile approve-plan .plan/plan.json    # approve the hash-locked plan
npx gatefile apply-plan .plan/plan.json --yes # execute with safety guardrails
```

## Why

Agent tooling is good at *doing* things but weak at *governing* side effects.

- Hidden file edits buried in PR-sized bursts
- Commands with unclear blast radius
- No durable artifact for review, approval, or audit
- Tests verify behavior *after* changes. Traces show what happened *during*. Neither gives you a machine-readable **intent contract** *before* execution

Today, teams rely on prompts and trust. That doesn't scale.

## How It Works

```
Agent emits plan → Human reviews → Approve hash → Apply with guardrails → Rollback if needed
```

## Who Is This For?

**Engineering teams evaluating future autonomous-agent production workflows.** During alpha, treat this as a controlled-evaluation scenario, not a production deployment recommendation: your agent proposes a database migration, a config rewrite, and a deploy script. Gatefile demonstrates agent-speed planning with human-gated execution.

**DevOps teams building AI-powered CI/CD.** When an agent is part of your pipeline — auto-fix, auto-refactor, auto-migrate — you need a machine-readable checkpoint between "agent proposed this" and "this actually ran." Gatefile is that checkpoint, with a GitHub Action ready to drop into any workflow.

**Regulated industries.** Finance, healthcare, government — anywhere an auditor asks "who authorized this change?" Gatefile's signed attestations give you cryptographic proof of who approved what, when, bound to the exact plan hash.

**Not for you if:** you're a solo developer comfortable with Claude Code or Codex full-auto on low-stakes code. If the blast radius is small and reversible, you don't need governance — just `git revert`.

## How Is This Different?

| | Claude Code / Codex | Git + PR Review | Gatefile |
|---|---|---|---|
| **Scope** | Interactive session approval | Code diffs only | File edits + structured commands + preconditions |
| **Durability** | Disappears with the session | Commit history | Persistent plan artifact on disk |
| **Tamper detection** | None | Git hash (post-merge) | Hash-locked before execution |
| **Identity proof** | None | GitHub commit signing | Ed25519 signed attestation |
| **Audit trail** | Terminal scrollback | PR comments | Structured receipts + snapshots |
| **CI integration** | Manual | Native | Native (GitHub Action included) |
| **Agent-agnostic** | Tied to one agent | N/A | Any agent, any framework |

Claude Code asks "can I run this?" and you click yes. Gatefile makes the "yes" a durable, tamper-evident, auditable artifact.

## Quick Start

```bash
npm install gatefile
```

### See It Work (30 seconds)

```bash
git clone https://github.com/StephenBickel/gatefile.git
cd gatefile && npm install
npm run demo:e2e
```

The demo runs the full flow: create → inspect → verify → approve → dry-run → denied unsafe path → safe apply → PR gate.

### Basic Flow

```bash
# 1. Agent creates a plan declaring its intended side effects
gatefile create-plan --from examples/coding-agent-plan.json --out .plan/plan.json

# Interactive review (TUI with diff preview, approve/reject)
gatefile review .plan/plan.json

# Non-interactive inspection
gatefile inspect-plan .plan/plan.json

# 3. Machine-readable for CI
gatefile inspect-plan .plan/plan.json --json

# 4. Check integrity
gatefile verify-plan .plan/plan.json

# 5. Preview without executing
gatefile apply-plan .plan/plan.json --dry-run

# 6. Approve — binds to exact plan hash
gatefile approve-plan .plan/plan.json --by steve

# 7. Execute with guardrails
gatefile apply-plan .plan/plan.json --yes

# 8. Roll back file operations if needed
gatefile rollback-apply <receipt-id> --yes
```

### With Signed Approvals

For environments that need cryptographic proof of who approved:

```bash
# Generate a signing key
install -d -m 700 "$HOME/.config/gatefile"
gatefile generate-attestation-key \
  --out-private "$HOME/.config/gatefile/approval-key.pem" \
  --out-public .gatefile/approval-key.pub.pem

# Approve with signature
gatefile approve-plan .plan/plan.json --by steve \
  --signing-key "$HOME/.config/gatefile/approval-key.pem"

# Validate config + trust policy
gatefile lint-config
```

## Real-World Use Cases

### 1. Coding Agent in a Monorepo

An agent proposes a refactor touching 30 files across 4 packages. Without Gatefile, you either read every diff interactively or trust full-auto. With Gatefile, the agent emits a plan, your tech lead reviews the operation summary and risk scores, approves the hash, and apply executes only what was approved.

### 2. Future scenario: Production Ops Automation

Controlled evaluation only while Gatefile is alpha: an ops agent wants to rotate configs, restart a service, and validate health. The plan declares the exact file changes, commands, and preconditions (must be on `main`, must have `ALLOW_OPS_APPLY` set). Apply refuses if preconditions fail, and every action is receipted for rollback.

### 3. CI Gate for Agent PRs

An agent opens PRs autonomously. Your CI pipeline runs `gatefile verify-plan` as a required status check. No approved plan, no merge. The PR includes machine-readable intent so reviewers see exactly what will happen — not just what code changed.

### 4. Compliance Audit Trail

Post-incident, the security team needs to prove what was authorized. Gatefile's plan and signed approval prove authorization of the exact plan hash; its authenticated apply receipt and pre-apply snapshot make local execution state tampering evident while Gatefile's owner-controlled state key remains trusted.

### Agent Adapter

When an external agent emits proposal-style JSON instead of Gatefile's native format:

```bash
gatefile adapt-agent --from examples/agent-adapter-input.json --out .plan/adapter-draft.json
gatefile create-plan --from .plan/adapter-draft.json --out .plan/plan.json
```

See [docs/agent-adapter.md](docs/agent-adapter.md) for supported input formats.

## Safety Guardrails

`apply-plan` enforces multiple safety layers:

| Layer | What it does |
|-------|-------------|
| **Hash binding** | Approval locks to exact plan content — any tampering blocks execution |
| **Signer trust policy** | Trusted signer allowlist via `gatefile.config.json` |
| **File sandboxing** | Canonical-root confinement, ancestor/final symlink rejection, exact-byte checks, and atomic replacement |
| **Command policy** | Exact executable + ordered-argument allow/deny rules; execution uses `shell: false` |
| **Timeouts** | Default 10s per command, configurable per-operation or plan-wide |
| **Preconditions** | Guard checks (branch, clean tree, env vars) must pass before apply |
| **Policy hooks** | Optional `beforeApprove`/`beforeApply` hooks |
| **Dependencies** | `dependsOn` requires authenticated prior successful apply state |
| **Dry-run** | Preview everything without executing — works before or after approval |
| **Snapshots + receipts** | Versioned, HMAC-authenticated before/after state bound to repository, plan, and receipt |
| **Rollback** | Whole-operation drift/symlink preflight plus replay protection; commands are not auto-reverted |

Gatefile keeps rollback records, authentication keys, and replay claims in the
current user's platform state directory, outside the repository. Set
`GATEFILE_STATE_HOME` to an absolute owner-controlled directory to override the
default. The HMAC key provides local integrity, not protection from a process
already running as the same OS user. Snapshot contents are authenticated but not
encrypted.

Alpha filesystem contract: file execution is POSIX-only; authenticated state
also fails closed on Windows until private DACL enforcement exists. Relative
paths and command working directories are anchored to the canonical Git
top-level (or the selected real directory outside Git). Every target parent
must already exist. Managed directories/files must be owned by the effective
user and may not be group/world writable; extended ACLs are rejected. Creates
publish mode `0600`. macOS targets with security-sensitive extended attributes
(including quarantine) are refused; Linux updates copy extended attributes or
fail closed. These restrictions are intentional alpha compatibility breaks.

Apply writes an authenticated receipt before each file commit. Once that
write-ahead record is durable, it binds the authenticated before-state, expected
post-state, and any possible staging residue; a later crash or receipt-finalization
error therefore retains rollback authority. A crash during private staging before
the write-ahead record is durable can leave an owner-only temporary file that is
not rollback-managed.

Successful dependency publication is guarded by a durable deny marker written
before the final success receipt and plan-state cache. Dependency checks fail
closed while that marker exists, including after an ambiguous cache `fsync`.
A successful authenticated rollback removes the matching marker and permits a
fresh apply of the same plan ID. If marker-removal durability is ambiguous, the
apply/rollback authority remains valid but a restart may conservatively restore
the marker and block dependencies until operator recovery verifies the completed
rollback and removes the matching marker. A marker whose digest differs from the
durable write-ahead receipt is cleared only when no older plan-state cache could
be exposed; otherwise dependency use and re-apply remain blocked for operator
recovery.

Rollback remains non-transactional across multiple files and never reverses
command side effects. Claiming a receipt immediately invalidates dependency state
and prevents replay; if rollback then fails or the process crashes, Gatefile does
not automatically resume that claimed receipt in this alpha. State is also bound
to the checkout's canonical path plus directory device/inode, so moving or
replacing a live checkout makes its old rollback state inaccessible. Portable
Node.js does not expose inode generations: if a checkout is deleted and its
directory inode is immediately reused at the same path, use a fresh state home
because Gatefile cannot distinguish that reuse from the original checkout.
Legacy unsigned `.gatefile/state` records are not migrated and cannot satisfy
dependencies or be used for authenticated rollback.

## MCP Server

gatefile ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/)
server. The packaged `gatefile-mcp` and `gatefile mcp` entrypoints intentionally
start with one repository context pinned from their process working directory
and expose only non-executing plan creation, inspection, verification, and
preview tools. They do not expose approve, apply, or rollback.

### Configure in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gatefile": {
      "command": "npx",
      "args": ["--yes", "--package", "gatefile@0.3.0-alpha.0", "gatefile-mcp"]
    }
  }
}
```

Configure the MCP host or a small trusted wrapper so its process working
directory is the intended repository. Requests cannot replace the server's
repository, state home, signer, or policy authority.

### Default packaged tools

| Tool | Description |
|------|------------|
| `inspect_plan` | Inspect a plan — returns operations, risk level, integrity, approval, and dependency state |
| `create_plan` | Create a hash-bound plan from a draft and write it to disk |
| `verify_plan` | Verify integrity, approval binding, signer trust, and repository context |
| `dry_run_plan` | Preview operations without executing them |

`create_plan` uses create-only, repository-confined output; it cannot replace an
existing file. The other default tools are read-only.

### Privileged programmatic embedding

A trusted operator-owned launcher can import `startMcpServer` and opt into
privileged tools at startup:

```typescript
import { readFileSync } from "node:fs";
import { startMcpServer } from "gatefile";

const trustedConfig = JSON.parse(
  readFileSync("/etc/gatefile/gatefile.config.json", "utf8")
);

startMcpServer({
  repoRoot: "/srv/reviewed-repository",
  stateHome: "/srv/gatefile-state",
  config: trustedConfig,
  capabilities: { approve: true, apply: true, rollback: true },
  approval: {
    approvedBy: "trusted-mcp-operator",
    signingPrivateKeyPem: readFileSync("/run/secrets/gatefile-signing-key", "utf8")
  }
});
```

With those startup capabilities, `approve_plan`, `apply_plan`, and
`rollback_apply` are added. Approval identity and signing material still come
only from the trusted launcher; tool requests cannot provide them. The packaged
CLI/bin has no flag or environment escape hatch for enabling these mutations.

## Programmatic API

`GatefileEngine` is the primary supported in-memory policy boundary. Construct an
engine for one repository/runtime context, then reuse it for the plan lifecycle:

```typescript
import { GatefileEngine } from "gatefile";

const engine = new GatefileEngine({ repoRoot: process.cwd() });

const pending = engine.createPlan(draft);
const report = engine.inspectPlan(pending);
const approved = engine.approvePlan(pending, "ci-bot");
const status = engine.verifyPlan(approved);
const preview = engine.previewPlan(approved); // no execution
const result = engine.applyPlan(approved);     // real execution
```

At construction, the engine pins an immutable context: the canonical Git
top-level (or canonical selected directory outside Git), its derived or explicit
repository ID, and the resolved explicit/environment/platform-default state
home. Later working-directory or environment changes cannot redirect that
engine. If `config` is omitted, `gatefile.config.json` is reloaded from the
pinned repository once at the start of each policy-sensitive method, and that
method uses one normalized snapshot for all of its checks. Rollback deliberately
does not load repository policy: authenticated recovery remains available even
when the repository config is malformed. Passing `config` instead pins a
normalized, defensively copied snapshot at construction.

The package-root lifecycle names `createPlanFromDraft`, `approvePlan`,
`verifyPlan`, `buildInspectReport`, `previewPlan`, `applyPlan`, and
`rollbackApply` remain supported as alpha compatibility wrappers; they construct
and delegate to `GatefileEngine`. The Promise-returning file helpers
(`createPlan`, `inspectPlan`, `approvePlanFile`, `verifyPlanFile`,
`applyPlanFile`, and `rollbackApplyFile`) remain available when the adapter
should own plan JSON I/O.

Raw lifecycle kernels and deep imports such as `gatefile/dist/applier` are not
supported APIs. The published package has an explicit `exports` map: supported
imports are the allowlisted package root, `gatefile/schema/gatefile.schema.json`,
`gatefile/schema/gatefile.config.schema.json`, and `gatefile/package.json`.
Node.js rejects other package subpaths, including the internal `dist` tree.
Treat only the explicit root exports and those JSON subpaths as the installed
package compatibility contract. This is not a security sandbox: code that
already has filesystem access to an installation can locate it and load files
by absolute path. The export map prevents accidental or supported package-specifier
coupling to internals; it does not isolate mutually untrusted code in one process.

## GitHub PR Gate

Drop a gatefile check into any CI pipeline:

```yaml
- uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
  with:
    fetch-depth: 0

- uses: StephenBickel/gatefile/.github/actions/gatefile-pr-gate@57689dd2ddc2e8a6bc1c3cb5b46d5239f2d0ced0
  with:
    plan-path: .plan/plan.json
    trusted-policy-ref: ${{ github.event.pull_request.base.sha }}
    trusted-policy-sha256: ${{ vars.GATEFILE_POLICY_SHA256 }}
```

Store the SHA-256 digest of the trusted base branch's
`gatefile.config.json` bytes in the repository Actions variable
`GATEFILE_POLICY_SHA256`. The Action requires the plan to be Git-tracked and
unchanged from `HEAD`; it loads policy from the full base commit SHA and checks
that snapshot against the caller-pinned digest. It stages the committed plan
plus inspect, verification, dry-run, and manifest evidence in a fresh
runner-owned temporary directory, uploads only that bundle even when
verification is not ready, verifies its manifest digests, and only then fails
the gate. Repositories intentionally evaluating without signer policy must opt
in explicitly with `allow-unsigned-no-policy: "true"`; that mode is not a
substitute for trusted approval verification.

Pin the workflow and all Actions by full commit SHA, enforce the check through
a protected required workflow/ruleset, and run it before executing pull-request
code on an isolated runner. The Action does not sandbox a hostile same-user
process that was already started on the worker.

See [docs/github-pr-gate-example.md](docs/github-pr-gate-example.md) for full workflow examples, including the [fork-safe signed-approval artifact flow](docs/examples/github-native-signed-approval-fork-request.yml).

## Config, Policy Hooks, and Notifications

Use `gatefile.config.json` to enforce policy hooks and signer trust:

```json
{
  "hooks": {
    "beforeApprove": { "command": "node ./scripts/before-approve.js" },
    "beforeApply": { "command": "node ./scripts/before-apply.js" }
  },
  "signers": {
    "trustedKeyIds": ["gfk1_0123456789abcdef"],
    "trustedPublicKeys": ["-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"]
  }
}
```

Replace the example key ID and public key with the pair printed by
`gatefile generate-attestation-key`; key IDs are derived from the Ed25519 public
key and are not operator-chosen labels.

Policy hooks run operator-defined commands synchronously; a non-zero exit blocks
the action. This alpha does not yet define a structured stdin/environment payload
contract for policy hooks. Validate configuration anytime with `gatefile lint-config`.

## Notifications

gatefile can deliver best-effort webhooks and shell commands after durable
lifecycle events. Add the canonical `notifications` object to
`gatefile.config.json`:

```json
{
  "notifications": {
    "onPlanCreated": {
      "webhook": "https://hooks.slack.com/services/T.../B.../xxx",
      "shell": "echo plan ready"
    },
    "onPlanApproved": {
      "webhook": "https://example.com/approval-webhook",
      "shell": "notify-send 'plan approved'"
    }
  }
}
```

| Event | Fires when | Payload |
|-------|-----------|---------|
| `onPlanCreated` | After `create-plan` completes | Plan summary JSON |
| `onPlanApproved` | After `approve-plan` durably writes the approval | Plan summary JSON (with approval) |

Configure at least one of `webhook` or `shell`; both may be used. Webhooks send
a `POST` with `Content-Type: application/json`. Webhook values must use a
lowercase `http://` or `https://` scheme and contain an authority and valid port
that Node.js can parse before dispatch. Delivery errors warn to stderr
but never change the completed lifecycle operation. Deprecated
`hooks.onPlanCreated` and `hooks.onApprovalNeeded` inputs migrate to these
canonical events when no canonical duplicate is present; new configurations
should not use them.

See [schema/gatefile.config.schema.json](schema/gatefile.config.schema.json) for the full config schema.

## Core Concepts

| Concept | Description |
|---------|------------|
| **Plan** | Immutable JSON artifact describing proposed side effects |
| **Changeset** | File diffs (`create`, `update`, `delete`) and command intents |
| **Risk Profile** | Heuristic score + rationale per operation |
| **Preconditions** | Guards that must pass before apply |
| **Approval** | Hash-bound human or policy gate |
| **Attestation** | Optional Ed25519 signature proving approval identity |
| **Apply Receipt** | Structured record of what executed, for rollback and audit |

## Docs

- [Architecture](docs/architecture.md)
- [Signed Approvals](docs/signed-approvals.md)
- [Agent Adapter](docs/agent-adapter.md)
- [Changeset Spec](docs/changeset-spec.md)
- [JSON Schema](schema/gatefile.schema.json)
- [Use Cases](docs/use-cases.md)
- [GitHub PR Gate](docs/github-pr-gate-example.md)
- [Product Roadmap](docs/product-roadmap.md)

## Roadmap

See the [Product Roadmap](docs/product-roadmap.md) for the deferred feature roadmap. During the stabilization freeze, the current implemented surface includes:

- [x] Interactive review TUI (`gatefile review`)
- [x] CLI with create/inspect/verify/approve/apply
- [x] Hash-bound approval with tamper detection
- [x] Command + file path safety policies
- [x] Dry-run preview mode
- [x] GitHub PR gate action
- [x] Recovery guidance in apply reports
- [x] Webhook/notification actions (`notifications.onPlanCreated`, `notifications.onPlanApproved`)
- [x] Signing/attestation workflows (Ed25519)
- [x] MCP server for agent integrations

## Contributing

Gatefile is in an alpha stabilization freeze. Contributions are limited to security fixes, correctness fixes, compatibility work, tests, documentation, and release stabilization. New product surface, integrations, and feature work are deferred until the freeze ends.

1. Open an issue describing stabilization work
2. Keep changes focused and documented
3. Include examples when behavior changes

## License

MIT
