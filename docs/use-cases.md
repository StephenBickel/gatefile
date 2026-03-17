# Use Cases

## 1. Coding Agent in a Monorepo

**Who:** Engineering teams with 5+ developers using autonomous coding agents (Codex, Claude Code, Cursor, custom agents) on shared repos.

**Problem:** The agent proposes a refactor touching 30 files across 4 packages. Today you either read every diff interactively (slow) or trust full-auto mode (risky). There's no durable record of what was proposed, who approved it, or what actually executed.

**With Gatefile:**
- Agent emits a plan JSON declaring every file edit and command it wants to run
- Tech lead reviews the operation summary with risk scores
- Approval hash-locks to the exact plan — no post-approval mutations
- Apply executes only what was approved, with receipts for rollback
- The plan artifact lives in the repo for post-incident review

**Key features used:** `create-plan`, `inspect-plan`, `approve-plan`, `apply-plan`, risk scoring, file sandboxing.

## 2. Production Ops Automation

**Who:** Platform/DevOps teams running agents that manage infrastructure — config rotation, service restarts, health checks.

**Problem:** Operational scripts run with too much implicit behavior. An ops agent decides to rotate a config, restart a service, and curl a health endpoint. If something breaks at step 2, what was the state before? Who said this was okay to run?

**With Gatefile:**
- Plan declares exact file changes, commands, and preconditions (e.g., must be on `main`, must have `ALLOW_OPS_APPLY` env var)
- Apply refuses if preconditions fail
- Every action is receipted — file snapshots before apply, structured results after
- `rollback-apply` restores file state from the receipt chain

**Key features used:** Preconditions, command policy (allow/deny patterns), timeouts, snapshots + receipts, rollback.

## 3. CI Gate for Agent PRs

**Who:** Teams where agents open PRs autonomously and CI needs to enforce review standards beyond code diffs.

**Problem:** An agent opens a PR with code changes, but the PR diff doesn't show what *commands* the agent plans to run (migrations, installs, deploys). Standard code review catches file changes but misses execution intent.

**With Gatefile:**
- CI runs `gatefile verify-plan` as a required status check
- PR includes machine-readable intent (`inspect-plan --json`) so reviewers see the full blast radius
- No approved plan = no merge
- GitHub Action drops into any existing workflow in 3 lines

**Key features used:** `verify-plan`, `inspect-plan --json`, GitHub PR gate action, branch protection integration.

## 4. Compliance and Audit Trail

**Who:** Companies in regulated industries (finance, healthcare, government) where "who authorized what" must be provable after the fact.

**Problem:** Post-incident, the security team needs to reconstruct what happened. Interactive approvals (clicking "yes" in a terminal) leave no auditable trace. Git history shows what changed, not what was *intended* or *authorized*.

**With Gatefile:**
- Plan = machine-readable intent record
- Signed approval = cryptographic proof of who approved, when, bound to the exact plan hash
- Apply receipt = structured record of what executed and what the file state was before
- The full chain (plan → attestation → receipt → snapshot) is tamper-evident and stored locally

**Key features used:** Signed attestation (Ed25519), signer trust policy, apply receipts, pre-apply snapshots, `lint-config`.

## 5. Multi-Agent Pipelines

**Who:** Teams building agent orchestration systems where one agent proposes changes and another (or a human) validates.

**Problem:** Agent A generates a migration plan. Agent B is supposed to verify it before execution. But there's no standard contract format between them, and no way to prove Agent B actually reviewed the exact plan that ran.

**With Gatefile:**
- The plan file is the contract between agents
- Agent A writes the plan, Agent B (or a policy engine) runs `verify-plan` and `approve-plan`
- Hash binding ensures the plan that was approved is exactly the plan that executes
- Agent-agnostic: works across any framework or toolchain

**Key features used:** `adapt-agent` for ingestion, hash binding, `dependsOn` for plan sequencing.

## When Gatefile Is Overkill

- Solo development on personal projects where `git revert` handles mistakes
- Low-stakes code generation where Claude Code or Codex full-auto is fine
- Prototyping or throwaway code where governance overhead exceeds risk
- Teams small enough that the person running the agent is also the reviewer — the approval step adds friction without adding a new perspective
