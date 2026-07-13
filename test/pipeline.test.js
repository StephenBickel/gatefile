const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPlanFromDraft,
  approvePlan,
  rollbackApply,
  runPipeline,
  formatPipelineSummary
} = require('../dist');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pipeline-'));
}

function recoveryFixture(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  const plansDir = path.join(repoRoot, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome, plansDir };
}

function policyFixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  const plansDir = path.join(repoRoot, 'plans');
  const targetPath = path.join(repoRoot, 'managed.txt');
  fs.mkdirSync(plansDir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome, plansDir, targetPath };
}

function writeApprovedPolicyPlan(fixture, filename = 'policy.json') {
  const plan = approvePlan(
    createPlanFromDraft({
      source: 'pipeline-policy-test',
      summary: 'Pipeline policy test plan',
      operations: [
        {
          id: 'op_pipeline_policy',
          type: 'file',
          action: 'create',
          path: fixture.targetPath,
          after: 'created by pipeline policy test\n'
        }
      ],
      preconditions: []
    }, { repoRoot: fixture.repoRoot }),
    'pipeline-policy-reviewer',
    { repoRoot: fixture.repoRoot }
  );
  fs.writeFileSync(
    path.join(fixture.plansDir, filename),
    `${JSON.stringify(plan, null, 2)}\n`,
    'utf8'
  );
  return plan;
}

function blockingPolicyCommand(exitCode) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${exitCode})`)}`;
}

function writeApprovedFilePlan(fixture, operation) {
  const plan = approvePlan(
    createPlanFromDraft({
      source: 'pipeline-recovery-test',
      summary: 'Pipeline preserves authenticated recovery authority',
      operations: [operation],
      preconditions: [],
      execution: { filePolicy: { allowedRoots: [fixture.repoRoot] } }
    }, { repoRoot: fixture.repoRoot }),
    'pipeline-recovery-reviewer',
    { repoRoot: fixture.repoRoot }
  );
  fs.writeFileSync(
    path.join(fixture.plansDir, 'recovery.json'),
    `${JSON.stringify(plan, null, 2)}\n`,
    'utf8'
  );
  return plan;
}

function writePlan(dir, filename, draft, extras) {
  const plan = createPlanFromDraft(draft);
  const data = { ...plan, ...extras };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
  return plan;
}

const baseDraft = (id) => ({
  source: 'pipeline-test',
  summary: `Test plan ${id}`,
  operations: [
    { id: `op-${id}`, type: 'file', action: 'create', path: `/tmp/noop-${id}.txt`, after: 'x' }
  ],
  preconditions: []
});

test('run-pipeline on empty directory returns success', () => {
  const dir = tmpDir();
  const result = runPipeline(dir);
  assert.equal(result.success, true);
  assert.equal(result.results.length, 0);
});

test('run-pipeline dry-run reports pending plans as failed static gates', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'));

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.success, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[1].status, 'skipped');
  assert.equal(result.results[0].previewReport.staticGate.passed, false);
});

test('run-pipeline respects dependency order via dependsOn', () => {
  const dir = tmpDir();
  const planA = writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'), { dependsOn: [planA.id] });

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.success, false);
  // A should come before B in order
  const idxA = result.order.indexOf(planA.id);
  const idxB = result.order.findIndex(id => id !== planA.id);
  assert.ok(idxA < idxB, 'Plan A should execute before Plan B');
});

test('run-pipeline stops on first failure by default', () => {
  const dir = tmpDir();
  // Two unapproved plans — real apply will fail verification
  writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'));

  const result = runPipeline(dir); // real apply, not dry-run
  assert.equal(result.success, false);
  // One should fail, one should be skipped
  const failed = result.results.filter(r => r.status === 'failed');
  const skipped = result.results.filter(r => r.status === 'skipped');
  assert.equal(failed.length, 1);
  assert.equal(skipped.length, 1);
});

test('run-pipeline --continue-on-error processes all plans', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'));

  const result = runPipeline(dir, { continueOnError: true });
  assert.equal(result.success, false);
  const failed = result.results.filter(r => r.status === 'failed');
  assert.equal(failed.length, 2); // both fail (unapproved)
});

test('pipeline reports engine context initialization errors and skips remaining plans by default', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('context-a'));
  writePlan(dir, 'b.json', baseDraft('context-b'));

  const result = runPipeline(dir, { stateHome: 'relative-state-home' });

  assert.equal(result.success, false, JSON.stringify(result, null, 2));
  assert.equal(result.results.length, 2);
  assert.equal(result.results.filter((entry) => entry.status === 'failed').length, 1);
  assert.equal(result.results.filter((entry) => entry.status === 'skipped').length, 1);
  assert.match(result.results.find((entry) => entry.status === 'failed').message, /State home must be an absolute path/);
  assert.equal(result.results.find((entry) => entry.status === 'failed').applyReport, undefined);
  assert.equal(
    result.results.find((entry) => entry.status === 'skipped').message,
    'Skipped due to previous failure'
  );
});

test('pipeline reports engine config initialization errors for every plan with continueOnError', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('config-a'));
  writePlan(dir, 'b.json', baseDraft('config-b'));

  const result = runPipeline(dir, {
    continueOnError: true,
    config: { signers: { trustedKeyIds: [] } }
  });

  assert.equal(result.success, false, JSON.stringify(result, null, 2));
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((entry) => entry.status === 'failed'));
  assert.ok(result.results.every((entry) => /trust policy is empty/.test(entry.message)));
  assert.ok(result.results.every((entry) => entry.applyReport === undefined));
});

test('formatPipelineSummary produces readable output', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('a'));
  const result = runPipeline(dir, { dryRun: true });
  const summary = formatPipelineSummary(result);
  assert.ok(summary.includes('Pipeline Summary'));
  assert.ok(summary.includes('[FAIL]'));
  assert.ok(summary.includes('1 failed'));
});

test('run-pipeline skips non-plan JSON files', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{"key": "value"}', 'utf-8');
  writePlan(dir, 'plan.json', baseDraft('real'));

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.success, false);
});

test('pipeline rejects unsigned approvals under trusted-signer policy without mutation', (t) => {
  const f = policyFixture(t, 'gatefile-pipeline-signer-policy-');
  const plan = writeApprovedPolicyPlan(f);

  const result = runPipeline(f.plansDir, {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome,
    config: { signers: { trustedKeyIds: ['required-pipeline-signer'] } }
  });

  assert.equal(result.success, false, JSON.stringify(result, null, 2));
  assert.deepEqual(result.order, [plan.id]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].message, /Plan failed verification/);
  assert.match(result.results[0].message, /approval is unsigned/i);
  assert.equal(result.results[0].applyReport, undefined);
  assert.equal(fs.existsSync(f.targetPath), false);
});

test('pipeline reports beforeApply denial without target mutation', (t) => {
  const f = policyFixture(t, 'gatefile-pipeline-before-apply-');
  const plan = writeApprovedPolicyPlan(f);

  const result = runPipeline(f.plansDir, {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome,
    config: {
      hooks: {
        beforeApply: { command: blockingPolicyCommand(41) }
      }
    }
  });

  assert.equal(result.success, false, JSON.stringify(result, null, 2));
  assert.deepEqual(result.order, [plan.id]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].message, /Policy hook beforeApply blocked execution/);
  assert.equal(result.results[0].applyReport, undefined);
  assert.equal(fs.existsSync(f.targetPath), false);
});

test('pipeline constructs one engine and delegates each real plan directly to applyPlan', (t) => {
  const f = policyFixture(t, 'gatefile-pipeline-one-engine-');
  const planA = createPlanFromDraft({
    source: 'pipeline-engine-probe',
    summary: 'Pipeline engine probe A',
    operations: [{
      id: 'op_pipeline_probe_a',
      type: 'file',
      action: 'create',
      path: path.join(f.repoRoot, 'probe-a.txt'),
      after: 'a\n'
    }],
    preconditions: []
  }, { repoRoot: f.repoRoot });
  const planB = createPlanFromDraft({
    source: 'pipeline-engine-probe',
    summary: 'Pipeline engine probe B',
    operations: [{
      id: 'op_pipeline_probe_b',
      type: 'file',
      action: 'create',
      path: path.join(f.repoRoot, 'probe-b.txt'),
      after: 'b\n'
    }],
    preconditions: []
  }, { repoRoot: f.repoRoot });
  fs.writeFileSync(
    path.join(f.plansDir, 'a.json'),
    JSON.stringify(planA),
    'utf8'
  );
  fs.writeFileSync(
    path.join(f.plansDir, 'b.json'),
    JSON.stringify(planB),
    'utf8'
  );

  const enginePath = require.resolve('../dist/engine');
  const pipelinePath = require.resolve('../dist/pipeline');
  const engineModule = require(enginePath);
  const OriginalEngine = engineModule.GatefileEngine;
  const constructedWith = [];
  const applyCalls = [];

  engineModule.GatefileEngine = class PipelineEngineProbe {
    constructor(options) {
      constructedWith.push(options);
    }

    verifyPlan() {
      throw new Error('pipeline must not separately verify before apply');
    }

    applyPlan(plan, options) {
      applyCalls.push({ plan, options });
      return {
        planId: plan.id,
        appliedAt: '2026-07-13T00:00:00.000Z',
        success: true,
        results: [],
        recovery: {
          transactionalRollback: false,
          affectedPaths: [],
          attemptedOperationIds: [],
          succeededOperationIds: [],
          pendingOperationIds: [],
          steps: [],
          notes: []
        },
        dependencies: {
          requiredPlanIds: [],
          missingPlanIds: [],
          allSatisfied: true
        },
        snapshot: {
          id: `snapshot_${plan.id}`,
          path: '/stub/snapshot.json',
          fileCount: 0
        },
        receipt: { id: `receipt_${plan.id}`, path: '/stub/receipt.json' },
        rollbackContext: {
          receiptId: `receipt_${plan.id}`,
          repoRoot: f.repoRoot,
          repositoryId: 'repo:pipeline-probe',
          stateHome: f.stateHome
        },
        rollbackCommand: `gatefile rollback-apply receipt_${plan.id} --yes`
      };
    }
  };
  delete require.cache[pipelinePath];

  const config = { signers: { trustedKeyIds: ['pipeline-probe-key'] } };
  try {
    const isolatedPipeline = require(pipelinePath);
    const result = isolatedPipeline.runPipeline(f.plansDir, {
      repoRoot: f.repoRoot,
      repositoryId: 'repo:pipeline-probe',
      stateHome: f.stateHome,
      config
    });

    assert.equal(result.success, true, JSON.stringify(result, null, 2));
    assert.equal(constructedWith.length, 1);
    assert.deepEqual(constructedWith[0], {
      repoRoot: f.repoRoot,
      repositoryId: 'repo:pipeline-probe',
      stateHome: f.stateHome,
      config
    });
    assert.equal(applyCalls.length, 2);
    assert.deepEqual(
      applyCalls.map((call) => call.options),
      [
        { planPath: path.join(f.plansDir, 'a.json') },
        { planPath: path.join(f.plansDir, 'b.json') }
      ]
    );
    assert.ok(result.results.every((entry) => entry.status === 'passed'));
    assert.ok(result.results.every((entry) => entry.applyReport?.success === true));
  } finally {
    engineModule.GatefileEngine = OriginalEngine;
    delete require.cache[pipelinePath];
  }
});

test('pipeline preserves authenticated recovery authority after a post-commit directory fsync failure', (t) => {
  const f = recoveryFixture(t, 'gatefile-pipeline-postcommit-fsync-');
  const target = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(target, 'before\n', 'utf8');
  const repoStat = fs.statSync(f.repoRoot);
  writeApprovedFilePlan(f, {
    id: 'update-managed',
    type: 'file',
    action: 'update',
    path: target,
    before: 'before\n',
    after: 'after\n'
  });

  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === repoStat.dev &&
      stat.ino === repoStat.ino &&
      fs.existsSync(target) &&
      fs.readFileSync(target, 'utf8') === 'after\n'
    ) {
      injected = true;
      const error = new Error('injected pipeline target-directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };

  let result;
  try {
    result = runPipeline(f.plansDir, {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome
    });
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(result.success, false);
  const failed = result.results[0];
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.message, /unknown error/i);
  assert.equal(failed.applyReport.success, false);
  assert.equal(failed.applyReport.results[0].mutationStatus, 'committed');
  assert.equal(fs.existsSync(failed.applyReport.receipt.path), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');

  const rollback = rollbackApply(
    failed.applyReport.rollbackContext.receiptId,
    failed.applyReport.rollbackContext
  );
  assert.equal(rollback.success, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
});

test('pipeline preserves authenticated recovery authority after plan-state cache finalization fails', (t) => {
  const f = recoveryFixture(t, 'gatefile-pipeline-plan-state-finalization-');
  const target = path.join(f.repoRoot, 'created.txt');
  writeApprovedFilePlan(f, {
    id: 'create-managed',
    type: 'file',
    action: 'create',
    path: target,
    after: 'created\n'
  });

  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (
      !injected &&
      typeof to === 'string' &&
      to.includes(`${path.sep}plans${path.sep}`)
    ) {
      injected = true;
      const error = new Error('injected pipeline plan-state cache publication failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };

  let result;
  try {
    result = runPipeline(f.plansDir, {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome
    });
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(result.success, false);
  const failed = result.results[0];
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.message, /unknown error/i);
  assert.match(failed.message, /receipt is durable.*dependency-state cache/i);
  assert.equal(failed.applyReport.success, false);
  assert.equal(failed.applyReport.results[0].success, true);
  assert.equal(failed.applyReport.results[0].mutationStatus, 'committed');
  assert.match(
    failed.applyReport.warnings.join('\n'),
    /receipt is durable.*dependency-state cache/i
  );
  assert.equal(fs.existsSync(failed.applyReport.receipt.path), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'created\n');

  const rollback = rollbackApply(
    failed.applyReport.rollbackContext.receiptId,
    failed.applyReport.rollbackContext
  );
  assert.equal(rollback.success, true);
  assert.equal(fs.existsSync(target), false);
});
