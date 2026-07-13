# Gatefile Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gatefile's config, report, audit, package, MCP, and reusable-Action contracts strict, authenticated, authority-pinned, and mutually consistent.

**Architecture:** Keep `GatefileEngine` as the only lifecycle authority and harden every boundary around it. Runtime config and schemas share one strict structural shape; webhook URLs use a portable schema prefilter plus stricter runtime authority/port parsing; reports carry complete verification/static-gate evidence; audit projects authenticated receipt chains; installed exports are allowlisted; MCP receives authority only at startup; and the Action runs action-owned code while preserving bound evidence.

**Tech Stack:** TypeScript 5.8, Node.js 18+ CommonJS, Node test runner, JSON Schema/Ajv in tests, POSIX shell for the composite Action, GitHub Actions YAML.

## Global Constraints

- Preserve plan version `2`, hash envelope version `2`, and authenticated state record version `1`.
- Add no runtime dependency.
- Preserve old authenticated receipts; new receipt audit metadata is optional on read and mandatory on write.
- Never derive trusted repository identity, state home, approver, or signing key from a plan or MCP tool request.
- Never let child processes write to MCP protocol stdout.
- Unknown config, JSON-RPC, tool-argument, pipeline-plan, and authenticated-state fields fail closed.
- Notifications are best-effort; policy hooks, verification, path confinement, and state authentication are fail-closed.
- Every production change starts with a regression that fails on the PR6 tree.

---

### Task 1: Unify strict configuration and notification contracts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/hooks.ts`
- Modify: `src/cli.ts`
- Replace: `schema/gatefile.config.schema.json`
- Modify: `docs/examples/gatefile.config.json`
- Create: `test/config-contract.test.js`

**Interfaces:**
- Produces: canonical `GatefileConfig` with `signers`, policy `hooks`, and `notifications`; `loadGatefileConfig(repoRoot)`; `fireOnPlanCreated` and `fireOnPlanApproved` with pinned context.
- Compatibility: legacy `hooks.onPlanCreated` and `hooks.onApprovalNeeded`
  normalize into canonical notifications; `fireOnApprovalNeeded` uses the
  canonical approved-plan action while preserving its legacy
  `approval_needed` webhook event identifier.

- [ ] **Step 1: Write failing runtime/schema shape-parity and layered URL tests**

Test a canonical mixed config, each unknown top-level/nested key, invalid webhook protocol, empty shell command, legacy aliases, and alias/canonical conflicts. Validate the same fixtures with both `normalizeGatefileConfig` and Ajv. Add a subdirectory CLI fixture proving notifications use the selected repository root rather than process CWD.

```js
assert.deepEqual(normalizeGatefileConfig({
  signers: { trustedKeyIds: ['gfk1_0123456789abcdef'] },
  hooks: { beforeApply: { command: 'node policy.js' } },
  notifications: { onPlanApproved: { webhook: 'https://example.test/hook' } }
}).notifications.onPlanApproved.webhook, 'https://example.test/hook');
assert.throws(() => normalizeGatefileConfig({ signer: {} }), /unknown.*signer/i);
assert.throws(() => normalizeGatefileConfig({
  hooks: { onApprovalNeeded: { shell: 'echo old' } },
  notifications: { onPlanApproved: { shell: 'echo new' } }
}), /conflict/i);
```

- [ ] **Step 2: Verify the regression is red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/config-contract.test.js`

Expected: canonical notifications are rejected/ignored, unknown keys are accepted,
structural results differ, or the runtime accepts an undispatchable webhook URL.

- [ ] **Step 3: Implement one strict normalizer and matching structural schema**

Define the canonical notification action and normalize only this allowlist:

```ts
export interface NotificationAction {
  webhook?: string;
  shell?: string;
}

export interface GatefileConfig {
  signers?: SignerPolicyConfig;
  hooks?: PolicyHooksConfig;
  notifications?: {
    onPlanCreated?: NotificationAction;
    onPlanApproved?: NotificationAction;
  };
}
```

Reject unknown keys before reading values, require lowercase HTTP(S) URLs and
non-empty shell commands, and parse webhook authorities and ports at runtime
before dispatch. The schema intentionally provides the portable lexical
prefilter while runtime parsing is stricter. Map legacy notification keys once,
reject conflicts, and return a defensive copy. Make the schema use
`additionalProperties: false` at every object level and encode the
legacy/canonical conflict with `not`/`required`.

- [ ] **Step 4: Pin notification execution**

Use a context object rather than ambient reads:

```ts
export interface NotificationContext {
  repoRoot: string;
  config: GatefileConfig;
}
export async function fireOnPlanApproved(
  plan: PlanFile,
  context: NotificationContext
): Promise<void>;
```

CLI creates the context from its selected engine. Preserve deprecated helper
names as adapters and log delivery failures without changing authorization.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/config-contract.test.js test/mvp-features.test.js test/engine.test.js`

Expected: all selected tests pass.

Commit: `git commit -m "fix: unify config and notification contracts"`

### Task 2: Make inspect and convenience APIs authority-complete

**Files:**
- Modify: `src/inspect.ts`
- Modify: `src/engine.ts`
- Modify: `src/engine-api.ts`
- Modify: `src/sdk.ts`
- Modify: `src/pr-review.ts`
- Modify: `test/inspect.test.js`
- Modify: `test/engine-api.test.js`
- Modify: `test/sdk.test.js`

**Interfaces:**
- Produces: `InspectReport.verification: VerifyPlanReport` and single-snapshot human formatting.
- Authority rule: package-root and SDK helpers use runtime-derived repository identity unless an explicit trusted option supplies one.

- [ ] **Step 1: Write failing report and foreign-context tests**

Assert JSON inspect includes the exact verification object used for status and
human formatting. Create repositories A and B, bind a plan to A, execute the
root/SDK helper in B with no override, and assert inspection/approval reject it
without rewriting the plan.

```js
const report = engine.inspectPlan(plan);
assert.deepEqual(report.verification, engine.verifyPlan(plan));
assert.match(engine.formatInspectPlan(plan, report), /Signer trust:/);
await assert.rejects(() => sdk.approvePlan(foreignPath, 'reviewer'), /repository context/i);
```

- [ ] **Step 2: Verify the regressions are red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/inspect.test.js test/engine-api.test.js test/sdk.test.js`

Expected: inspect omits verification and at least one convenience helper adopts the plan's repository ID.

- [ ] **Step 3: Embed one verification snapshot**

Change the report and formatter contract:

```ts
export interface InspectReport {
  planId: string;
  verification: VerifyPlanReport;
  dependencies: DependencyStatusReport;
  // existing descriptive fields remain
}
export function formatInspectSummary(plan: PlanFile, report: InspectReport): string;
```

`buildInspectReport` calls `verifyPlan` once with the operation's config/context;
the formatter never reloads config or reverifies.

- [ ] **Step 4: Remove plan-selected authority fallbacks**

Delete every `options.repositoryId ?? plan.context.repositoryId` convenience
fallback. Construct the engine from `repoRoot`, explicit `repositoryId`,
`stateHome`, and config only. Keep explicit trusted integration overrides.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/inspect.test.js test/engine.test.js test/engine-api.test.js test/sdk.test.js test/pr-review.test.js`

Expected: all selected tests pass.

Commit: `git commit -m "fix: make inspect reports authority-complete"`

### Task 3: Make dry-run and pipeline outcomes deterministic and fail-closed

**Files:**
- Modify: `src/types.ts`
- Modify: `src/applier.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/cli.ts`
- Modify: `test/apply.test.js`
- Modify: `test/pipeline.test.js`
- Create: `test/pipeline-contract.test.js`

**Interfaces:**
- Produces: `DryRunReport.staticGate`, per-operation `allowed`, `PipelineResult.inputErrors`, and retained `PipelinePlanResult.previewReport`.

- [ ] **Step 1: Write failing preview and discovery tests**

Cover pending approval, signer denial, denied file/command operations, malformed
JSON, malformed plan-like JSON, unrelated JSON, duplicate IDs, cycles, and
repeated directory runs. Assert input errors prevent every apply.

```js
assert.equal(preview.success, true);
assert.deepEqual(preview.staticGate, {
  passed: false,
  verificationReady: false,
  dependenciesSatisfied: true,
  operationsAllowed: true,
  preconditionsChecked: false
});
assert.equal(result.success, false);
assert.equal(result.results.length, 0);
assert.match(result.inputErrors[0].message, /duplicate plan id/i);
```

- [ ] **Step 2: Verify the regressions are red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/apply.test.js test/pipeline.test.js test/pipeline-contract.test.js`

Expected: invalid inputs are skipped, duplicates overwrite, or blocked previews are reported as passed.

- [ ] **Step 3: Add explicit static-gate evidence**

```ts
export interface DryRunStaticGate {
  passed: boolean;
  verificationReady: boolean;
  dependenciesSatisfied: boolean;
  operationsAllowed: boolean;
  preconditionsChecked: false;
}
```

Set `allowed` on every operation preview. Preserve `success: true` when preview
generation completes; calculate `staticGate.passed` from the three static facts.

- [ ] **Step 4: Validate all pipeline inputs before constructing an engine**

Sort filenames, parse each `.json`, ignore only valid objects with no plan marker,
run `validatePlanFile` on every plan-like object, collect filename-specific input
errors, detect duplicate IDs and cycles, and return `success: false` with no plan
results if any input error exists. Use stable DFS order over sorted entries.

- [ ] **Step 5: Retain blocked dry-run reports**

Add `previewReport?: DryRunReport` to each plan result. A generated preview with
`staticGate.passed === false` becomes a failed pipeline item with precise blocker
text and the full report attached.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/apply.test.js test/pipeline.test.js test/pipeline-contract.test.js`

Expected: all selected tests pass and repeated runs deep-equal.

Commit: `git commit -m "fix: make pipeline outcomes fail closed"`

### Task 4: Derive audit from authenticated state receipts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state-records.ts`
- Modify: `src/state.ts`
- Modify: `src/applier.ts`
- Replace: `src/audit.ts`
- Modify: `src/cli.ts`
- Modify: `test/audit.test.js`
- Create: `test/authenticated-audit.test.js`

**Interfaces:**
- Produces: optional `ReceiptRecordBody.audit`; `listAuthenticatedReceipts(options)`; audit events carrying receipt ID, plan hash, signer identity, and `authenticated: true`.
- Compatibility: records without audit metadata remain valid; unauthenticated legacy writer functions throw before I/O.

- [ ] **Step 1: Write failing authenticated audit tests**

Apply a real plan and assert audit sees it. Plant a plausible repository-local
legacy event and assert it is ignored. Tamper with a receipt, add an unexpected
file/symlink, and assert audit throws. Handcraft a valid old authenticated
receipt without metadata and assert enumeration still succeeds.

```js
const events = audit({ repoRoot, repositoryId, stateHome });
assert.equal(events[0].authenticated, true);
assert.equal(events[0].receiptId, apply.receipt.id);
assert.throws(() => writeApplyReceipt(plan, report), /unauthenticated.*removed/i);
```

- [ ] **Step 2: Verify the regressions are red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/audit.test.js test/authenticated-audit.test.js`

Expected: real applies are invisible and planted legacy JSON is accepted.

- [ ] **Step 3: Extend and strictly validate receipt metadata**

```ts
export interface ReceiptAuditMetadata {
  summary: string;
  source: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalIdentity: "signed" | "unsigned";
  signerKeyId?: string;
}
```

Allow the field to be absent when reading old records; when present, reject
unknown/missing/wrongly typed nested fields. Include the metadata in new
success/failure receipts and pessimistic receipt-size calculations.

- [ ] **Step 4: Enumerate verified receipt chains**

Resolve the canonical state layout, inspect directory safety, sort entries,
reject non-record filenames and symlinks, then reuse receipt-chain verification
for every record. Return only authenticated bodies after snapshot validation.

- [ ] **Step 5: Replace legacy audit reads and expose trusted CLI flags**

Project events from `listAuthenticatedReceipts`; filter by plan ID/time only
after authentication. Add `--repo-root`, `--repository-id`, and `--state-home`
to `gatefile audit`. Keep old writer exports only as functions that throw.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/audit.test.js test/authenticated-audit.test.js test/state-records.test.js test/filesystem-state-hardening.test.js test/apply.test.js`

Expected: all selected tests pass.

Commit: `git commit -m "fix: authenticate audit events"`

### Task 5: Publish an explicit installed-package contract

**Files:**
- Modify: `package.json`
- Replace: `src/index.ts`
- Replace: `test/public-types.test.js`
- Create: `test/package-contract.test.js`

**Interfaces:**
- Produces: allowlisted package root plus `./schema/gatefile.schema.json`, `./schema/gatefile.config.schema.json`, and `./package.json` export subpaths.

- [ ] **Step 1: Write a failing installed-consumer test**

Pack Gatefile, install the tarball in a clean temporary package, run CJS, ESM,
and TypeScript consumers, execute both `.bin` commands, import both schemas, and
assert unsupported deep imports fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
Capture `Object.keys(require('gatefile')).sort()` and compare with the reviewed
public allowlist.

- [ ] **Step 2: Verify the regression is red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/package-contract.test.js`

Expected: a `gatefile/dist/applier` import succeeds or unsupported root exports appear.

- [ ] **Step 3: Add the exports map and explicit root API**

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "require": "./dist/index.js", "default": "./dist/index.js" },
  "./schema/gatefile.schema.json": "./schema/gatefile.schema.json",
  "./schema/gatefile.config.schema.json": "./schema/gatefile.config.schema.json",
  "./package.json": "./package.json"
}
```

Replace wildcard kernel exports with named supported exports and type exports.
Do not root-export raw planner/applier/state kernels or legacy audit writers.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/package-contract.test.js test/public-types.test.js test/engine-api.test.js test/sdk.test.js`

Expected: all installed consumer and compatibility tests pass.

Commit: `git commit -m "fix: define the installed package boundary"`

### Task 6: Pin MCP authority and validate the JSON-RPC/tool boundary

**Files:**
- Create: `src/confined-io.ts`
- Replace: `src/mcp.ts`
- Modify: `src/mcp-server.ts`
- Modify: `src/cli.ts`
- Modify: `src/applier.ts`
- Modify: `src/types.ts`
- Modify: `test/pr5-api-cli-integration.test.js`
- Create: `test/mcp-contract.test.js`
- Create: `test/mcp-authority.test.js`

**Interfaces:**
- Produces: `McpServerOptions` with pinned engine options and explicit capabilities; pure message decode/dispatch; confined plan I/O; captured command execution.

- [ ] **Step 1: Write failing protocol and authority tests**

Spawn the server and send malformed JSON, `null`, wrong `jsonrpc`, null/fractional
IDs, malformed params, unknown tools, and notifications. Then attempt absolute
paths, `..`, symlink escapes, request-selected runtime fields/keys, approval, and
apply without startup capability. Assert rejected requests cause no I/O and the
server remains alive.

```js
assert.deepEqual(await rpc('{'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
assert.equal(await notification({ jsonrpc: '2.0', method: 'ping' }), undefined);
assert.equal((await call('approve_plan', { path: 'plan.json', by: 'model' })).error.code, -32601);
```

- [ ] **Step 2: Add a failing clean-stdout regression**

Enable apply at startup, apply a command writing both stdout and stderr, and
assert server stdout contains exactly one parseable JSON-RPC response line and
neither child marker. Assert bounded captured output appears only in the tool
result or server stderr.

- [ ] **Step 3: Verify the regressions are red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/mcp-contract.test.js test/mcp-authority.test.js`

Expected: malformed input crashes/is accepted, request authority is honored, or child stdout corrupts the stream.

- [ ] **Step 4: Implement startup-pinned capabilities and confined I/O**

```ts
export interface McpServerOptions extends GatefileEngineOptions {
  capabilities?: { approve?: boolean; apply?: boolean; rollback?: boolean };
  maxMessageBytes?: number;
}
```

Construct one engine at startup. Remove `repo_root`, `repository_id`,
`state_home`, `by`, `signing_key`, and `key_id` from tool schemas. Keep approval
absent unless an out-of-band startup approver/key configuration exists; default
apply/rollback to disabled. Resolve plan/output paths through no-follow confined
I/O beneath the pinned root.

- [ ] **Step 5: Implement strict protocol/tool decoding**

Validate exact JSON-RPC and per-tool argument allowlists before handlers. Map
parse/request/method/params errors to the four standard codes. Never execute or
respond to a notification. Reject oversized lines and continue reading later
requests. Restore console methods on close and do not call `process.exit` from
the library function.

- [ ] **Step 6: Capture command output for MCP**

Add an engine/apply option selecting inherited versus bounded captured command
stdio. CLI keeps inherited output; MCP selects capture. Include truncated output
in operation result messages and never in protocol stdout.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/mcp-contract.test.js test/mcp-authority.test.js test/pr5-api-cli-integration.test.js test/structured-commands.test.js test/engine.test.js`

Expected: all selected tests pass.

Commit: `git commit -m "fix: pin and validate the MCP authority boundary"`

### Task 7: Make the reusable Action trusted and evidence-preserving

**Files:**
- Replace: `.github/actions/gatefile-pr-gate/action.yml`
- Create: `.github/actions/gatefile-pr-gate/run.sh`
- Create: `.github/actions/gatefile-pr-gate/manifest.js`
- Modify: `docs/examples/github-pr-gate.yml`
- Modify: `docs/examples/github-pr-gate.inlined.yml`
- Modify: `docs/github-pr-gate-example.md`
- Modify: `README.md`
- Create: `test/action-contract.test.js`

**Interfaces:**
- Produces: inspect, verify, dry-run, and manifest artifacts generated by action-owned Gatefile; tracked-plan and trusted-policy enforcement; artifact paths as Action outputs.

- [ ] **Step 1: Write a failing isolated-consumer harness**

Create a fake consumer repository with no Gatefile source and a malicious
`dist/cli.js` that prints ready. Copy/mount the Action path separately, execute
`run.sh` with GitHub environment variables, and assert the malicious marker is
never executed. Cover untracked/mutated plans, missing/mismatched trusted policy,
failed verification evidence, and manifest hashes.

- [ ] **Step 2: Verify the regression is red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/action-contract.test.js`

Expected: the current Action has no action-owned runner and trusts consumer `dist/cli.js`.

- [ ] **Step 3: Implement an action-owned runner**

Resolve the package root from `GITHUB_ACTION_PATH/../../..`, run `npm ci` and
`npm run build` there, and invoke its absolute `dist/cli.js`. Remove caller
install/build inputs. Require `git ls-files --error-unmatch "$PLAN"` and an empty
`git diff --exit-code -- "$PLAN"` before inspection.

- [ ] **Step 4: Bind trusted policy and evidence**

Copy policy from the caller-supplied trusted base/ref into an isolated pinned
config snapshot, verify its caller-supplied SHA-256 digest, and fail closed when
absent unless `allow-unsigned-no-policy` is exactly `true`. Generate every report
before evaluating readiness. Create a manifest with package version, plan ID,
semantic hash, raw SHA-256, and `git rev-parse HEAD`.

- [ ] **Step 5: Upload evidence before enforcing status**

Define Action outputs for report paths. Use an `always()` artifact step with
`if-no-files-found: error`, then a final shell step that reads verification and
static-gate JSON and exits nonzero when not ready. Rename Planfile references to
Gatefile and pin examples to an immutable release placeholder such as
`StephenBickel/gatefile/.github/actions/gatefile-pr-gate@v0.3.0-alpha.0`.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/action-contract.test.js test/public-launch-demo.test.js`

Expected: all selected tests and shell syntax checks pass.

Commit: `git commit -m "fix: make the PR Action a trusted gate"`

### Task 8: Prove cross-interface consistency and release readiness

**Files:**
- Create: `test/cross-interface-contract.test.js`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `docs/product-roadmap.md`

**Interfaces:**
- Consumes: installed package, CLI, MCP, and Action harness contracts from Tasks 1-7.
- Produces: one evidence fixture asserting plan identity, semantic hash, verification status, signer trust, and static-gate readiness are equal everywhere.

- [ ] **Step 1: Write the cross-interface fixture**

Create one signed plan/config/state fixture and collect normalized evidence from
installed CJS, installed ESM, CLI JSON, MCP JSON text, and Action artifacts.

```js
for (const evidence of [cjs, esm, cli, mcp, action]) {
  assert.equal(evidence.planId, expected.planId);
  assert.equal(evidence.semanticHash, expected.semanticHash);
  assert.equal(evidence.status, expected.status);
  assert.deepEqual(evidence.signerTrust, expected.signerTrust);
  assert.equal(evidence.staticGatePassed, expected.staticGatePassed);
}
```

- [ ] **Step 2: Verify and fix only boundary mismatches**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/cross-interface-contract.test.js`

Expected before final integration: the test identifies any remaining adapter field/name mismatch; make only the minimal adapter correction needed and rerun to green.

- [ ] **Step 3: Update architecture and release documentation**

Document the package allowlist, startup-pinned MCP capability model,
authenticated audit source, static-gate semantics, strict config migration, and
trusted Action inputs. Mark the PR7 roadmap item complete without claiming the
alpha is production-ready.

- [ ] **Step 4: Run the complete local release gate**

Run:

```bash
npm test
npm run typecheck
npm run demo:e2e
bash -n .github/actions/gatefile-pr-gate/run.sh demo/public-launch-e2e.sh
npm pack --dry-run
npm audit --omit=dev
git diff --check
git status --short
```

Expected: all tests pass with only explicitly documented skips; typecheck and
demo pass; shell syntax is valid; production audit reports zero vulnerabilities;
diff check is clean; status contains only intended PR7 files before commit.

- [ ] **Step 5: Commit, independently review, push, and merge**

Commit: `git commit -m "test: enforce cross-interface contracts"`

Run two independent reviews: one for authority/security and one for API/schema/
compatibility. Resolve every critical, important, and minor finding, rerun the
complete release gate on the reviewed SHA, push, open the PR, wait for GitHub CI,
merge only after green, then clone fresh `main` and rerun `npm ci`, `npm test`,
and `npm run typecheck`.
