const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  GatefileEngine,
  createPlanFromDraft,
  approvePlan,
  buildInspectReport,
  formatInspectSummary,
  reviewPlan
} = require('../dist');
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
  assert.equal(report.verification.planId, plan.id);
  assert.equal(report.verification.status, 'not-ready');
  assert.equal(
    report.verification.hashes.currentPlanHash,
    report.integrity.currentPlanHash
  );
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
  assert.equal(report.verification.planId, report.id);
  assert.equal(report.verification.status, 'not-ready');
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
  const report = buildInspectReport(plan, {
    config: {
      signers: {
        trustedKeyIds: ['trusted-signer-1']
      }
    }
  });
  const summary = formatInspectSummary(plan, report);

  assert.match(summary, /trust: unsigned/);
  assert.equal(report.verification.signerTrust.status, 'unsigned');
  assert.equal(report.verification.status, 'not-ready');
});

test('formatInspectSummary renders the embedded verification snapshot without reloading policy', (t) => {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-inspect-snapshot-')));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    JSON.stringify({ signers: { trustedKeyIds: ['required-review-signer'] } })
  );
  const engine = new GatefileEngine({ repoRoot });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const report = engine.inspectPlan(plan);

  fs.writeFileSync(path.join(repoRoot, 'gatefile.config.json'), '{}\n');
  const summary = engine.formatInspectPlan(plan, report);
  assert.match(summary, /trust: unsigned/);
  assert.match(summary, /Ready To Apply: no/);
});

test('non-TTY review readiness matches the injected engine signer policy', async (t) => {
  const engine = new GatefileEngine({
    repoRoot: process.cwd(),
    config: {
      signers: {
        trustedKeyIds: ['required-review-signer']
      }
    }
  });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const planPath = writePlan(t, plan);
  const expected = engine.verifyPlan(plan);
  const expectedSummary = engine.formatInspectPlan(plan, engine.inspectPlan(plan));
  const messages = [];
  const originalLog = console.log;
  console.log = (...values) => messages.push(values.join(' '));

  try {
    await reviewPlan(planPath, { engine });
  } finally {
    console.log = originalLog;
  }

  const summary = messages.join('\n');
  assert.equal(expected.signerTrust.status, 'unsigned');
  assert.equal(summary, expectedSummary);
  assert.match(summary, /trust: unsigned/);
  assert.match(
    summary,
    new RegExp(`Ready To Apply: ${expected.status === 'ready' ? 'yes' : 'no'}`)
  );
});
