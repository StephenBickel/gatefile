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
      path: '', // will be set per-test
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

test('applyPlanFile executes file operations', async () => {
  const dir = tmpDir();
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
  await createPlan(draft, { outPath });
  await approvePlanFile(outPath, { approvedBy: 'tester' });

  const report = await applyPlanFile(outPath);
  assert.equal(report.success, true);
  assert.equal(fs.readFileSync(targetFile, 'utf-8'), 'created by sdk');
});
