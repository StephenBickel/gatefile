const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { audit, formatAuditTable, writeApprovalReceipt, writeApplyReceipt } = require('../dist');

// Tests use a temp dir as cwd so .gatefile is created there
function withTmpCwd(fn) {
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-audit-'));
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(original);
  }
}

const fakePlan = (id) => ({
  id: `plan_${id}`,
  summary: `Test plan ${id}`,
  approval: {
    status: 'approved',
    approvedBy: 'tester',
    approvedAt: new Date().toISOString(),
    approvedPlanHash: 'abc123'
  }
});

test('audit returns empty when no .gatefile directory exists', () => {
  withTmpCwd(() => {
    const result = audit();
    assert.equal(result.events.length, 0);
  });
});

test('writeApprovalReceipt creates receipt that audit reads', () => {
  withTmpCwd(() => {
    writeApprovalReceipt(fakePlan('a'));
    const result = audit();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'approved');
    assert.equal(result.events[0].planId, 'plan_a');
  });
});

test('writeApplyReceipt creates receipt that audit reads', () => {
  withTmpCwd(() => {
    writeApplyReceipt(fakePlan('b'), true, new Date().toISOString());
    const result = audit();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'applied');
  });
});

test('audit --since filters by time', () => {
  withTmpCwd(() => {
    // Write an old receipt
    const dir = path.join('.gatefile', 'approvals');
    fs.mkdirSync(dir, { recursive: true });
    const oldReceipt = {
      type: 'approved',
      planId: 'plan_old',
      summary: 'old',
      timestamp: '2020-01-01T00:00:00.000Z',
      actor: 'old-actor'
    };
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(oldReceipt), 'utf-8');

    // Write a recent receipt
    writeApprovalReceipt(fakePlan('new'));

    const allEvents = audit();
    assert.equal(allEvents.events.length, 2);

    const recentEvents = audit({ since: '1d' });
    assert.equal(recentEvents.events.length, 1);
    assert.equal(recentEvents.events[0].planId, 'plan_new');
  });
});

test('audit --plan filters by planId', () => {
  withTmpCwd(() => {
    writeApprovalReceipt(fakePlan('x'));
    writeApprovalReceipt(fakePlan('y'));

    const filtered = audit({ planId: 'plan_x' });
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].planId, 'plan_x');
  });
});

test('formatAuditTable produces readable output', () => {
  withTmpCwd(() => {
    writeApprovalReceipt(fakePlan('fmt'));
    const result = audit();
    const table = formatAuditTable(result);
    assert.ok(table.includes('TIME'));
    assert.ok(table.includes('EVENT'));
    assert.ok(table.includes('approved'));
    assert.ok(table.includes('1 event(s)'));
  });
});

test('formatAuditTable handles empty events', () => {
  const table = formatAuditTable({ events: [] });
  assert.ok(table.includes('No audit events found'));
});

test('audit shows apply failures', () => {
  withTmpCwd(() => {
    writeApplyReceipt(fakePlan('fail'), false, new Date().toISOString());
    const result = audit();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'apply-failed');
    assert.equal(result.events[0].details, 'failed');
  });
});
