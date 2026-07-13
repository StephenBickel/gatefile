const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  approvePlan,
  createPlanFromDraft,
  runPipeline
} = require('../dist');

function fixture(t, prefix = 'gatefile-pipeline-contract-') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const plansDir = path.join(repoRoot, 'plans');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(plansDir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { repoRoot, plansDir, stateHome };
}

function draft(name, extra = {}) {
  return {
    source: 'pipeline-contract-test',
    summary: `Pipeline contract ${name}`,
    operations: [{
      id: `op_${name}`,
      type: 'file',
      action: 'create',
      path: `${name}.txt`,
      after: `${name}\n`
    }],
    preconditions: [],
    ...extra
  };
}

function writePlan(f, filename, plan) {
  fs.writeFileSync(path.join(f.plansDir, filename), `${JSON.stringify(plan, null, 2)}\n`);
}

function approvedPlan(f, name, extra) {
  const plan = createPlanFromDraft(draft(name, extra), { repoRoot: f.repoRoot });
  return approvePlan(plan, 'pipeline-reviewer', { repoRoot: f.repoRoot });
}

test('pipeline discovers plans in stable filename order and retains ready previews', (t) => {
  const f = fixture(t);
  const z = approvedPlan(f, 'z');
  const a = approvedPlan(f, 'a');
  writePlan(f, 'z-plan.json', z);
  writePlan(f, 'a-plan.json', a);

  const first = runPipeline(f.plansDir, {
    dryRun: true,
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });
  const second = runPipeline(f.plansDir, {
    dryRun: true,
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });

  assert.equal(first.success, true, JSON.stringify(first, null, 2));
  assert.deepEqual(first.order, [a.id, z.id]);
  assert.deepEqual(first.results.map((entry) => entry.file), ['a-plan.json', 'z-plan.json']);
  assert.ok(first.results.every((entry) => entry.previewReport.staticGate.passed));
  assert.deepEqual(
    second.results.map(({ planId, file, status, message }) => ({ planId, file, status, message })),
    first.results.map(({ planId, file, status, message }) => ({ planId, file, status, message }))
  );
});

test('pipeline reports malformed JSON before any plan mutation', (t) => {
  const f = fixture(t);
  const valid = approvedPlan(f, 'valid');
  writePlan(f, 'valid.json', valid);
  fs.writeFileSync(path.join(f.plansDir, 'broken.json'), '{"id":');

  const result = runPipeline(f.plansDir, {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.results, []);
  assert.equal(result.inputErrors[0].file, 'broken.json');
  assert.equal(result.inputErrors[0].code, 'invalid-json');
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'valid.txt')), false);
});

test('pipeline rejects malformed plan-like JSON but ignores unrelated valid JSON', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.plansDir, 'notes.json'), '{"owner":"release"}\n');
  fs.writeFileSync(path.join(f.plansDir, 'malformed-plan.json'), '{"id":"plan_bad","operations":[]}\n');

  const result = runPipeline(f.plansDir, { dryRun: true, repoRoot: f.repoRoot });

  assert.equal(result.success, false);
  assert.equal(result.inputErrors.length, 1);
  assert.equal(result.inputErrors[0].file, 'malformed-plan.json');
  assert.equal(result.inputErrors[0].code, 'invalid-plan');
  assert.match(result.inputErrors[0].message, /Invalid v2 plan file|version/i);
});

test('pipeline rejects every duplicate plan ID instead of overwriting one entry', (t) => {
  const f = fixture(t);
  const plan = approvedPlan(f, 'duplicate');
  writePlan(f, 'one.json', plan);
  writePlan(f, 'two.json', plan);

  const result = runPipeline(f.plansDir, { dryRun: true, repoRoot: f.repoRoot });

  assert.equal(result.success, false);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.results, []);
  assert.equal(result.inputErrors.length, 2);
  assert.ok(result.inputErrors.every((entry) => entry.code === 'duplicate-plan-id'));
  assert.ok(result.inputErrors.every((entry) => entry.message.includes(plan.id)));
});

test('pipeline returns a structured cycle error without throwing', (t) => {
  const f = fixture(t);
  const a = approvedPlan(f, 'cycle_a');
  const b = approvedPlan(f, 'cycle_b');
  a.dependsOn = [b.id];
  b.dependsOn = [a.id];
  writePlan(f, 'a.json', a);
  writePlan(f, 'b.json', b);

  const result = runPipeline(f.plansDir, { dryRun: true, repoRoot: f.repoRoot });

  assert.equal(result.success, false);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.results, []);
  assert.ok(result.inputErrors.some((entry) => entry.code === 'dependency-cycle'));
  assert.match(result.inputErrors.map((entry) => entry.message).join('\n'), /Circular dependency/i);
});

test('pipeline dry-run fails a static gate but retains the complete preview', (t) => {
  const f = fixture(t);
  const pending = createPlanFromDraft(draft('pending'), { repoRoot: f.repoRoot });
  writePlan(f, 'pending.json', pending);

  const result = runPipeline(f.plansDir, {
    dryRun: true,
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });

  assert.equal(result.success, false);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].message, /static gate/i);
  assert.equal(result.results[0].previewReport.success, true);
  assert.deepEqual(result.results[0].previewReport.staticGate, {
    passed: false,
    verificationReady: false,
    dependenciesSatisfied: true,
    operationsAllowed: true,
    preconditionsChecked: false
  });
});
