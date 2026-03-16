const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPlanFromDraft, approvePlan, verifyPlan, previewPlan, applyPlan } = require('../dist');

function makeSafeDraft(root) {
  const allowedRoot = path.join(root, 'workspace');
  const createdFile = path.join(allowedRoot, 'approved.txt');
  const commandLog = path.join(allowedRoot, 'command.log');

  return {
    allowedRoot,
    createdFile,
    commandLog,
    draft: {
      source: 'public-launch-demo-test',
      summary: 'Safe approved apply path',
      operations: [
        {
          id: 'op_file_create',
          type: 'file',
          action: 'create',
          path: createdFile,
          after: 'approved apply executed\n'
        },
        {
          id: 'op_cmd_marker',
          type: 'command',
          command: `${process.execPath} -e 'require("node:fs").appendFileSync(${JSON.stringify(
            commandLog
          )}, "safe command executed\\\\n", "utf8")'`,
          allowFailure: false
        }
      ],
      preconditions: [],
      execution: {
        commandPolicy: {
          mode: 'allow',
          patterns: [process.execPath]
        },
        filePolicy: {
          allowedRoots: [allowedRoot]
        }
      }
    }
  };
}

function makeUnsafeDraft(root, allowedRoot) {
  return {
    source: 'public-launch-demo-test',
    summary: 'Unsafe denied apply path',
    operations: [
      {
        id: 'op_file_denied',
        type: 'file',
        action: 'create',
        path: path.join(root, '..', 'outside-denied.txt'),
        after: 'this should never be written\n'
      }
    ],
    preconditions: [],
    execution: {
      filePolicy: {
        allowedRoots: [allowedRoot]
      }
    }
  };
}

test('canonical public-launch flow: verify -> approve -> dry-run -> unsafe denied -> safe apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planfile-public-launch-'));

  try {
    const safe = makeSafeDraft(root);
    const safePlanPending = createPlanFromDraft(safe.draft);

    const pendingVerification = verifyPlan(safePlanPending);
    assert.equal(pendingVerification.status, 'not-ready');
    assert.equal(pendingVerification.approvalStatus, 'pending');
    assert.equal(pendingVerification.readyToApplyFromIntegrityApproval, false);

    const safePlanApproved = approvePlan(safePlanPending, 'demo-reviewer');
    const approvedVerification = verifyPlan(safePlanApproved);
    assert.equal(approvedVerification.status, 'ready');
    assert.equal(approvedVerification.readyToApplyFromIntegrityApproval, true);

    const dryRun = previewPlan(safePlanApproved);
    assert.equal(dryRun.success, true);
    assert.equal(dryRun.preconditionsChecked, false);
    assert.equal(dryRun.verification.status, 'ready');
    assert.equal(fs.existsSync(safe.createdFile), false);
    assert.equal(fs.existsSync(safe.commandLog), false);

    const unsafePlanApproved = approvePlan(
      createPlanFromDraft(makeUnsafeDraft(root, safe.allowedRoot)),
      'demo-reviewer'
    );

    const unsafeVerification = verifyPlan(unsafePlanApproved);
    assert.equal(unsafeVerification.status, 'ready');

    const unsafeApply = applyPlan(unsafePlanApproved);
    assert.equal(unsafeApply.success, false);
    assert.equal(unsafeApply.results.length, 1);
    assert.match(unsafeApply.results[0].message, /file path denied by policy/);

    const safeApply = applyPlan(safePlanApproved);
    assert.equal(safeApply.success, true);
    assert.equal(fs.existsSync(safe.createdFile), true);
    assert.equal(fs.readFileSync(safe.createdFile, 'utf8'), 'approved apply executed\n');
    assert.equal(fs.existsSync(safe.commandLog), true);
    assert.match(fs.readFileSync(safe.commandLog, 'utf8'), /safe command executed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
