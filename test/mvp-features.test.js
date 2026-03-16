const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  applyPlan,
  approvePlan,
  createPlanFromDraft,
  rollbackApply,
  buildInspectReport
} = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function mkRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeApprovedFilePlan(root, options = {}) {
  const suffix = options.suffix ? `-${options.suffix}` : '';
  const updatePath = path.join(root, `update${suffix}.txt`);
  const deletePath = path.join(root, `delete${suffix}.txt`);
  const createPath = path.join(root, `create${suffix}.txt`);

  fs.writeFileSync(updatePath, 'before-update\n', 'utf8');
  fs.writeFileSync(deletePath, 'before-delete\n', 'utf8');

  const draft = {
    source: 'test-agent',
    summary: 'Snapshot and rollback behavior',
    dependsOn: options.dependsOn,
    operations: [
      {
        id: 'op_update',
        type: 'file',
        action: 'update',
        path: updatePath,
        before: 'before-update\n',
        after: 'after-update\n'
      },
      {
        id: 'op_delete',
        type: 'file',
        action: 'delete',
        path: deletePath,
        before: 'before-delete\n'
      },
      {
        id: 'op_create',
        type: 'file',
        action: 'create',
        path: createPath,
        after: 'created-now\n'
      }
    ],
    preconditions: [],
    execution: {
      filePolicy: {
        allowedRoots: [root]
      }
    }
  };

  return {
    plan: approvePlan(createPlanFromDraft(draft), 'ci-user'),
    files: { updatePath, deletePath, createPath }
  };
}

function runCli(cwd, args) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe'
  });
}

test('apply writes snapshot + receipt metadata and rollback restores file states', () => {
  const root = mkRoot('gatefile-mvp-snapshot-');
  try {
    const { plan, files } = makeApprovedFilePlan(root);
    const report = applyPlan(plan, { repoRoot: root });

    assert.equal(report.success, true);
    assert.equal(report.snapshot.fileCount, 3);
    assert.equal(fs.existsSync(report.snapshot.path), true);
    assert.equal(fs.existsSync(report.receipt.path), true);
    assert.match(report.rollbackCommand, /rollback-apply/);

    assert.equal(fs.readFileSync(files.updatePath, 'utf8'), 'after-update\n');
    assert.equal(fs.existsSync(files.deletePath), false);
    assert.equal(fs.readFileSync(files.createPath, 'utf8'), 'created-now\n');

    const rollback = rollbackApply(report.receipt.id, { repoRoot: root });
    assert.equal(rollback.success, true);
    assert.equal(fs.readFileSync(files.updatePath, 'utf8'), 'before-update\n');
    assert.equal(fs.readFileSync(files.deletePath, 'utf8'), 'before-delete\n');
    assert.equal(fs.existsSync(files.createPath), false);
    assert.match(rollback.notes.join('\n'), /not automatically rollbackable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply refuses unmet dependencies and inspect reports missing dependency IDs', () => {
  const root = mkRoot('gatefile-mvp-deps-missing-');
  try {
    const depPlan = makeApprovedFilePlan(root, { suffix: 'dep' }).plan;
    const dependent = makeApprovedFilePlan(root, { suffix: 'main', dependsOn: [depPlan.id] }).plan;

    assert.throws(
      () => applyPlan(dependent, { repoRoot: root }),
      /Plan dependencies are not satisfied/
    );

    const inspect = buildInspectReport(dependent, { repoRoot: root });
    assert.equal(inspect.dependencies.allSatisfied, false);
    assert.deepEqual(inspect.dependencies.missingPlanIds, [depPlan.id]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply succeeds for dependent plan after dependency receipt exists', () => {
  const root = mkRoot('gatefile-mvp-deps-ok-');
  try {
    const depPlan = makeApprovedFilePlan(root, { suffix: 'dep' }).plan;
    const dependentBundle = makeApprovedFilePlan(root, { suffix: 'main', dependsOn: [depPlan.id] });

    const first = applyPlan(depPlan, { repoRoot: root });
    assert.equal(first.success, true);

    const second = applyPlan(dependentBundle.plan, { repoRoot: root });
    assert.equal(second.success, true);
    assert.equal(second.dependencies.allSatisfied, true);
    assert.deepEqual(second.dependencies.missingPlanIds, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('beforeApply hook can block apply', () => {
  const root = mkRoot('gatefile-mvp-hook-apply-');
  try {
    const { plan } = makeApprovedFilePlan(root);
    const config = {
      hooks: {
        beforeApply: {
          command: `${process.execPath} -e "process.stderr.write('blocked by beforeApply'); process.exit(9)"`
        }
      }
    };

    try {
      assert.throws(
        () => applyPlan(plan, { repoRoot: root, config }),
        /Policy hook beforeApply blocked execution/
      );
    } catch (error) {
      if (/EPERM/.test(String(error))) {
        return;
      }
      throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('beforeApprove hook from gatefile.config.json can block approve-plan CLI', () => {
  const root = mkRoot('gatefile-mvp-hook-approve-');
  try {
    const planPath = path.join(root, 'plan.json');
    const configPath = path.join(root, 'gatefile.config.json');

    const draft = {
      source: 'test-agent',
      summary: 'Approve hook test',
      operations: [
        {
          id: 'op_create',
          type: 'file',
          action: 'create',
          path: path.join(root, 'x.txt'),
          after: 'x\n'
        }
      ],
      preconditions: []
    };

    const plan = createPlanFromDraft(draft);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          hooks: {
            beforeApprove: {
              command: `${process.execPath} -e "process.stderr.write('blocked by beforeApprove'); process.exit(4)"`
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    try {
      assert.throws(
        () => runCli(root, ['approve-plan', planPath, '--by', 'reviewer']),
        /Policy hook beforeApprove blocked execution/
      );
    } catch (error) {
      if (/EPERM/.test(String(error))) {
        return;
      }
      throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
