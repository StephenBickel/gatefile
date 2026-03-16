#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEMO_ROOT=".plan/public-launch-demo"
WORKSPACE_DIR="$DEMO_ROOT/workspace"
SAFE_PLAN="$DEMO_ROOT/safe-plan.json"
UNSAFE_PLAN="$DEMO_ROOT/unsafe-plan.json"
SAFE_DRAFT="examples/public-launch-safe-draft.json"
UNSAFE_DRAFT="examples/public-launch-unsafe-draft.json"

run_step() {
  echo
  echo "==> $*"
  "$@"
}

echo "Planfile Public-Launch End-to-End Demo"
echo "Repo: $ROOT_DIR"

echo
echo "Resetting demo workspace at $DEMO_ROOT"
rm -rf "$DEMO_ROOT"
mkdir -p "$WORKSPACE_DIR"

run_step npm run cli -- create-plan --from "$SAFE_DRAFT" --out "$SAFE_PLAN"
run_step npm run cli -- inspect-plan "$SAFE_PLAN"
run_step npm run cli -- verify-plan "$SAFE_PLAN"

run_step npm run cli -- approve-plan "$SAFE_PLAN" --by demo-reviewer
run_step npm run cli -- apply-plan "$SAFE_PLAN" --dry-run --human

run_step npm run cli -- create-plan --from "$UNSAFE_DRAFT" --out "$UNSAFE_PLAN"
run_step npm run cli -- approve-plan "$UNSAFE_PLAN" --by demo-reviewer
run_step npm run cli -- verify-plan "$UNSAFE_PLAN"

echo
echo "==> npm run cli -- apply-plan $UNSAFE_PLAN --yes (expected report.success=false)"
unsafe_report="$(npm run --silent cli -- apply-plan "$UNSAFE_PLAN" --yes)"
echo "$unsafe_report"
printf '%s' "$unsafe_report" | node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(0, "utf8"));
if (report.success) {
  console.error("ERROR: unsafe apply unexpectedly reported success");
  process.exit(1);
}
console.log("Expected: unsafe apply was rejected by file policy");
'

run_step npm run cli -- apply-plan "$SAFE_PLAN" --yes --human

echo
echo "Applied artifacts:"
ls -la "$WORKSPACE_DIR"

echo
echo "Reusable PR gate adoption path:"
echo "- docs/github-pr-gate-example.md"
echo "- .github/actions/planfile-pr-gate/action.yml"
