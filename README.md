# gatefile

[![CI](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenBickel/gatefile/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gatefile)](https://www.npmjs.com/package/gatefile)

**Terraform for AI agent side effects.**

Your AI agent wants to edit 14 files and run 3 shell commands. Do you trust it?

`gatefile` makes agent side effects explicit, reviewable, and approvable — before anything executes.

```bash
npx gatefile review .plan/plan.json          # interactive TUI: inspect, approve, or reject
npx gatefile inspect-plan .plan/plan.json    # see exactly what the agent wants to do
npx gatefile approve-plan .plan/plan.json    # approve the hash-locked plan
npx gatefile apply-plan .plan/plan.json      # execute with safety guardrails
```

## Why

Agent tooling is good at *doing* things but weak at *governing* side effects.

- Hidden file edits buried in PR-sized bursts
- Shell commands with unclear blast radius
- No durable artifact for review, approval, or audit
- Tests verify behavior *after* changes. Traces show what happened *during*. Neither gives you a machine-readable **intent contract** *before* execution

Today, teams rely on prompts and trust. That doesn't scale.

## How It Works

```
Agent emits plan → Human reviews → Approve hash → Apply with guardrails
```

1. **Create** — agent declares intended file changes + commands as a JSON plan
2. **Inspect** — human or CI reviews the plan (concise summary or `--json` for machines)
3. **Verify** — integrity check confirms the plan hasn't been tampered with
4. **Approve** — human or policy engine approves, binding to the exact plan hash
5. **Apply** — execute with precondition checks, path sandboxing, command policies, and timeouts

Approval is hash-bound: if anyone modifies the plan after approval, `verify` catches it and `apply` refuses.

## Quick Start

```bash
# Install
npm install gatefile

# Or run directly
npx gatefile --help
```

### End-to-End Demo

```bash
git clone https://github.com/StephenBickel/gatefile.git
cd gatefile
npm install
npm run demo:e2e
```

This runs the full flow: create → inspect → verify → approve → dry-run → denied unsafe path → safe apply → PR gate adoption.

### Basic Usage

```bash
# Agent creates a plan
gatefile create-plan --from examples/coding-agent-plan.json --out .plan/plan.json

# Interactive review (TUI with diff preview, approve/reject)
gatefile review .plan/plan.json

# Non-interactive inspection
gatefile inspect-plan .plan/plan.json

# Machine-readable for CI
gatefile inspect-plan .plan/plan.json --json

# Check integrity
gatefile verify-plan .plan/plan.json

# Preview without executing
gatefile apply-plan .plan/plan.json --dry-run

# Approve (binds to exact hash)
gatefile approve-plan .plan/plan.json --by steve

# Execute
gatefile apply-plan .plan/plan.json --yes
```

## Safety Guardrails

`apply-plan` enforces multiple safety layers:

| Layer | What it does |
|-------|-------------|
| **Hash binding** | Approval locks to exact plan content — tampering detected |
| **File sandboxing** | Writes restricted to workspace root (configurable via `filePolicy.allowedRoots`) |
| **Command policy** | Allow/deny patterns for shell commands |
| **Timeouts** | Default 10s per command, configurable per-operation or plan-wide |
| **Preconditions** | Guard checks (branch, clean tree, env vars) must pass before apply |
| **Dry-run** | Preview everything without executing — works before or after approval |
| **Recovery hints** | Apply reports include affected paths and manual rollback guidance |

## MCP Server

gatefile ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so any MCP-compatible host (Claude Desktop, Claude Code, Cursor, etc.) can inspect, verify, approve, and apply plans directly.

### Configure in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gatefile": {
      "command": "npx",
      "args": ["gatefile-mcp"]
    }
  }
}
```

### Tools Exposed

| Tool | Description |
|------|------------|
| `gatefile_inspect` | Inspect a plan — returns operations, risk level, integrity, and approval state |
| `gatefile_verify` | Verify plan integrity — hash match, approval binding, ready/not-ready status |
| `gatefile_approve` | Approve a plan — binds approval to the exact plan hash |
| `gatefile_apply` | Apply a plan with safety guardrails (defaults to dry-run mode) |

The `gatefile_apply` tool defaults to `dryRun: true` for safety. Set `dryRun: false` to execute real changes.

## Programmatic API

Use gatefile as a library in your own tools:

```typescript
import { createPlan, inspectPlan, approvePlanFile, verifyPlanFile, applyPlanFile } from "gatefile";

// Create a plan from a draft
const plan = await createPlan(draft, { outPath: ".plan/plan.json" });

// Inspect, approve, verify, apply
const report = await inspectPlan(".plan/plan.json");
await approvePlanFile(".plan/plan.json", { approvedBy: "ci-bot" });
const status = await verifyPlanFile(".plan/plan.json");
const result = await applyPlanFile(".plan/plan.json");          // real apply
const preview = await applyPlanFile(".plan/plan.json", { dryRun: true }); // dry-run
```

The low-level in-memory functions (`createPlanFromDraft`, `approvePlan`, `verifyPlan`, `applyPlan`, `previewPlan`) are also exported for advanced use cases.

## GitHub PR Gate

Drop a gatefile check into any CI pipeline:

```yaml
- uses: StephenBickel/gatefile/.github/actions/gatefile-pr-gate@main
  with:
    plan-path: .plan/plan.json
```

See [docs/github-pr-gate-example.md](docs/github-pr-gate-example.md) for full workflow examples.

## Hooks

gatefile can fire webhooks and shell commands on lifecycle events. Add a `gatefile.config.json` to your project root:

```json
{
  "hooks": {
    "onPlanCreated": {
      "webhook": "https://hooks.slack.com/services/T.../B.../xxx",
      "shell": "echo plan ready"
    },
    "onApprovalNeeded": {
      "webhook": "https://example.com/approval-webhook",
      "shell": "notify-send 'approval needed'"
    }
  }
}
```

| Event | Fires when | Payload |
|-------|-----------|---------|
| `onPlanCreated` | After `create-plan` completes | Plan summary JSON |
| `onApprovalNeeded` | After `approve-plan` completes | Plan summary JSON (with approval) |

Both `webhook` and `shell` are optional — use one or both. Webhook sends a `POST` with `Content-Type: application/json`. Errors in hooks warn to stderr but never fail the main operation.

See [schema/gatefile.config.schema.json](schema/gatefile.config.schema.json) for the full config schema.

## Core Concepts

| Concept | Description |
|---------|------------|
| **Plan** | Immutable JSON artifact describing proposed side effects |
| **Changeset** | File diffs (`create`, `update`, `delete`) and command intents |
| **Risk Profile** | Heuristic score + rationale per operation |
| **Preconditions** | Guards that must pass before apply |
| **Approval** | Hash-bound human or policy gate |
| **Apply Report** | What executed, what failed, and why |

## Architecture

- [Architecture](docs/architecture.md)
- [Changeset Spec](docs/changeset-spec.md)
- [JSON Schema](schema/gatefile.schema.json)
- [Use Cases](docs/use-cases.md)
- [GitHub PR Gate](docs/github-pr-gate-example.md)

## Roadmap

See [TODO.md](TODO.md) for near-term plans. Current focus:

- [x] Interactive review TUI (`gatefile review`)
- [x] CLI with create/inspect/verify/approve/apply
- [x] Hash-bound approval with tamper detection
- [x] Command + file path safety policies
- [x] Dry-run preview mode
- [x] GitHub PR gate action
- [x] Recovery guidance in apply reports
- [x] Webhook/notification hooks (`onPlanCreated`, `onApprovalNeeded`)
- [ ] Signing/attestation workflows
- [x] MCP server for agent integrations

## Contributing

Contributions welcome — especially around spec clarity, safer apply strategies, and real-world use-case feedback.

1. Open an issue (or pick from TODO.md)
2. Keep changes focused and documented
3. Include examples when behavior changes

## License

MIT
