const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { applyPlan, createPlanFromDraft, approvePlan, previewPlan } = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function makePlanDraft(tempRoot) {
  const createPath = path.join(tempRoot, 'create.txt');
  const markerPath = path.join(tempRoot, 'marker.txt');

  return {
    draft: {
      source: 'test-agent',
      summary: 'Preview apply behavior test',
      operations: [
        {
          id: 'op_create',
          type: 'file',
          action: 'create',
          path: createPath,
          after: 'hello world\n'
        },
        {
          id: 'op_update',
          type: 'file',
          action: 'update',
          path: path.join(tempRoot, 'update.txt'),
          before: 'old\n',
          after: 'new value\n'
        },
        {
          id: 'op_delete',
          type: 'file',
          action: 'delete',
          path: path.join(tempRoot, 'delete.txt'),
          before: 'remove me\n'
        },
        {
          id: 'op_command',
          type: 'command',
          command: `${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran', 'utf8')"`
        }
      ],
      preconditions: [{ kind: 'git_clean' }],
      execution: {
        filePolicy: {
          allowedRoots: [tempRoot]
        }
      }
    },
    createPath,
    markerPath
  };
}

function makePendingPlan(tempRoot) {
  const { draft, createPath, markerPath } = makePlanDraft(tempRoot);
  return {
    plan: createPlanFromDraft(draft),
    createPath,
    markerPath
  };
}

function makeApprovedPlan(tempRoot) {
  const { draft, createPath, markerPath } = makePlanDraft(tempRoot);
  return {
    plan: approvePlan(createPlanFromDraft(draft), 'ci-user'),
    createPath,
    markerPath
  };
}

function makeTamperedApprovedPlan(tempRoot) {
  const { plan, createPath, markerPath } = makeApprovedPlan(tempRoot);
  return {
    plan: {
      ...plan,
      summary: `${plan.summary} (tampered)`
    },
    createPath,
    markerPath
  };
}

function runCli(t, args) {
  try {
    return execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('subprocess execution is blocked in this environment');
      return null;
    }
    throw error;
  }
}

function assertNoSideEffects(createPath, markerPath) {
  assert.equal(fs.existsSync(createPath), false);
  assert.equal(fs.existsSync(markerPath), false);
}

function assertDryRunVerification(report, expected) {
  assert.equal(report.verification.status, expected.status);
  assert.equal(report.verification.approvalStatus, expected.approvalStatus);
  assert.equal(
    report.verification.readyToApplyFromIntegrityApproval,
    expected.readyToApplyFromIntegrityApproval
  );
  for (const blocker of expected.blockers) {
    assert.match(report.verification.blockers.join('\n'), new RegExp(blocker));
  }
}

function assertRecoveryShape(recovery) {
  assert.equal(recovery.transactionalRollback, false);
  assert.equal(Array.isArray(recovery.steps), true);
  assert.equal(Array.isArray(recovery.notes), true);
}

function commandWriteFile(filePath, value) {
  return `${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(
    filePath
  )}, ${JSON.stringify(value)}, "utf8")'`;
}

function commandSleep(ms) {
  return `${process.execPath} -e 'setTimeout(() => {}, ${ms})'`;
}

test('previewPlan shows file and command actions without executing side effects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-'));
  try {
    const { plan, createPath, markerPath } = makeApprovedPlan(root);
    const report = previewPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.preconditionsChecked, false);
    assert.equal(report.results.length, 4);
    assert.match(report.results[0].message, /would create/);
    assert.match(report.results[0].details, /path safety: allowed/);
    assert.match(report.results[1].message, /would update/);
    assert.match(report.results[2].message, /would delete/);
    assert.match(report.results[3].message, /would run command/);
    assertRecoveryShape(report.recovery);
    assert.deepEqual(report.recovery.attemptedOperationIds, []);
    assert.equal(report.recovery.pendingOperationIds.length, 4);
    assert.equal(report.recovery.affectedPaths.length, 3);
    assertDryRunVerification(report, {
      status: 'ready',
      approvalStatus: 'approved',
      readyToApplyFromIntegrityApproval: true,
      blockers: []
    });
    assert.equal(report.verification.signerTrustStatus, 'not-configured');
    assertNoSideEffects(createPath, markerPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previewPlan reports untrusted signer when trust policy is configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-trust-'));
  try {
    const { draft } = makePlanDraft(root);
    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = previewPlan(plan, {
      config: {
        signers: {
          trustedKeyIds: ['trusted-signer-1']
        }
      }
    });

    assert.equal(report.verification.status, 'not-ready');
    assert.equal(report.verification.signerTrustStatus, 'unsigned');
    assert.match(report.verification.blockers.join('\n'), /approval is unsigned/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan refuses unsigned approvals when signer trust policy is configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-trust-'));
  try {
    const { draft } = makePlanDraft(root);
    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');

    assert.throws(
      () =>
        applyPlan(plan, {
          config: {
            signers: {
              trustedKeyIds: ['trusted-signer-1']
            }
          }
        }),
      /Signer trust policy is configured/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previewPlan on pending plans is allowed and reports not-ready verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-pending-'));
  try {
    const { plan, createPath, markerPath } = makePendingPlan(root);
    const report = previewPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.results.length, 4);
    assertDryRunVerification(report, {
      status: 'not-ready',
      approvalStatus: 'pending',
      readyToApplyFromIntegrityApproval: false,
      blockers: ['Plan is not approved']
    });
    assertNoSideEffects(createPath, markerPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previewPlan on tampered approved plans is allowed and reports mismatches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-tampered-'));
  try {
    const { plan, createPath, markerPath } = makeTamperedApprovedPlan(root);
    const report = previewPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.results.length, 4);
    assertDryRunVerification(report, {
      status: 'not-ready',
      approvalStatus: 'approved',
      readyToApplyFromIntegrityApproval: false,
      blockers: [
        'Recorded integrity hash does not match current plan hash',
        'Approval is not bound to the current plan hash'
      ]
    });
    assertNoSideEffects(createPath, markerPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply-plan --dry-run works without --yes and performs no writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-cli-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { plan, createPath, markerPath } = makeApprovedPlan(root);
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  const output = runCli(t, ['apply-plan', planPath, '--dry-run']);
  if (!output) return;

  const report = JSON.parse(output);
  assert.equal(report.success, true);
  assert.equal(report.preconditionsChecked, false);
  assertRecoveryShape(report.recovery);
  assertDryRunVerification(report, {
    status: 'ready',
    approvalStatus: 'approved',
    readyToApplyFromIntegrityApproval: true,
    blockers: []
  });
  assert.match(report.results[0].message, /would create/);
  assert.match(report.results[0].details, /path safety: allowed/);
  assertNoSideEffects(createPath, markerPath);
});

test('apply-plan --dry-run works on unapproved plans and reports not-ready verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-cli-pending-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { plan, createPath, markerPath } = makePendingPlan(root);
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  const output = runCli(t, ['apply-plan', planPath, '--dry-run']);
  if (!output) return;

  const report = JSON.parse(output);
  assert.equal(report.success, true);
  assertRecoveryShape(report.recovery);
  assertDryRunVerification(report, {
    status: 'not-ready',
    approvalStatus: 'pending',
    readyToApplyFromIntegrityApproval: false,
    blockers: ['Plan is not approved']
  });
  assertNoSideEffects(createPath, markerPath);
});

test('applyPlan runs allowed command operations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-command-allow-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const markerPath = path.join(root, 'allowed.txt');
  const draft = {
    source: 'test-agent',
    summary: 'Allowed command apply test',
    operations: [
      {
        id: 'op_command_allow',
        type: 'command',
        command: commandWriteFile(markerPath, 'allowed')
      }
    ],
    preconditions: [],
    execution: {
      commandPolicy: {
        mode: 'allow',
        patterns: [`${process.execPath} -e`]
      }
    }
  };

  const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
  const report = applyPlan(plan);
  if (!report.success && /EPERM/.test(report.results[0]?.message ?? '')) {
    t.skip('subprocess execution is blocked in this environment');
    return;
  }

  assert.equal(report.success, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].success, true);
  assert.match(report.results[0].message, /command ok/);
  assertRecoveryShape(report.recovery);
  assert.deepEqual(report.recovery.pendingOperationIds, []);
  assert.equal(report.recovery.failedOperationId, undefined);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'allowed');
});

test('applyPlan denies commands that do not match allow policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-command-deny-'));
  try {
    const markerPath = path.join(root, 'denied.txt');
    const draft = {
      source: 'test-agent',
      summary: 'Denied command apply test',
      operations: [
        {
          id: 'op_command_deny',
          type: 'command',
          command: commandWriteFile(markerPath, 'denied')
        }
      ],
      preconditions: [],
      execution: {
        commandPolicy: {
          mode: 'allow',
          patterns: ['npm test']
        }
      }
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = applyPlan(plan);

    assert.equal(report.success, false);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].success, false);
    assert.match(report.results[0].message, /command denied by policy \(allow mode\)/);
    assertRecoveryShape(report.recovery);
    assert.equal(report.recovery.failedOperationId, 'op_command_deny');
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan reports command timeout failures', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-command-timeout-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const draft = {
    source: 'test-agent',
    summary: 'Timeout command apply test',
    operations: [
      {
        id: 'op_command_timeout',
        type: 'command',
        command: commandSleep(200),
        timeoutMs: 25
      }
    ],
    preconditions: [],
    execution: {
      filePolicy: {
        allowedRoots: [root]
      }
    }
  };

  const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
  const report = applyPlan(plan);
  if (!report.success && /EPERM/.test(report.results[0]?.message ?? '')) {
    t.skip('subprocess execution is blocked in this environment');
    return;
  }

  assert.equal(report.success, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].success, false);
  assert.match(report.results[0].message, /timed out after 25ms/);
  assertRecoveryShape(report.recovery);
  assert.equal(report.recovery.failedOperationId, 'op_command_timeout');
});

test('applyPlan respects allowFailure for timed out commands', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-command-timeout-allow-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const createdPath = path.join(root, 'after-timeout.txt');
  const draft = {
    source: 'test-agent',
    summary: 'Timeout allowFailure apply test',
    operations: [
      {
        id: 'op_command_timeout_allowed',
        type: 'command',
        command: commandSleep(200),
        timeoutMs: 25,
        allowFailure: true
      },
      {
        id: 'op_file_create_after_timeout',
        type: 'file',
        action: 'create',
        path: createdPath,
        after: 'continued\n'
      }
    ],
    preconditions: [],
    execution: {
      filePolicy: {
        allowedRoots: [root]
      }
    }
  };

  const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
  const report = applyPlan(plan);
  if (!report.success && /EPERM/.test(report.results[0]?.message ?? '')) {
    t.skip('subprocess execution is blocked in this environment');
    return;
  }

  assert.equal(report.success, true);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].success, true);
  assert.match(report.results[0].message, /timed out after 25ms/);
  assert.match(report.results[0].message, /allowFailure=true/);
  assert.equal(report.results[1].success, true);
  assertRecoveryShape(report.recovery);
  assert.deepEqual(report.recovery.pendingOperationIds, []);
  assert.equal(fs.readFileSync(createdPath, 'utf8'), 'continued\n');
});

test('previewPlan marks file operations denied when path is outside default workspace root', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-denied-'));
  try {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    const draft = {
      source: 'test-agent',
      summary: 'Preview denied path test',
      operations: [
        {
          id: 'op_outside_preview',
          type: 'file',
          action: 'create',
          path: outsidePath,
          after: 'x\n'
        }
      ],
      preconditions: []
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = previewPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.results.length, 1);
    assert.match(report.results[0].message, /\[DENIED by file policy\]/);
    assert.match(report.results[0].details, /path safety: denied/);
    assert.match(report.results[0].details, /allowedRoots:/);
    assertRecoveryShape(report.recovery);
    assert.equal(fs.existsSync(outsidePath), false);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('applyPlan allows file writes inside default workspace root', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.gatefile-apply-in-root-'));
  try {
    const targetPath = path.join(root, 'allowed.txt');
    const draft = {
      source: 'test-agent',
      summary: 'In-root file write test',
      operations: [
        {
          id: 'op_file_in_root',
          type: 'file',
          action: 'create',
          path: targetPath,
          after: 'ok\n'
        }
      ],
      preconditions: []
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = applyPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.results[0].success, true);
    assertRecoveryShape(report.recovery);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'ok\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan denies file writes outside default workspace root', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-outside-root-'));
  try {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    const draft = {
      source: 'test-agent',
      summary: 'Outside-root file write denied test',
      operations: [
        {
          id: 'op_file_outside_root',
          type: 'file',
          action: 'create',
          path: outsidePath,
          after: 'blocked\n'
        }
      ],
      preconditions: []
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = applyPlan(plan);

    assert.equal(report.success, false);
    assert.equal(report.results[0].success, false);
    assert.match(report.results[0].message, /file path denied by policy/);
    assertRecoveryShape(report.recovery);
    assert.equal(fs.existsSync(outsidePath), false);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('applyPlan denies traversal-style paths that resolve outside default workspace root', () => {
  const traversalPath = '../gatefile-traversal-denied.txt';
  const resolvedTraversalPath = path.resolve(process.cwd(), traversalPath);
  if (fs.existsSync(resolvedTraversalPath)) {
    fs.rmSync(resolvedTraversalPath, { force: true });
  }

  try {
    const draft = {
      source: 'test-agent',
      summary: 'Traversal denied test',
      operations: [
        {
          id: 'op_file_traversal',
          type: 'file',
          action: 'create',
          path: traversalPath,
          after: 'blocked\n'
        }
      ],
      preconditions: []
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = applyPlan(plan);

    assert.equal(report.success, false);
    assert.equal(report.results[0].success, false);
    assert.match(report.results[0].message, /file path denied by policy/);
    assertRecoveryShape(report.recovery);
    assert.equal(fs.existsSync(resolvedTraversalPath), false);
  } finally {
    if (fs.existsSync(resolvedTraversalPath)) {
      fs.rmSync(resolvedTraversalPath, { force: true });
    }
  }
});

test('applyPlan allows explicit filePolicy allowedRoots override', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-override-root-'));
  try {
    const outsidePath = path.join(outsideRoot, 'override-allowed.txt');
    const draft = {
      source: 'test-agent',
      summary: 'Allowed roots override test',
      operations: [
        {
          id: 'op_file_override',
          type: 'file',
          action: 'create',
          path: outsidePath,
          after: 'allowed\n'
        }
      ],
      preconditions: [],
      execution: {
        filePolicy: {
          allowedRoots: [outsideRoot]
        }
      }
    };

    const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
    const report = applyPlan(plan);

    assert.equal(report.success, true);
    assert.equal(report.results[0].success, true);
    assertRecoveryShape(report.recovery);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'allowed\n');
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('apply-plan --dry-run --human prints concise preview summary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-preview-human-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { plan } = makeApprovedPlan(root);
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  const output = runCli(t, ['apply-plan', planPath, '--dry-run', '--human']);
  if (!output) return;

  assert.match(output, /Mode: dry-run preview/);
  assert.match(output, /Rollback Guidance:/);
  assert.equal(output.trimStart().startsWith('{'), false);
});

test('apply-plan --yes --human prints concise apply summary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-apply-human-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const targetPath = path.join(root, 'human.txt');
  const draft = {
    source: 'test-agent',
    summary: 'Human apply output test',
    operations: [
      {
        id: 'op_file_human',
        type: 'file',
        action: 'create',
        path: targetPath,
        after: 'ok\n'
      }
    ],
    preconditions: [],
    execution: {
      filePolicy: {
        allowedRoots: [root]
      }
    }
  };
  const plan = approvePlan(createPlanFromDraft(draft), 'ci-user');
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  const output = runCli(t, ['apply-plan', planPath, '--yes', '--human']);
  if (!output) return;

  assert.match(output, /Mode: apply/);
  assert.match(output, /Result: success/);
  assert.match(output, /Rollback Guidance:/);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'ok\n');
});
