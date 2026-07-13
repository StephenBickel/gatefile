const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  applyPlan,
  approvePlan,
  createPlanFromDraft
} = require('../dist');
const {
  audit,
  formatAuditTable,
  writeApprovalReceipt,
  writeApplyReceipt
} = require('../dist/audit');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function fixture(t, prefix = 'gatefile-audit-') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(repoRoot);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome };
}

function approvedFilePlan(f, name) {
  const plan = createPlanFromDraft({
    source: 'authenticated-audit-test',
    summary: `Authenticated audit ${name}`,
    operations: [{
      id: `op_${name}`,
      type: 'file',
      action: 'create',
      path: `${name}.txt`,
      after: `${name}\n`
    }],
    preconditions: []
  }, { repoRoot: f.repoRoot });
  return approvePlan(plan, 'audit-reviewer', { repoRoot: f.repoRoot });
}

function applyFilePlan(f, name) {
  const plan = approvedFilePlan(f, name);
  const report = applyPlan(plan, { repoRoot: f.repoRoot, stateHome: f.stateHome });
  assert.equal(report.success, true, JSON.stringify(report, null, 2));
  return { plan, report };
}

test('audit returns empty when authenticated state does not exist', (t) => {
  const f = fixture(t);
  assert.deepEqual(audit({ repoRoot: f.repoRoot, stateHome: f.stateHome }), { events: [] });
});

test('audit projects real apply receipts with authenticated approval metadata', (t) => {
  const f = fixture(t);
  const { plan, report } = applyFilePlan(f, 'success');

  const result = audit({ repoRoot: f.repoRoot, stateHome: f.stateHome });

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    type: 'applied',
    planId: plan.id,
    planHash: plan.integrity.planHash,
    receiptId: report.receipt.id,
    summary: plan.summary,
    source: plan.source,
    timestamp: report.appliedAt,
    actor: 'audit-reviewer',
    approvalIdentity: 'unsigned',
    signerKeyId: null,
    authenticated: true,
    file: path.basename(report.receipt.path)
  });
});

test('audit ignores planted repository-local legacy receipts', (t) => {
  const f = fixture(t);
  const { plan } = applyFilePlan(f, 'real');
  const legacyDir = path.join(f.repoRoot, '.gatefile', 'state');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'forged.json'), JSON.stringify({
    type: 'applied',
    planId: 'plan_forged',
    summary: 'forged legacy event',
    timestamp: new Date().toISOString(),
    actor: 'attacker'
  }));

  const result = audit({ repoRoot: f.repoRoot, stateHome: f.stateHome });
  assert.deepEqual(result.events.map((event) => event.planId), [plan.id]);
});

test('audit fails closed when an authenticated receipt is tampered', (t) => {
  const f = fixture(t);
  const { report } = applyFilePlan(f, 'tamper');
  const receipt = JSON.parse(fs.readFileSync(report.receipt.path, 'utf8'));
  receipt.audit.summary = 'forged after authentication';
  fs.writeFileSync(report.receipt.path, `${JSON.stringify(receipt, null, 2)}\n`);

  assert.throws(
    () => audit({ repoRoot: f.repoRoot, stateHome: f.stateHome }),
    /authentication|tag|digest|verify/i
  );
});

test('audit rejects unexpected files in the authenticated receipt directory', (t) => {
  const f = fixture(t);
  const { report } = applyFilePlan(f, 'unexpected');
  fs.writeFileSync(path.join(path.dirname(report.receipt.path), 'notes.txt'), 'not a receipt\n', {
    mode: 0o600
  });

  assert.throws(
    () => audit({ repoRoot: f.repoRoot, stateHome: f.stateHome }),
    /unexpected authenticated receipt entry/i
  );
});

test('audit emits apply-failed and supports plan/time filters', (t) => {
  const f = fixture(t);
  const plan = createPlanFromDraft({
    source: 'authenticated-audit-test',
    summary: 'Authenticated failed apply',
    operations: [{
      id: 'op_expected_failure',
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.exit(9)']
    }],
    preconditions: []
  }, { repoRoot: f.repoRoot });
  const approved = approvePlan(plan, 'failure-reviewer', { repoRoot: f.repoRoot });
  const report = applyPlan(approved, { repoRoot: f.repoRoot, stateHome: f.stateHome });
  assert.equal(report.success, false);

  const filtered = audit({
    repoRoot: f.repoRoot,
    stateHome: f.stateHome,
    planId: approved.id,
    since: '1h'
  });
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.events[0].type, 'apply-failed');
  assert.equal(filtered.events[0].details, 'failed');
  assert.equal(audit({
    repoRoot: f.repoRoot,
    stateHome: f.stateHome,
    since: '2999-01-01T00:00:00.000Z'
  }).events.length, 0);
});

test('legacy unauthenticated audit writers fail before creating files', (t) => {
  const f = fixture(t);
  const plan = approvedFilePlan(f, 'legacy-writer');
  const originalCwd = process.cwd();
  process.chdir(f.repoRoot);
  try {
    assert.throws(() => writeApprovalReceipt(plan), /unauthenticated.*removed|deprecated/i);
    assert.throws(
      () => writeApplyReceipt(plan, true, new Date().toISOString()),
      /unauthenticated.*removed|deprecated/i
    );
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.gatefile')), false);
});

test('audit CLI honors explicit repository and state authority', (t) => {
  const f = fixture(t);
  const { plan } = applyFilePlan(f, 'cli');
  const output = execFileSync(process.execPath, [
    CLI_PATH,
    'audit',
    '--repo-root', f.repoRoot,
    '--state-home', f.stateHome,
    '--plan', plan.id,
    '--json'
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].planId, plan.id);
  assert.equal(result.events[0].authenticated, true);
});

test('formatAuditTable renders authenticated apply events and empty results', (t) => {
  const f = fixture(t);
  applyFilePlan(f, 'format');
  const table = formatAuditTable(audit({ repoRoot: f.repoRoot, stateHome: f.stateHome }));
  assert.match(table, /TIME/);
  assert.match(table, /applied/);
  assert.match(table, /audit-reviewer/);
  assert.match(table, /1 event\(s\)/);
  assert.match(formatAuditTable({ events: [] }), /No audit events found/);
});
