# Agent Adapter (MVP)

`gatefile adapt-agent` converts concise agent-style output into a standard plan draft.
It does not change gatefile schema or apply semantics; it feeds the existing flow.

## Supported Input Shapes

1. Direct proposal object:
- `summary`
- `fileChanges[]`
- `commands[]`
- optional `source`, `preconditions`, `execution`

2. Generic envelope object:
- `agent` metadata
- `proposal` (same fields as direct proposal)

## Example Input

```json
{
  "agent": { "name": "generic-coding-agent" },
  "proposal": {
    "summary": "Add a status endpoint and run targeted tests",
    "fileChanges": [
      {
        "action": "update",
        "path": "src/server.ts",
        "before": "app.listen(port);\n",
        "after": "app.get('/status', (_req, res) => res.json({ ok: true }));\napp.listen(port);\n"
      }
    ],
    "commands": [
      {
        "executable": "npm",
        "args": ["test", "--", "--testNamePattern=status"]
      }
    ]
  }
}
```

The npm package ships a complete sample at
`node_modules/gatefile/examples/agent-adapter-input.json`. In a source checkout,
the same file is available at `examples/agent-adapter-input.json`.

## Workflow

```bash
# Confirm and install the exact prerelease from npm's `next` channel
npm view gatefile@next version
npm install --save-dev gatefile@0.3.0-alpha.0
mkdir -p .plan
GATEFILE_EXAMPLES=node_modules/gatefile/examples
test -d "$GATEFILE_EXAMPLES" || GATEFILE_EXAMPLES=examples

# 1) Convert agent output into a standard plan draft
cp "$GATEFILE_EXAMPLES/agent-adapter-input.json" .plan/agent-adapter-input.json
npx --no-install gatefile adapt-agent --from .plan/agent-adapter-input.json --out .plan/adapter-draft.json

# 2) Use existing gatefile create/inspect/verify/apply flow
npx --no-install gatefile create-plan --from .plan/adapter-draft.json --out .plan/plan.json
npx --no-install gatefile inspect-plan .plan/plan.json
npx --no-install gatefile verify-plan .plan/plan.json
npx --no-install gatefile approve-plan .plan/plan.json --by reviewer
npx --no-install gatefile apply-plan .plan/plan.json --yes
```
