# Gatefile Policy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every supported package-root and first-party plan lifecycle through one policy-aware `GatefileEngine` with a pinned repository/state context.

**Architecture:** Add a synchronous in-memory engine over the existing planner, verifier, inspector, applier, and state kernels. Adapters keep transport and plan-file I/O, while the engine owns config resolution, repository binding, policy hooks, verification, preview, apply, and rollback. Existing package-root lifecycle names become compatibility wrappers over the engine; unsupported deep `dist/*` imports remain for PR7 to close with an explicit package export contract.

**Tech Stack:** TypeScript 5.8, Node.js 18+ CommonJS, Node test runner, existing zero-runtime-dependency core.

## Global Constraints

- Preserve plan version `2`, hash envelope version `2`, and authenticated state record version `1`.
- Add no runtime dependency.
- Keep lifecycle methods synchronous; SDK path helpers remain Promise-returning for compatibility.
- Reload repository config once per top-level operation unless an explicit normalized config was supplied to the engine.
- Keep secure apply ordering: policy `beforeApply` runs only after non-mutating command/file/state/size preflight.
- Do not redesign legacy audit storage, notification-hook config, MCP transport validation, or package `exports`; those are PR7 scope.
- Preserve PR5 rollback context and structured failure reports.
- Use failing tests before each production change and run the focused test after each change.

---

### Task 1: Add the engine contract and core lifecycle implementation

**Files:**
- Create: `src/engine.ts`
- Create: `test/engine.test.js`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `PlanDraft`, `PlanFile`, `GatefileConfig`, existing planner/verifier/inspector/applier kernels, `getRepoRoot`, `repositoryIdForRoot`, `loadGatefileConfig`, and `normalizeGatefileConfig`.
- Produces: `GatefileEngine`, `GatefileEngineOptions`, `GatefileEngineContext`, `EnginePlanOptions`, and `EngineApproveOptions`.

- [ ] **Step 1: Write failing engine context and policy tests**

Add tests that create two temporary Git repositories and assert:

```js
const engine = new GatefileEngine({
  repoRoot,
  repositoryId: 'repo:engine-test',
  stateHome,
  config: { signers: { trustedKeyIds: ['gfk1_7777777777777777'] } }
});

assert.equal(engine.context.repoRoot, fs.realpathSync(repoRoot));
assert.equal(engine.context.repositoryId, 'repo:engine-test');
assert.equal(engine.context.stateHome, stateHome);
assert.equal(engine.createPlan(draft).context.repositoryId, 'repo:engine-test');
assert.throws(
  () => engine.approvePlan(planFromOtherRepo, 'reviewer'),
  /repository context.*engine/i
);
assert.equal(engine.verifyPlan(unsignedPlan).signerTrust.policyConfigured, true);
assert.throws(() => engine.applyPlan(unsignedPlan), /signer|unsigned|verification/i);
```

Add a config-reload test: construct the engine with no explicit config, verify an unsigned approved plan while no config exists, write a signer policy to `gatefile.config.json`, and verify again. The second report must show `policyConfigured === true` and `status === "not-ready"`.

- [ ] **Step 2: Run the engine test and verify red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine.test.js`

Expected: build fails because `src/engine.ts` and `GatefileEngine` do not exist.

- [ ] **Step 3: Implement the engine**

Create these public shapes in `src/engine.ts`:

```ts
export interface GatefileEngineOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  config?: GatefileConfig;
}

export interface GatefileEngineContext {
  repoRoot: string;
  repositoryId: string;
  stateHome: string;
}

export interface EnginePlanOptions {
  planPath?: string;
}

export interface EngineApproveOptions extends ApprovePlanOptions {
  planPath?: string;
}
```

Implement `GatefileEngine` with readonly canonical context, a private explicit
config snapshot, and this method set. Resolve the effective state home once with
`resolveStateHome(options.stateHome)` so later environment changes cannot move an
existing engine into another state namespace:

```ts
createPlan(draft: PlanDraft): PlanFile;
inspectPlan(plan: PlanFile): InspectReport;
formatInspectPlan(plan: PlanFile, report: InspectReport): string;
approvePlan(plan: PlanFile, approvedBy: string, options?: EngineApproveOptions): PlanFile;
verifyPlan(plan: PlanFile): VerifyPlanReport;
previewPlan(plan: PlanFile, options?: EnginePlanOptions): DryRunReport;
applyPlan(plan: PlanFile, options?: EnginePlanOptions): ApplyReport;
rollbackApply(receiptId: string): RollbackReport;
```

`policyConfig()` must call `normalizeGatefileConfig` on the explicit snapshot or call `loadGatefileConfig(this.context.repoRoot)` on every top-level method. Every raw kernel call receives the pinned `repoRoot`, `repositoryId`, `stateHome`, and one config snapshot. `approvePlan` must validate `plan.context.repositoryId === this.context.repositoryId`, then run `beforeApprove`, then call the planner kernel.

- [ ] **Step 4: Export the class deliberately**

Add only these engine exports to `src/index.ts`:

```ts
export { GatefileEngine } from "./engine";
export type {
  GatefileEngineOptions,
  GatefileEngineContext,
  EnginePlanOptions,
  EngineApproveOptions
} from "./engine";
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine.test.js`

Expected: all engine tests pass.

Commit:

```bash
git add src/engine.ts src/index.ts test/engine.test.js
git commit -m "feat: add policy-aware GatefileEngine"
```

### Task 2: Pin preconditions and policy-hook working directories

**Files:**
- Modify: `src/preconditions.ts`
- Modify: `src/applier.ts`
- Modify: `src/hooks.ts`
- Modify: `test/engine.test.js`
- Modify: `test/apply.test.js`

**Interfaces:**
- Consumes: `GatefileEngine.context.repoRoot` through existing `PlanRuntimeOptions.repoRoot`.
- Produces: `checkPreconditions(preconditions, { cwd })` and repository-relative policy hook execution.

- [ ] **Step 1: Write failing cross-CWD tests**

Create repository A on branch `engine-branch`, repository B on another branch,
`process.chdir(repoB)`, and apply through an engine pinned to A with a
`branch_is: engine-branch` precondition. Assert apply succeeds in A. Add a
`git_clean` case where B is dirty and A is clean; it must also succeed.

Add a hook test with:

```json
{
  "hooks": {
    "beforeApply": {
      "command": "node -e \"require('node:fs').writeFileSync('hook-cwd.txt','ok')\"",
      "cwd": "policy-workdir"
    }
  }
}
```

Assert the marker is created under `<repoRoot>/policy-workdir`, not process CWD.

- [ ] **Step 2: Verify both regressions fail**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine.test.js test/apply.test.js`

Expected: branch/clean checks use ambient CWD and hook output appears in the wrong directory or the hook fails.

- [ ] **Step 3: Implement pinned execution**

Change `checkPreconditions` to accept:

```ts
export interface PreconditionOptions { cwd?: string }
export function checkPreconditions(
  preconditions: Precondition[],
  options: PreconditionOptions = {}
): PreconditionResult
```

Use `execFileSync("git", [...], { cwd: options.cwd, encoding: "utf8", shell: false })` for branch and clean checks. In `applyPlan`, resolve the canonical root before preconditions and call `checkPreconditions(plan.preconditions, { cwd: repoRoot })`.

In `runPolicyHook`, compute:

```ts
const cwd = hookConfig.cwd
  ? resolve(context.repoRoot, hookConfig.cwd)
  : context.repoRoot;
execSync(hookConfig.command, { cwd, stdio: "pipe" });
```

- [ ] **Step 4: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine.test.js test/apply.test.js`

Expected: all selected tests pass.

Commit:

```bash
git add src/preconditions.ts src/applier.ts src/hooks.ts test/engine.test.js test/apply.test.js
git commit -m "fix: pin policy checks to the engine repository"
```

### Task 3: Route supported package-root lifecycle functions through the engine

**Files:**
- Create: `src/engine-api.ts`
- Modify: `src/index.ts`
- Modify: `src/inspect.ts`
- Create: `test/engine-api.test.js`
- Modify: `test/public-types.test.js`

**Interfaces:**
- Consumes: `GatefileEngine` and current planner/verifier/inspector/applier option signatures.
- Produces: compatibility exports named `createPlanFromDraft`, `approvePlan`, `verifyPlan`, `buildInspectReport`, `previewPlan`, `applyPlan`, and `rollbackApply`.

- [ ] **Step 1: Add failing wrapper-policy tests**

From `require('../dist')`, create a plan in a temporary repo with a blocking
`beforeApprove` config. Call root `approvePlan` while that repo is process CWD and
assert it throws. Add a static assertion that `src/index.ts` explicitly exports
the seven lifecycle names from `./engine-api`.

Extend the packed consumer fixture to import and instantiate `GatefileEngine`
with `compilerOptions.types = []`.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine-api.test.js test/public-types.test.js`

Expected: the root approval bypasses the hook and the explicit engine API export is absent.

- [ ] **Step 3: Implement compatibility wrappers**

Create synchronous wrappers in `src/engine-api.ts`. Preserve each existing
signature. For example:

```ts
export function verifyPlan(
  plan: PlanFile,
  options: VerifyPlanOptions = {}
): VerifyPlanReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    config: options.config
  }).verifyPlan(plan);
}
```

`createPlanFromDraft` maps `options.context?.repositoryId` into engine
construction. `approvePlan` constructs with the plan repository ID to preserve
the legacy explicit-context flow while loading policy from canonical process CWD.
Inspect preserves its historical dependency default by using
`options.repositoryId ?? plan.context.repositoryId`. Apply, preview, and rollback
forward every `PlanRuntimeOptions` field.

Make `InspectOptions` exported from `src/inspect.ts`. In `src/index.ts`, keep
existing wildcard exports for alpha compatibility, then add an explicit export
list from `./engine-api`; explicit exports are the supported root bindings.

- [ ] **Step 4: Run wrapper, public type, and existing root API tests**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine-api.test.js test/public-types.test.js test/gatefile.test.js test/apply.test.js test/inspect.test.js`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine-api.ts src/index.ts src/inspect.ts test/engine-api.test.js test/public-types.test.js
git commit -m "refactor: back lifecycle exports with GatefileEngine"
```

### Task 4: Migrate SDK and pipeline policy paths

**Files:**
- Modify: `src/sdk.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/index.ts`
- Modify: `test/sdk.test.js`
- Modify: `test/pipeline.test.js`

**Interfaces:**
- Consumes: in-memory `GatefileEngine` methods.
- Produces: SDK context options on every policy method, `rollbackApply` SDK helper exported as `rollbackApplyFile`, and one engine per pipeline invocation.

- [ ] **Step 1: Add failing parity tests**

For SDK and pipeline separately, configure a trusted signer key ID, create an
unsigned approved plan, and assert no target mutation occurs. Add SDK and pipeline
`beforeApply` blockers. Add SDK approval with `beforeApprove` and assert the plan
file bytes are unchanged. Add SDK rollback using the apply report context.

- [ ] **Step 2: Verify the current bypasses**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/sdk.test.js test/pipeline.test.js`

Expected: unsigned SDK/pipeline applies mutate targets and SDK approval ignores `beforeApprove`.

- [ ] **Step 3: Migrate SDK**

Define a shared option base:

```ts
export interface SdkEngineOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  config?: GatefileConfig;
}
```

Make `CreateOptions`, `InspectOptions`, `ApproveOptions`, `ApplyOptions`, and
`VerifyOptions` extend the relevant subset. Construct one engine inside each SDK
function and delegate the parsed plan. `approvePlan` passes `planPath` and writes
only after engine success. Add:

```ts
export async function rollbackApply(
  receiptId: string,
  options: SdkEngineOptions
): Promise<RollbackReport>
```

Export it from `src/index.ts` as `rollbackApplyFile`.

- [ ] **Step 4: Migrate pipeline**

Construct one engine before iterating sorted entries. Replace raw preview/verify/
apply calls with engine calls. Real execution calls `engine.applyPlan` directly so
verification and apply use one policy snapshot; preserve caught-error and
structured `applyReport` behavior.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/sdk.test.js test/pipeline.test.js test/pr5-api-cli-integration.test.js`

Expected: all selected tests pass and policy-denied targets remain unchanged.

Commit:

```bash
git add src/sdk.ts src/pipeline.ts src/index.ts test/sdk.test.js test/pipeline.test.js
git commit -m "refactor: route SDK and pipelines through the engine"
```

### Task 5: Migrate CLI, interactive review, and PR rendering

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/review.ts`
- Modify: `src/pr-review.ts`
- Create: `test/engine-boundary.test.js`
- Modify: `test/inspect.test.js`
- Modify: `test/pr-review.test.js`

**Interfaces:**
- Consumes: `GatefileEngine` and adapter-owned JSON I/O/formatting.
- Produces: first-party adapter import boundary with no direct lifecycle-kernel calls.

- [ ] **Step 1: Write a failing static boundary test**

Read `src/cli.ts`, `src/sdk.ts`, `src/pipeline.ts`, `src/review.ts`, and
`src/pr-review.ts`. Strip comments and assert they do not import lifecycle
symbols from `./planner`, `./applier`, `./verify`, or `./inspect`. Allow pure
formatters and types through type-only imports. MCP is added to the same list in
Task 6, after its migration.

Add a non-TTY review test that injects an engine with signer policy and confirms
the rendered readiness matches `engine.verifyPlan`. Add a PR renderer test that
passes engine context and gets the same signer status.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine-boundary.test.js test/inspect.test.js test/pr-review.test.js`

Expected: direct imports are reported for every listed adapter.

- [ ] **Step 3: Migrate the CLI and reviewer**

Construct a `GatefileEngine` from canonical CLI runtime arguments for create,
inspect, approve, verify, preview, apply, rollback, and pipeline. Keep adaptation,
formatting, key generation, audit, and notification delivery adapter-owned.

Change `reviewPlan` to accept:

```ts
export interface ReviewPlanOptions { engine?: GatefileEngine }
export async function reviewPlan(
  planPath: string,
  options: ReviewPlanOptions = {}
): Promise<void>
```

Use the selected engine for non-TTY inspect/format and TTY approval. Persist only
after approval returns.

- [ ] **Step 4: Make PR rendering consume an engine assessment**

Extend `PRReviewCommentInputs` with optional `engine`, `repoRoot`,
`repositoryId`, and `stateHome`. If reports are absent, construct/use one engine
and call its inspect/verify methods. Keep Markdown rendering pure after reports
are resolved.

- [ ] **Step 5: Run focused CLI/review tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/engine-boundary.test.js test/inspect.test.js test/pr-review.test.js test/apply.test.js test/public-launch-demo.test.js`

Expected: all selected tests pass and the static boundary is clean for every
adapter migrated in this task.

Commit:

```bash
git add src/cli.ts src/review.ts src/pr-review.ts test/engine-boundary.test.js test/inspect.test.js test/pr-review.test.js
git commit -m "refactor: route CLI review paths through the engine"
```

### Task 6: Migrate MCP lifecycle tools

**Files:**
- Modify: `src/mcp.ts`
- Modify: `test/pr5-api-cli-integration.test.js`
- Modify: `test/engine-boundary.test.js`

**Interfaces:**
- Consumes: one `GatefileEngine` per MCP tool call.
- Produces: policy-parity for inspect/create/approve/verify/preview/apply/rollback while preserving JSON-RPC and `isError` conventions.

- [ ] **Step 1: Add failing MCP policy tests**

Spawn the MCP server in a repository containing a blocking `beforeApprove`
config. Call `approve_plan` with `repo_root`; assert `isError === true` and exact
plan bytes are unchanged. Add a signer-policy apply call and assert `isError ===
true` with no target mutation.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/pr5-api-cli-integration.test.js test/engine-boundary.test.js`

Expected: MCP approval succeeds despite the hook and the boundary test reports raw imports.

- [ ] **Step 3: Migrate MCP handlers**

Add optional `repo_root` and `repository_id` fields to `approve_plan`. Build one
engine from `runtimeContext(args)` per tool call. Replace lifecycle kernel calls
with engine methods. Pass `planPath` for approve/preview/apply. Continue reading
signing key bytes in the adapter and writing an approved plan only after engine
success. Preserve `toolResult(..., !report.success)` for apply/rollback reports.
Add `src/mcp.ts` to the adapter list asserted by `test/engine-boundary.test.js`.

- [ ] **Step 4: Run MCP and boundary tests and commit**

Run: `npm run build && node --require ./test-support/test-env.cjs --test test/pr5-api-cli-integration.test.js test/engine-boundary.test.js`

Expected: all selected tests pass.

Commit:

```bash
git add src/mcp.ts test/pr5-api-cli-integration.test.js test/engine-boundary.test.js
git commit -m "refactor: enforce engine policy through MCP"
```

### Task 7: Document, package-test, review, and release PR6

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/product-roadmap.md`
- Modify: `test/public-types.test.js`
- Modify: `test/engine-boundary.test.js`

**Interfaces:**
- Consumes: completed engine and adapter migrations.
- Produces: documented primary API and verified packed declarations/artifacts.

- [ ] **Step 1: Update public documentation**

Document `GatefileEngine` as the primary in-memory API, its pinned context, config
reload behavior, and compatibility wrappers. Replace README language describing
root lifecycle functions as policy-free low-level functions. State explicitly
that deep `dist/*` imports are unsupported and remain physically reachable until
PR7 adds the installed-package export contract.

- [ ] **Step 2: Run the complete validation matrix**

Run, in order:

```bash
npm test
npm run typecheck
npm run demo:e2e
bash -n demo/public-launch-e2e.sh
npm pack --dry-run --json
npm audit --omit=dev
git diff --check
```

Expected: 0 failed tests, typecheck exit 0, demo exit 0, shell syntax exit 0,
packed output includes `dist/engine.js` and `dist/engine.d.ts`, production audit
reports 0 vulnerabilities, and diff check exits 0.

- [ ] **Step 3: Run clean installed-package consumer validation**

Pack the tarball, install it into a fresh temporary directory, compile a consumer
with `types: []` that constructs `GatefileEngine`, and execute a create → inspect
→ approve → verify → preview flow. Expected: compile and runtime exit 0 without
ambient Node types.

- [ ] **Step 4: Request independent policy and API reviews**

Give reviewers the merge base and branch head. Require exact Critical/Important/
release-blocking findings, static bypass inspection, focused test reruns, and no
edits. Fix every validated blocker and rerun the complete matrix.

- [ ] **Step 5: Commit final docs/tests**

```bash
git add README.md docs/architecture.md docs/product-roadmap.md test/public-types.test.js test/engine-boundary.test.js
git commit -m "docs: make GatefileEngine the policy entry point"
```

- [ ] **Step 6: Push, open, validate, and merge PR6**

Push `codex/gatefile-policy-engine`, open the PR against `main`, wait for every CI
check, repair any failure, and merge only after green CI and independent approval.
Then clone merged `main` into a fresh temporary directory and rerun `npm ci`,
`npm test`, and `npm run typecheck` before starting PR7.
