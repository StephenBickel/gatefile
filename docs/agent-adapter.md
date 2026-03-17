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
      { "command": "npm test -- --testNamePattern=status" }
    ]
  }
}
```

See `examples/agent-adapter-input.json` for a complete sample.

## Workflow

```bash
# 1) Convert agent output into a standard plan draft
gatefile adapt-agent --from examples/agent-adapter-input.json --out .plan/adapter-draft.json

# 2) Use existing gatefile create/inspect/verify/apply flow
gatefile create-plan --from .plan/adapter-draft.json --out .plan/plan.json
gatefile inspect-plan .plan/plan.json
gatefile verify-plan .plan/plan.json
gatefile approve-plan .plan/plan.json --by reviewer
gatefile apply-plan .plan/plan.json --yes
```
