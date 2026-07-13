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
  applyPlanFile,
  rollbackApplyFile,
  generateApprovalAttestationKeyPair
} = require('../dist');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-sdk-'));
}

function sdkFileFixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  const planPath = path.join(repoRoot, 'plan.json');
  const targetPath = path.join(repoRoot, 'managed.txt');
  fs.mkdirSync(repoRoot);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { repoRoot, stateHome, planPath, targetPath };
}

function sdkFileDraft(targetPath, after = 'created by sdk policy test\n') {
  return {
    source: 'sdk-policy-test',
    summary: 'SDK policy test plan',
    operations: [
      {
        id: 'op_sdk_policy',
        type: 'file',
        action: 'create',
        path: targetPath,
        after
      }
    ],
    preconditions: []
  };
}

function blockingPolicyCommand(exitCode) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${exitCode})`)}`;
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

test('inspectPlan preserves malformed-plan error ordering without dereferencing context', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'malformed-plan.json');
  fs.writeFileSync(planPath, '{"id":"malformed","operations":[]}\n', 'utf8');

  await assert.rejects(
    inspectPlan(planPath),
    (error) => {
      assert.equal(error.name, 'TypeError');
      assert.match(error.message, /reading 'status'/);
      assert.doesNotMatch(error.message, /reading 'repositoryId'/);
      return true;
    }
  );
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

test('approvePlanFile validates malformed input before reading repository context', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'malformed-plan.json');
  fs.writeFileSync(planPath, '{"id":"malformed","operations":[]}\n', 'utf8');

  await assert.rejects(
    approvePlanFile(planPath, { approvedBy: 'sdk-reviewer' }),
    (error) => {
      assert.equal(error.name, 'GatefileValidationError');
      assert.match(error.message, /Invalid v2 plan file/);
      assert.match(error.message, /context: must be an object/);
      assert.doesNotMatch(error.message, /Cannot read properties/);
      return true;
    }
  );
});

test('approvePlanFile keeps the plan repository ID when repoRoot only selects policy context', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-custom-repository-id-');
  await createPlan(sdkFileDraft(f.targetPath), {
    outPath: f.planPath,
    repoRoot: f.repoRoot,
    repositoryId: 'repo:sdk-custom'
  });

  const approved = await approvePlanFile(f.planPath, {
    approvedBy: 'custom-repository-reviewer',
    repoRoot: f.repoRoot
  });

  assert.equal(approved.plan.context.repositoryId, 'repo:sdk-custom');
  assert.equal(approved.plan.approval.status, 'approved');
});

test('approvePlanFile forwards signing and signer-policy context', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-signing-');
  const keys = generateApprovalAttestationKeyPair();
  await createPlan(sdkFileDraft(f.targetPath), {
    outPath: f.planPath,
    repoRoot: f.repoRoot
  });

  const approved = await approvePlanFile(f.planPath, {
    approvedBy: 'signed-sdk-reviewer',
    repoRoot: f.repoRoot,
    signingPrivateKeyPem: keys.privateKeyPem,
    signingKeyId: keys.keyId
  });
  const verification = await verifyPlanFile(f.planPath, {
    repoRoot: f.repoRoot,
    config: { signers: { trustedKeyIds: [keys.keyId] } }
  });

  assert.equal(approved.plan.approval.attestation.keyId, keys.keyId);
  assert.equal(verification.approvalIdentity, 'signed');
  assert.equal(verification.signerTrust.status, 'trusted');
  assert.equal(verification.status, 'ready', verification.blockers.join('; '));
});

test('approvePlanFile preserves exact plan bytes when beforeApprove blocks', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-before-approve-');
  await createPlan(sdkFileDraft(f.targetPath), {
    outPath: f.planPath,
    repoRoot: f.repoRoot
  });
  const originalBytes = fs.readFileSync(f.planPath);

  await assert.rejects(
    approvePlanFile(f.planPath, {
      approvedBy: 'blocked-sdk-reviewer',
      repoRoot: f.repoRoot,
      config: {
        hooks: {
          beforeApprove: { command: blockingPolicyCommand(31) }
        }
      }
    }),
    (error) => {
      assert.match(error.message, /Policy hook beforeApprove blocked execution/);
      return true;
    }
  );

  assert.deepEqual(fs.readFileSync(f.planPath), originalBytes);
  assert.equal(JSON.parse(originalBytes).approval.status, 'pending');
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

test('applyPlanFile rejects an unsigned approval under trusted-signer policy without mutation', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-signer-policy-');
  await createPlan(sdkFileDraft(f.targetPath), {
    outPath: f.planPath,
    repoRoot: f.repoRoot
  });
  await approvePlanFile(f.planPath, {
    approvedBy: 'unsigned-sdk-reviewer',
    repoRoot: f.repoRoot
  });

  await assert.rejects(
    applyPlanFile(f.planPath, {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      config: { signers: { trustedKeyIds: ['required-sdk-signer'] } }
    }),
    (error) => {
      assert.match(error.message, /Plan failed verification/);
      assert.match(error.message, /approval is unsigned/i);
      return true;
    }
  );

  assert.equal(fs.existsSync(f.targetPath), false);
});

test('applyPlanFile reports beforeApply denial without target mutation', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-before-apply-');
  await createPlan(sdkFileDraft(f.targetPath), {
    outPath: f.planPath,
    repoRoot: f.repoRoot
  });
  await approvePlanFile(f.planPath, {
    approvedBy: 'sdk-policy-reviewer',
    repoRoot: f.repoRoot
  });

  await assert.rejects(
    applyPlanFile(f.planPath, {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      config: {
        hooks: {
          beforeApply: { command: blockingPolicyCommand(32) }
        }
      }
    }),
    (error) => {
      assert.match(error.message, /Policy hook beforeApply blocked execution/);
      return true;
    }
  );

  assert.equal(fs.existsSync(f.targetPath), false);
});

test('rollbackApplyFile restores an SDK apply using the report context', async (t) => {
  const f = sdkFileFixture(t, 'gatefile-sdk-rollback-');
  await createPlan(sdkFileDraft(f.targetPath, 'rollback this SDK write\n'), {
    outPath: f.planPath,
    repoRoot: f.repoRoot
  });
  await approvePlanFile(f.planPath, {
    approvedBy: 'sdk-rollback-reviewer',
    repoRoot: f.repoRoot
  });

  const applied = await applyPlanFile(f.planPath, {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });
  assert.equal(applied.success, true, JSON.stringify(applied, null, 2));
  assert.equal(fs.readFileSync(f.targetPath, 'utf8'), 'rollback this SDK write\n');

  const rollback = await rollbackApplyFile(
    applied.rollbackContext.receiptId,
    applied.rollbackContext
  );

  assert.equal(rollback.success, true, JSON.stringify(rollback, null, 2));
  assert.equal(rollback.receiptId, applied.receipt.id);
  assert.equal(rollback.fileResults.length, 1);
  assert.equal(rollback.fileResults[0].restored, true);
  assert.equal(rollback.fileResults[0].action, 'deleted');
  assert.equal(fs.existsSync(f.targetPath), false);
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
