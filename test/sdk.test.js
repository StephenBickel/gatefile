const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPlan,
  inspectPlan,
  approvePlanFile,
  verifyPlanFile,
  applyPlanFile
} = require('../dist');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-sdk-'));
}

const baseDraft = {
  source: 'sdk-test',
  summary: 'SDK test plan',
  operations: [
    {
      id: 'op1',
      type: 'file',
      action: 'create',
      path: 'sdk-placeholder.txt',
      after: 'hello from sdk'
    }
  ],
  preconditions: []
};

test('createPlan returns a valid PlanFile and optionally writes to disk', async () => {
  const dir = tmpDir();
  const outPath = path.join(dir, 'plan.json');

  const plan = await createPlan(baseDraft, { outPath });
  assert.ok(plan.id.startsWith('plan_'));
  assert.equal(plan.source, 'sdk-test');
  assert.equal(plan.approval.status, 'pending');
  assert.ok(plan.integrity.planHash);

  const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  assert.equal(onDisk.id, plan.id);
});

test('inspectPlan returns structured report', async () => {
  const dir = tmpDir();
  const outPath = path.join(dir, 'plan.json');
  await createPlan(baseDraft, { outPath });

  const report = await inspectPlan(outPath);
  assert.equal(report.source, 'sdk-test');
  assert.equal(report.operationCount, 1);
  assert.ok(report.integrity.currentPlanHash);
});

test('approvePlanFile + verifyPlanFile lifecycle', async () => {
  const dir = tmpDir();
  const outPath = path.join(dir, 'plan.json');
  await createPlan(baseDraft, { outPath });

  // Before approval: not ready
  const pre = await verifyPlanFile(outPath);
  assert.equal(pre.status, 'not-ready');

  // Approve
  const result = await approvePlanFile(outPath, { approvedBy: 'tester' });
  assert.ok(result.approvedPlanHash);
  assert.equal(result.plan.approval.status, 'approved');

  // After approval: ready
  const post = await verifyPlanFile(outPath);
  assert.equal(post.status, 'ready');
});

test('applyPlanFile dry-run returns DryRunReport', async () => {
  const dir = tmpDir();
  const outPath = path.join(dir, 'plan.json');
  await createPlan(baseDraft, { outPath });

  const report = await applyPlanFile(outPath, { dryRun: true });
  assert.ok(report.planId);
  assert.equal(report.success, true);
  assert.ok('previewedAt' in report); // DryRunReport marker
});

test('applyPlanFile executes file operations', async (t) => {
  const dir = tmpDir();
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-sdk-state-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  });
  const targetFile = path.join(dir, 'output.txt');
  const draft = {
    ...baseDraft,
    operations: [
      {
        id: 'op1',
        type: 'file',
        action: 'create',
        path: targetFile,
        after: 'created by sdk'
      }
    ],
    execution: { filePolicy: { allowedRoots: [dir] } }
  };

  const outPath = path.join(dir, 'plan.json');
  await createPlan(draft, { outPath, repoRoot: dir });
  await approvePlanFile(outPath, { approvedBy: 'tester' });

  const wrongContext = await verifyPlanFile(outPath);
  assert.equal(wrongContext.status, 'not-ready');
  const correctContext = await verifyPlanFile(outPath, { repoRoot: dir });
  assert.equal(correctContext.status, 'ready');

  const report = await applyPlanFile(outPath, { repoRoot: dir, stateHome });
  assert.equal(report.success, true);
  assert.equal(fs.readFileSync(targetFile, 'utf-8'), 'created by sdk');
  assert.equal(
    report.receipt.path.startsWith(`${fs.realpathSync(stateHome)}${path.sep}`),
    true,
    'the SDK must forward its explicit authenticated state home'
  );
});

test('applyPlanFile returns the core rollback authority without post-apply state recomputation', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, '{"context":{"repositoryId":"repo:from-plan"}}\n', 'utf8');

  const applierPath = require.resolve('../dist/applier');
  const statePath = require.resolve('../dist/state');
  const sdkPath = require.resolve('../dist/sdk');
  const applier = require(applierPath);
  const state = require(statePath);
  const originalApply = applier.applyPlan;
  const originalGetStateLayout = state.getStateLayout;
  const rollbackContext = {
    receiptId: 'receipt-from-core',
    repoRoot: '/canonical/repo',
    repositoryId: 'repo:from-core',
    stateHome: '/canonical/state'
  };
  const coreReport = {
    success: false,
    receipt: { id: rollbackContext.receiptId, path: '/canonical/state/receipt.json' },
    rollbackContext,
    rollbackCommand: 'gatefile rollback-apply receipt-from-core --yes'
  };

  applier.applyPlan = () => coreReport;
  state.getStateLayout = () => {
    throw new Error('post-apply state layout resolution must not run');
  };
  delete require.cache[sdkPath];

  try {
    const isolatedSdk = require(sdkPath);
    const report = await isolatedSdk.applyPlan(planPath);
    assert.equal(report, coreReport);
    assert.deepEqual(report.rollbackContext, rollbackContext);
  } finally {
    applier.applyPlan = originalApply;
    state.getStateLayout = originalGetStateLayout;
    delete require.cache[sdkPath];
  }
});
