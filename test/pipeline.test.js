const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPlanFromDraft, approvePlan, runPipeline, formatPipelineSummary } = require('../dist');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pipeline-'));
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

test('run-pipeline dry-run previews all plans', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'));

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.success, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(r => r.status === 'passed'));
});

test('run-pipeline respects dependency order via dependsOn', () => {
  const dir = tmpDir();
  const planA = writePlan(dir, 'a.json', baseDraft('a'));
  writePlan(dir, 'b.json', baseDraft('b'), { dependsOn: [planA.id] });

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.success, true);
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

test('formatPipelineSummary produces readable output', () => {
  const dir = tmpDir();
  writePlan(dir, 'a.json', baseDraft('a'));
  const result = runPipeline(dir, { dryRun: true });
  const summary = formatPipelineSummary(result);
  assert.ok(summary.includes('Pipeline Summary'));
  assert.ok(summary.includes('[PASS]'));
  assert.ok(summary.includes('1 passed'));
});

test('run-pipeline skips non-plan JSON files', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{"key": "value"}', 'utf-8');
  writePlan(dir, 'plan.json', baseDraft('real'));

  const result = runPipeline(dir, { dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.success, true);
});
