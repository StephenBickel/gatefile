# Coding Agent Demo: Verify, Approve, Detect Tampering

This demo shows a realistic handoff between an autonomous coding agent and a
human reviewer using only the public CLI and the example shipped in the npm
package.

Confirm that npm's `next` tag resolves to `0.3.0-alpha.0`, then install it
locally:

```bash
npm view gatefile@next version
npm install --save-dev gatefile@0.3.0-alpha.0
mkdir -p .plan
cp node_modules/gatefile/examples/coding-agent-plan.json .plan/coding-agent-plan.json
```

If the registry does not return that exact version, use a source checkout and
copy `examples/coding-agent-plan.json` to `.plan/coding-agent-plan.json` instead.

## Scenario

1. Agent proposes exact file/command side effects.
2. Human checks details with `inspect-plan`.
3. Human or CI checks `verify-plan` to decide if the plan is currently safe to apply from an integrity/approval perspective.
4. Human approves.
5. Any post-approval tampering is detected by `verify-plan` and blocked by `apply-plan`.

## Commands

```bash
# Agent phase: create a concrete plan artifact
npx --no-install gatefile create-plan --from .plan/coding-agent-plan.json --out .plan/agent-demo.json

# Review phase: inspect readable details
npx --no-install gatefile inspect-plan .plan/agent-demo.json

# Optional CI/policy inspect output
npx --no-install gatefile inspect-plan .plan/agent-demo.json --json

# Verify phase before approval (expected: status "not-ready")
npx --no-install gatefile verify-plan .plan/agent-demo.json

# Approval phase
npx --no-install gatefile approve-plan .plan/agent-demo.json --by steve

# Verify phase after approval (expected: status "ready")
npx --no-install gatefile verify-plan .plan/agent-demo.json
```

## Tampering Check

```bash
# Simulate post-approval mutation
node -e 'const fs=require("fs");const p=".plan/agent-demo.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.summary="tampered after approval";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'

# Verify now reports not-ready with hash/approval mismatch blockers
npx --no-install gatefile verify-plan .plan/agent-demo.json

# Apply also fails for the same reason
npx --no-install gatefile apply-plan .plan/agent-demo.json --yes
```

## What `verify-plan` Guarantees

- Integrity metadata exists
- Recorded hash matches current normalized plan content
- Approval is bound to the current hash
- A single boolean (`readyToApplyFromIntegrityApproval`) for integrity/approval
  readiness. It is not the final runtime apply decision: dependencies, operation
  policy, filesystem state, and runtime preconditions are checked separately.

This particular walkthrough uses an unsigned local approval. Gatefile can also
attach an Ed25519 attestation. That signature proves possession of the signing
key; the repository trust policy, not the signature alone, maps the public key
to an operator-defined person or role.
