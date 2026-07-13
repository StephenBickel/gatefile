#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Gatefile Action error: $*" >&2
  exit 1
}

validate_relative_path() {
  local label=$1
  local value=$2
  local component
  if [[ -z "${value}" || "${value}" == /* || "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    fail "${label} must be a non-empty repository-relative path"
  fi
  IFS='/' read -r -a components <<< "${value}"
  for component in "${components[@]}"; do
    if [[ -z "${component}" || "${component}" == "." || "${component}" == ".." ]]; then
      fail "${label} must not contain empty, dot, or parent path components"
    fi
    if [[ "$(printf '%s' "${component}" | tr '[:upper:]' '[:lower:]')" == ".git" ]]; then
      fail "${label} must not address Git metadata"
    fi
  done
}

write_output() {
  local name=$1
  local value=$2
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "${name}" "${value}" >> "${GITHUB_OUTPUT}"
  fi
}

[[ -n "${GITHUB_ACTION_PATH:-}" ]] || fail "GITHUB_ACTION_PATH is required"
[[ -n "${GITHUB_WORKSPACE:-}" ]] || fail "GITHUB_WORKSPACE is required"
[[ -n "${RUNNER_TEMP:-}" ]] || fail "RUNNER_TEMP is required"

action_path=$(cd "${GITHUB_ACTION_PATH}" && pwd -P)
package_root=$(cd "${action_path}/../../.." && pwd -P)
workspace=$(cd "${GITHUB_WORKSPACE}" && pwd -P)
cd "${workspace}"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "GITHUB_WORKSPACE must be a Git checkout"
repo_root=$(cd "${repo_root}" && pwd -P)
[[ "${repo_root}" == "${workspace}" ]] || fail "GITHUB_WORKSPACE must be the repository top-level"

plan_path=${INPUT_PLAN_PATH:-.plan/plan.json}
trusted_policy_ref=${INPUT_TRUSTED_POLICY_REF:-}
trusted_policy_path=${INPUT_TRUSTED_POLICY_PATH:-gatefile.config.json}
trusted_policy_sha256=${INPUT_TRUSTED_POLICY_SHA256:-}
allow_unsigned_no_policy=${INPUT_ALLOW_UNSIGNED_NO_POLICY:-false}

validate_relative_path "plan-path" "${plan_path}"

[[ -f "${plan_path}" && ! -L "${plan_path}" ]] || fail "plan-path must be a regular, non-symlink file"
if ! git ls-files --error-unmatch -- "${plan_path}" >/dev/null 2>&1; then
  fail "plan-path must be Git-tracked: ${plan_path}"
fi
if ! git diff --quiet HEAD -- "${plan_path}"; then
  fail "plan-path differs from HEAD and must remain unchanged: ${plan_path}"
fi

case "${allow_unsigned_no_policy}" in
  true|false) ;;
  *) fail "allow-unsigned-no-policy must be exactly true or false" ;;
esac

umask 077
runner_temp=$(cd "${RUNNER_TEMP}" && pwd -P)
evidence_dir=$(mktemp -d "${runner_temp%/}/gatefile-evidence.XXXXXX")
runtime_dir=$(mktemp -d "${runner_temp%/}/gatefile-runtime.XXXXXX")
plan_snapshot="${evidence_dir}/plan.json"
if ! git cat-file blob "HEAD:${plan_path}" > "${plan_snapshot}" 2>/dev/null; then
  fail "unable to stage the committed plan blob from HEAD: ${plan_path}"
fi

policy_snapshot=""
policy_mode="unsigned-no-policy"
normalized_policy_ref=""
normalized_policy_sha256=""

if [[ -n "${trusted_policy_ref}" || -n "${trusted_policy_sha256}" ]]; then
  [[ "${trusted_policy_ref}" =~ ^[0-9a-fA-F]{40}$ ]] || fail "trusted-policy-ref must be a full 40-character Git commit SHA"
  [[ "${trusted_policy_sha256}" =~ ^[0-9a-fA-F]{64}$ ]] || fail "trusted-policy-sha256 must be a 64-character hexadecimal digest"
  normalized_policy_ref=$(printf '%s' "${trusted_policy_ref}" | tr '[:upper:]' '[:lower:]')
  normalized_policy_sha256=$(printf '%s' "${trusted_policy_sha256}" | tr '[:upper:]' '[:lower:]')
  validate_relative_path "trusted-policy-path" "${trusted_policy_path}"
  git cat-file -e "${trusted_policy_ref}^{commit}" 2>/dev/null || fail "trusted-policy-ref is not available as a commit; checkout with fetch-depth: 0"
  policy_snapshot="${runtime_dir}/trusted-policy.json"
  if ! git show "${trusted_policy_ref}:${trusted_policy_path}" > "${policy_snapshot}" 2>/dev/null; then
    fail "trusted policy does not exist at ${trusted_policy_ref}:${trusted_policy_path}"
  fi
  actual_policy_sha256=$(node -e 'const fs=require("node:fs");const crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "${policy_snapshot}")
  if [[ "${actual_policy_sha256}" != "${normalized_policy_sha256}" ]]; then
    fail "trusted policy digest mismatch: expected ${normalized_policy_sha256}, got ${actual_policy_sha256}"
  fi
  policy_mode="trusted-snapshot"
elif [[ "${allow_unsigned_no_policy}" != "true" ]]; then
  fail "trusted policy ref and SHA-256 are required unless allow-unsigned-no-policy is exactly true"
fi

# The consumer checkout is untrusted. Build only the package checkout that owns
# this Action, and address its runner and compiled library by absolute path.
if [[ ! -f "${package_root}/dist/index.js" ]]; then
  (
    cd "${package_root}"
    npm ci --ignore-scripts --no-audit --no-fund
    npm run build
  )
fi
[[ -f "${package_root}/dist/index.js" ]] || fail "action-owned Gatefile build did not produce dist/index.js"

state_home="${runtime_dir}/state"
runner_args=(
  "${action_path}/runner.js"
  --package-root "${package_root}"
  --repo-root "${repo_root}"
  --state-home "${state_home}"
  --plan-snapshot "${plan_snapshot}"
  --plan-source-path "${plan_path}"
  --evidence-dir "${evidence_dir}"
)
if [[ -n "${policy_snapshot}" ]]; then
  runner_args+=(--config "${policy_snapshot}")
fi
node "${runner_args[@]}"

head_commit=$(git rev-parse HEAD)
manifest_args=(
  "${action_path}/manifest.js"
  --package-json "${package_root}/package.json"
  --plan "plan.json"
  --plan-source-path "${plan_path}"
  --inspect "inspect-report.json"
  --verify "verify-report.json"
  --dry-run "dry-run-report.json"
  --manifest "gatefile-manifest.json"
  --head "${head_commit}"
  --policy-mode "${policy_mode}"
)
if [[ "${policy_mode}" == "trusted-snapshot" ]]; then
  manifest_args+=(
    --policy-ref "${normalized_policy_ref}"
    --policy-path "${trusted_policy_path}"
    --policy-sha256 "${normalized_policy_sha256}"
  )
fi
(
  cd "${evidence_dir}"
  node "${manifest_args[@]}"
)

gate_status=$(node -e 'const fs=require("node:fs");const report=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(report.status!=="ready"&&report.status!=="not-ready")throw new Error("Invalid verification status");process.stdout.write(report.status);' "${evidence_dir}/verify-report.json")
write_output "evidence-directory" "${evidence_dir}"
write_output "inspect-report-path" "${evidence_dir}/inspect-report.json"
write_output "verify-report-path" "${evidence_dir}/verify-report.json"
write_output "dry-run-report-path" "${evidence_dir}/dry-run-report.json"
write_output "manifest-path" "${evidence_dir}/gatefile-manifest.json"
write_output "status" "${gate_status}"

echo "Gatefile evidence generated for ${plan_path}: status=${gate_status}"
