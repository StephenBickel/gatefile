const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gatefile = require('../dist');
const { approvePlan, createPlanFromDraft } = gatefile;

const lifecycleExports = [
  'applyPlan',
  'approvePlan',
  'buildInspectReport',
  'createPlanFromDraft',
  'previewPlan',
  'rollbackApply',
  'verifyPlan'
];

test('package root explicitly binds supported lifecycle exports to engine-api', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const engineApiExport = source.match(
    /export\s*\{([^{}]+)\}\s*from\s*["']\.\/engine-api["'];/
  );

  assert.ok(engineApiExport, 'src/index.ts must explicitly export lifecycle bindings from ./engine-api');
  const exportedNames = engineApiExport[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(exportedNames, lifecycleExports);
  assert.equal(
    'validatePlanForApproval' in gatefile,
    false,
    'approval prevalidation must remain an internal engine/planner contract'
  );
});

test('package-root approvePlan enforces beforeApprove policy from canonical cwd', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-engine-api-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);

  fs.writeFileSync(
    path.join(root, 'gatefile.config.json'),
    JSON.stringify({
      hooks: {
        beforeApprove: {
          command: `"${process.execPath}" -e "process.exit(4)"`
        }
      }
    }),
    'utf8'
  );

  const plan = createPlanFromDraft(
    {
      source: 'engine-api-test',
      summary: 'Enforce package-root approval policy',
      operations: [
        {
          id: 'op_engine_api',
          type: 'file',
          action: 'create',
          path: 'engine-api.txt',
          after: 'engine-backed root API\n'
        }
      ],
      preconditions: []
    },
    { repoRoot: root }
  );

  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () => approvePlan(plan, 'reviewer'),
      /Policy hook beforeApprove blocked execution/
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('package-root approvePlan never adopts repository authority asserted by the plan', (t) => {
  const repoA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-engine-api-a-')));
  const repoB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-engine-api-b-')));
  t.after(() => {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });
  const plan = createPlanFromDraft({
    source: 'engine-api-test',
    summary: 'Reject foreign plan authority',
    operations: [{
      id: 'op_foreign_context',
      type: 'file',
      action: 'create',
      path: 'foreign.txt',
      after: 'never implicitly approved\n'
    }],
    preconditions: []
  }, { repoRoot: repoA });
  const before = JSON.stringify(plan);
  const originalCwd = process.cwd();

  process.chdir(repoB);
  try {
    assert.throws(
      () => approvePlan(plan, 'reviewer'),
      /repository context.*does not match engine repository context/i
    );
    assert.equal(JSON.stringify(plan), before);
  } finally {
    process.chdir(originalCwd);
  }

  const explicitlyBound = approvePlan(plan, 'reviewer', { repoRoot: repoA });
  assert.equal(explicitlyBound.approval.status, 'approved');
});
