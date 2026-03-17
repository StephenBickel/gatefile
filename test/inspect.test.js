const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createPlanFromDraft, approvePlan, buildInspectReport, formatInspectSummary } = require('../dist');
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function makeDraft() {
  return {
    source: 'test-agent',
    summary: 'Inspect behavior test',
    operations: [
      {
        id: 'op_file_1',
        type: 'file',
        action: 'create',
        path: 'tmp/demo.txt',
        after: 'hello'
      }
    ],
    preconditions: [{ kind: 'git_clean' }]
  };
}

function writePlan(t, plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-inspect-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
  return planPath;
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

test('buildInspectReport returns machine-readable inspect data', () => {
  const plan = createPlanFromDraft(makeDraft());
  const report = buildInspectReport(plan);

  assert.equal(report.id, plan.id);
  assert.equal(report.summary, plan.summary);
  assert.equal(report.operationCount, plan.operations.length);
  assert.equal(typeof report.integrity.currentPlanHash, 'string');
  assert.equal(report.integrity.integrityMatches, true);
  assert.equal(report.approval.status, 'pending');
  assert.equal(report.approval.boundToCurrentPlan, false);
});

test('formatInspectSummary returns concise human-readable output', () => {
  const plan = createPlanFromDraft(makeDraft());
  const report = buildInspectReport(plan);
  const summary = formatInspectSummary(plan, report);

  assert.match(summary, new RegExp(`Plan: ${plan.id}`));
  assert.match(summary, /Risk: low \(score: 0\)/);
  assert.match(summary, /Ready To Apply: no/);
  assert.match(summary, /Blockers:/);
  assert.match(summary, /Tip: Use inspect-plan --json for machine-readable output\./);
  assert.equal(summary.trimStart().startsWith('{'), false);
});

test('inspect-plan CLI prints human summary by default', (t) => {
  const planPath = writePlan(t, createPlanFromDraft(makeDraft()));
  const output = runCli(t, ['inspect-plan', planPath]);
  if (!output) return;

  assert.match(output, /Plan:/);
  assert.match(output, /Ready To Apply:/);
  assert.equal(output.trimStart().startsWith('{'), false);
});

test('inspect-plan CLI prints JSON with trailing --json', (t) => {
  const planPath = writePlan(t, createPlanFromDraft(makeDraft()));
  const output = runCli(t, ['inspect-plan', planPath, '--json']);
  if (!output) return;
  const report = JSON.parse(output);

  assert.equal(report.id.length > 0, true);
  assert.equal(report.integrity.integrityMatches, true);
});

test('inspect-plan CLI accepts leading --json before plan path', (t) => {
  const planPath = writePlan(t, createPlanFromDraft(makeDraft()));
  const output = runCli(t, ['inspect-plan', '--json', planPath]);
  if (!output) return;
  const report = JSON.parse(output);

  assert.equal(report.operationCount, 1);
  assert.equal(report.integrity.integrityMatches, true);
});

test('tampered operation path causes inspect integrity mismatch', () => {
  const plan = createPlanFromDraft(makeDraft());
  const tampered = {
    ...plan,
    operations: [
      {
        ...plan.operations[0],
        path: 'tmp/changed.txt'
      }
    ]
  };

  const report = buildInspectReport(tampered);
  assert.equal(report.integrity.integrityMatches, false);
});

test('formatInspectSummary includes signer trust state when policy is configured', () => {
  const plan = approvePlan(createPlanFromDraft(makeDraft()), 'ci-user');
  const report = buildInspectReport(plan);
  const summary = formatInspectSummary(plan, report, {
    config: {
      signers: {
        trustedKeyIds: ['trusted-signer-1']
      }
    }
  });

  assert.match(summary, /trust: unsigned/);
});
