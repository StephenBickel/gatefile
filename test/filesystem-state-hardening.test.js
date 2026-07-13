const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyPlan,
  approvePlan,
  createPlanFromDraft,
  rollbackApply
} = require('../dist');
const { dependencyStatus } = require('../dist/state');

function fixture(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state-home');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome, outside };
}

function approvedPlan(repoRoot, operations, allowedRoots = [repoRoot]) {
  return approvePlan(
    createPlanFromDraft(
      {
        source: 'filesystem-state-hardening-test',
        summary: 'Exercise secure filesystem and authenticated rollback state',
        operations,
        preconditions: [],
        execution: { filePolicy: { allowedRoots } }
      },
      { repoRoot }
    ),
    'security-reviewer',
    { repoRoot }
  );
}

function applyOptions(f) {
  return { repoRoot: f.repoRoot, stateHome: f.stateHome };
}

function applyApproved(f, operations, allowedRoots) {
  return applyPlan(
    approvedPlan(f.repoRoot, operations, allowedRoots),
    applyOptions(f)
  );
}

function makeAppliedUpdate(t, prefix = 'gatefile-secure-update') {
  const f = fixture(t, prefix);
  const target = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(target, 'before\n', 'utf8');
  const report = applyApproved(f, [
    {
      id: 'update-managed',
      type: 'file',
      action: 'update',
      path: target,
      before: 'before\n',
      after: 'after\n'
    }
  ]);
  assert.equal(report.success, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
  return { ...f, target, report };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function makeDirectorySymlink(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'dir');
    return true;
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function rollbackRejection(run, pattern) {
  let report;
  let error;
  try {
    report = run();
  } catch (caught) {
    error = caught;
  }

  const detail = error
    ? String(error.message ?? error)
    : [
        ...(report?.notes ?? []),
        ...(report?.fileResults ?? []).map((entry) => entry.message)
      ].join('; ');

  assert.ok(error || report?.success === false, 'rollback unexpectedly succeeded');
  if (pattern) assert.match(detail, pattern);
  return { error, report, detail };
}

function assertAuthenticatedRecord(record) {
  assert.equal(record.stateVersion, 1);
  assert.deepEqual(Object.keys(record.authentication).sort(), [
    'envelopeVersion',
    'keyId',
    'scheme',
    'tag'
  ]);
  assert.equal(record.authentication.scheme, 'hmac-sha256');
  assert.equal(record.authentication.envelopeVersion, 1);
  assert.equal(typeof record.authentication.keyId, 'string');
  assert.ok(record.authentication.keyId.length > 0);
  assert.equal(typeof record.authentication.tag, 'string');
  assert.ok(record.authentication.tag.length > 0);
}

test('default file root accepts the operator absolute spelling of a canonical macOS repo alias', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS trusted root alias semantics');
    return;
  }
  const f = fixture(t, 'gatefile-default-root-platform-alias');
  if (f.repoRoot === fs.realpathSync(f.repoRoot)) {
    t.skip('temporary directory does not use a platform alias');
    return;
  }
  const target = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(target, 'before\n');
  const plan = approvePlan(
    createPlanFromDraft({
      source: 'platform-alias-test',
      summary: 'Use the operator spelling of the repository root',
      operations: [{
        id: 'update', type: 'file', action: 'update', path: target,
        before: 'before\n', after: 'after\n'
      }],
      preconditions: []
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  const report = applyPlan(plan, applyOptions(f));
  assert.equal(report.success, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
  assert.equal(rollbackApply(report.receipt.id, applyOptions(f)).success, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
});

test('stateHome stores versioned authenticated receipts and snapshots outside the repository', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-state-contract');
  const canonicalStateHome = fs.realpathSync(applied.stateHome);
  assert.equal(isWithin(canonicalStateHome, applied.report.receipt.path), true);
  assert.equal(isWithin(canonicalStateHome, applied.report.snapshot.path), true);
  assert.equal(isWithin(applied.repoRoot, applied.report.receipt.path), false);
  assert.equal(isWithin(applied.repoRoot, applied.report.snapshot.path), false);

  const receipt = readJson(applied.report.receipt.path);
  const snapshot = readJson(applied.report.snapshot.path);
  assertAuthenticatedRecord(receipt);
  assertAuthenticatedRecord(snapshot);
  assert.equal(receipt.snapshotId, snapshot.id);
});

test('beforeApply hook does not run when secure file preflight rejects the plan', (t) => {
  const f = fixture(t, 'gatefile-hook-after-file-preflight');
  const linked = path.join(f.repoRoot, 'linked');
  if (!makeDirectorySymlink(t, f.outside, linked)) return;
  const sentinel = path.join(f.base, 'hook-ran.txt');
  const target = path.join(linked, 'managed.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'unsafe-create',
    type: 'file',
    action: 'create',
    path: target,
    after: 'must not be written\n'
  }]);
  const script = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran', 'utf8')`;
  const config = {
    hooks: {
      beforeApply: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }
    }
  };

  const report = applyPlan(plan, { ...applyOptions(f), config });
  assert.equal(report.success, false);
  assert.match(report.results[0].message, /symlink|secure preflight|denied/i);
  assert.equal(fs.existsSync(sentinel), false, 'policy hook ran before secure preflight completed');
  assert.equal(fs.existsSync(path.join(f.outside, 'managed.txt')), false);
});

test('file operations cannot target the external authenticated state namespace', (t) => {
  const f = fixture(t, 'gatefile-external-state-reserved');
  fs.mkdirSync(f.stateHome, { mode: 0o700 });
  const target = path.join(f.stateHome, 'attacker-controlled.txt');

  const report = applyApproved(
    f,
    [
      {
        id: 'state-home-target',
        type: 'file',
        action: 'create',
        path: target,
        after: 'must never be created\n'
      }
    ],
    [f.stateHome]
  );

  assert.equal(report.success, false);
  assert.match(report.results[0].message, /reserved|state home|secure preflight|denied/i);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(report.receipt.path), true);
});

test('file operations reject a symlink used as an allowed root', (t) => {
  const f = fixture(t, 'gatefile-symlink-root');
  const linkedRoot = path.join(f.repoRoot, 'linked-root');
  if (!makeDirectorySymlink(t, f.outside, linkedRoot)) return;
  const escaped = path.join(linkedRoot, 'escaped.txt');

  const report = applyApproved(
    f,
    [{ id: 'create', type: 'file', action: 'create', path: escaped, after: 'escaped\n' }],
    [linkedRoot]
  );

  assert.equal(report.success, false);
  assert.match(report.results[0].message, /symlink|unsafe|file path denied/i);
  assert.equal(fs.existsSync(path.join(f.outside, 'escaped.txt')), false);
});

for (const action of ['create', 'update', 'delete']) {
  test(`${action} rejects an ancestor symlink beneath an allowed root`, (t) => {
    const f = fixture(t, `gatefile-ancestor-${action}`);
    const linkedDirectory = path.join(f.repoRoot, 'linked-directory');
    if (!makeDirectorySymlink(t, f.outside, linkedDirectory)) return;
    const outsideTarget = path.join(f.outside, `${action}.txt`);
    const managedPath = path.join(linkedDirectory, `${action}.txt`);
    if (action !== 'create') fs.writeFileSync(outsideTarget, 'before\n', 'utf8');

    const operation = action === 'create'
      ? { id: action, type: 'file', action, path: managedPath, after: 'after\n' }
      : action === 'update'
        ? {
            id: action,
            type: 'file',
            action,
            path: managedPath,
            before: 'before\n',
            after: 'after\n'
          }
        : { id: action, type: 'file', action, path: managedPath, before: 'before\n' };

    const report = applyApproved(f, [operation]);
    assert.equal(report.success, false);
    assert.match(report.results[0].message, /symlink|unsafe|file path denied/i);
    if (action === 'create') {
      assert.equal(fs.existsSync(outsideTarget), false);
    } else {
      assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'before\n');
    }
  });
}

test('atomic update isolates hardlink aliases and preserves the reviewed file mode', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX hardlink and mode semantics');
    return;
  }
  const f = fixture(t, 'gatefile-hardlink-update');
  const outsideTarget = path.join(f.outside, 'victim.txt');
  const managedPath = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(outsideTarget, 'before\n', { encoding: 'utf8', mode: 0o640 });
  fs.chmodSync(outsideTarget, 0o640);
  fs.linkSync(outsideTarget, managedPath);

  const report = applyApproved(f, [
    {
      id: 'update',
      type: 'file',
      action: 'update',
      path: managedPath,
      before: 'before\n',
      after: 'after\n'
    }
  ]);

  assert.equal(report.success, true);
  assert.equal(fs.readFileSync(managedPath, 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'before\n');
  assert.equal(fs.statSync(managedPath).mode & 0o777, 0o640);
  assert.notEqual(fs.statSync(managedPath).ino, fs.statSync(outsideTarget).ino);
});

test('tampered receipt is rejected before any managed-file mutation', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-tampered-receipt');
  const receipt = readJson(applied.report.receipt.path);
  receipt.planHash = '0'.repeat(64);
  writeJson(applied.report.receipt.path, receipt);

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /authentication|hmac|integrity|tamper/i
  );
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'after\n');
});

test('tampered snapshot cannot redirect rollback to an outside path', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-tampered-snapshot');
  const victim = path.join(applied.outside, 'victim.txt');
  fs.writeFileSync(victim, 'safe\n', 'utf8');
  const snapshot = readJson(applied.report.snapshot.path);
  snapshot.entries[0].requestedPath = victim;
  snapshot.entries[0].before.contentBase64 = Buffer.from('attacker-controlled\n').toString('base64');
  writeJson(applied.report.snapshot.path, snapshot);

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /authentication|hmac|integrity|tamper/i
  );
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'safe\n');
});

test('receipt IDs are validated as single path components before state access', (t) => {
  const f = fixture(t, 'gatefile-receipt-traversal');
  const sentinel = path.join(f.outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'safe\n', 'utf8');

  for (const receiptId of ['../escape', '../../escape', 'nested/escape', path.resolve(f.outside, 'absolute')]) {
    assert.throws(
      () => rollbackApply(receiptId, applyOptions(f)),
      /invalid (?:receipt|state) id|receipt id.*single|unsafe receipt id|path traversal/i,
      receiptId
    );
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'safe\n');
});

test('post-apply drift aborts the entire rollback before restoring any file', (t) => {
  const f = fixture(t, 'gatefile-rollback-drift');
  const first = path.join(f.repoRoot, 'first.txt');
  const second = path.join(f.repoRoot, 'second.txt');
  fs.writeFileSync(first, 'first-before\n', 'utf8');
  fs.writeFileSync(second, 'second-before\n', 'utf8');
  const report = applyApproved(f, [
    {
      id: 'first', type: 'file', action: 'update', path: first,
      before: 'first-before\n', after: 'first-after\n'
    },
    {
      id: 'second', type: 'file', action: 'update', path: second,
      before: 'second-before\n', after: 'second-after\n'
    }
  ]);
  assert.equal(report.success, true);
  fs.writeFileSync(second, 'third-party-drift\n', 'utf8');

  rollbackRejection(
    () => rollbackApply(report.receipt.id, applyOptions(f)),
    /drift|changed|post-apply state/i
  );
  assert.equal(fs.readFileSync(first, 'utf8'), 'first-after\n');
  assert.equal(fs.readFileSync(second, 'utf8'), 'third-party-drift\n');
});

test('rollback refuses a final-component symlink without touching its target', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-rollback-final-link');
  const victim = path.join(applied.outside, 'victim.txt');
  fs.writeFileSync(victim, 'safe\n', 'utf8');
  fs.unlinkSync(applied.target);
  try {
    fs.symlinkSync(victim, applied.target);
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /symbolic link|symlink|unsafe|post-apply state|drift/i
  );
  assert.equal(fs.lstatSync(applied.target).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'safe\n');
});

test('rollback refuses an ancestor symlink without touching its target', (t) => {
  const f = fixture(t, 'gatefile-rollback-ancestor-link');
  const directory = path.join(f.repoRoot, 'directory');
  fs.mkdirSync(directory);
  const target = path.join(directory, 'managed.txt');
  fs.writeFileSync(target, 'before\n', 'utf8');
  const report = applyApproved(f, [
    {
      id: 'update', type: 'file', action: 'update', path: target,
      before: 'before\n', after: 'after\n'
    }
  ]);
  assert.equal(report.success, true);

  const originalDirectory = path.join(f.repoRoot, 'directory-original');
  fs.renameSync(directory, originalDirectory);
  const outsideDirectory = path.join(f.outside, 'replacement-directory');
  fs.mkdirSync(outsideDirectory);
  const victim = path.join(outsideDirectory, 'managed.txt');
  fs.writeFileSync(victim, 'safe\n', 'utf8');
  if (!makeDirectorySymlink(t, outsideDirectory, directory)) return;

  rollbackRejection(
    () => rollbackApply(report.receipt.id, applyOptions(f)),
    /symbolic link|symlink|unsafe|post-apply state|drift/i
  );
  assert.equal(fs.readFileSync(path.join(originalDirectory, 'managed.txt'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'safe\n');
});

test('copying valid state records across repositories is rejected', (t) => {
  const a = makeAppliedUpdate(t, 'gatefile-cross-repo-a');
  const b = makeAppliedUpdate(t, 'gatefile-cross-repo-b');

  fs.copyFileSync(a.report.receipt.path, b.report.receipt.path);
  const copiedSnapshotPath = path.join(
    path.dirname(b.report.snapshot.path),
    path.basename(a.report.snapshot.path)
  );
  fs.copyFileSync(a.report.snapshot.path, copiedSnapshotPath);

  rollbackRejection(
    () => rollbackApply(b.report.receipt.id, applyOptions(b)),
    /authentication|repository|record id|receipt id|integrity/i
  );
  assert.equal(fs.readFileSync(a.target, 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(b.target, 'utf8'), 'after\n');
});

test('swapping two valid authenticated snapshots in one repository is rejected', (t) => {
  const f = fixture(t, 'gatefile-snapshot-swap');
  const firstTarget = path.join(f.repoRoot, 'first.txt');
  const secondTarget = path.join(f.repoRoot, 'second.txt');
  fs.writeFileSync(firstTarget, 'first-before\n', 'utf8');
  fs.writeFileSync(secondTarget, 'second-before\n', 'utf8');
  const first = applyApproved(f, [{
    id: 'first-update', type: 'file', action: 'update', path: firstTarget,
    before: 'first-before\n', after: 'first-after\n'
  }]);
  const second = applyApproved(f, [{
    id: 'second-update', type: 'file', action: 'update', path: secondTarget,
    before: 'second-before\n', after: 'second-after\n'
  }]);

  fs.copyFileSync(second.snapshot.path, first.snapshot.path);
  rollbackRejection(
    () => rollbackApply(first.receipt.id, applyOptions(f)),
    /snapshot.*id|snapshot.*digest|reference|integrity/i
  );
  assert.equal(fs.readFileSync(firstTarget, 'utf8'), 'first-after\n');
  assert.equal(fs.readFileSync(secondTarget, 'utf8'), 'second-after\n');
});

test('a forged authenticated-plan-state cache cannot satisfy dependsOn', (t) => {
  const f = fixture(t, 'gatefile-dependency-forgery');
  const dependencyTarget = path.join(f.repoRoot, 'dependency.txt');
  const dependentTarget = path.join(f.repoRoot, 'dependent.txt');
  const dependencyPlan = approvedPlan(f.repoRoot, [{
    id: 'dependency-create', type: 'file', action: 'create',
    path: dependencyTarget, after: 'dependency\n'
  }]);
  const dependencyReport = applyPlan(dependencyPlan, applyOptions(f));
  assert.equal(dependencyReport.success, true);

  const recordsRoot = path.dirname(path.dirname(dependencyReport.receipt.path));
  const plansDir = path.join(recordsRoot, 'plans');
  const planStatePath = path.join(plansDir, fs.readdirSync(plansDir)[0]);
  const forged = readJson(planStatePath);
  forged.receiptDigest = '0'.repeat(64);
  writeJson(planStatePath, forged);

  const dependent = approvePlan(
    createPlanFromDraft({
      source: 'filesystem-state-hardening-test',
      summary: 'Dependency state must be authenticated',
      dependsOn: [dependencyPlan.id],
      operations: [{
        id: 'dependent-create', type: 'file', action: 'create',
        path: dependentTarget, after: 'dependent\n'
      }],
      preconditions: [],
      execution: { filePolicy: { allowedRoots: [f.repoRoot] } }
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  assert.throws(
    () => applyPlan(dependent, applyOptions(f)),
    /dependency state integrity|authentication|hmac/i
  );
  assert.equal(fs.existsSync(dependentTarget), false);
});

test('rollback rejects symlinked receipt files and insecure external keys', (t) => {
  const linked = makeAppliedUpdate(t, 'gatefile-state-record-link');
  const receiptBackup = path.join(linked.outside, 'receipt-backup.json');
  fs.renameSync(linked.report.receipt.path, receiptBackup);
  fs.symlinkSync(receiptBackup, linked.report.receipt.path);
  rollbackRejection(
    () => rollbackApply(linked.report.receipt.id, applyOptions(linked)),
    /symbolic|symlink|no.?follow/i
  );
  assert.equal(fs.readFileSync(linked.target, 'utf8'), 'after\n');

  if (process.platform !== 'win32') {
    const insecure = makeAppliedUpdate(t, 'gatefile-state-key-mode');
    const receipt = readJson(insecure.report.receipt.path);
    const recordsRoot = path.dirname(path.dirname(insecure.report.receipt.path));
    const repositoryStateRoot = path.dirname(recordsRoot);
    const keyPath = path.join(
      repositoryStateRoot,
      'keys',
      `${receipt.authentication.keyId}.key`
    );
    fs.chmodSync(keyPath, 0o644);
    rollbackRejection(
      () => rollbackApply(insecure.report.receipt.id, applyOptions(insecure)),
      /permission|mode|private/i
    );
    assert.equal(fs.readFileSync(insecure.target, 'utf8'), 'after\n');
  }
});

test('legacy unsigned receipt and snapshot state is refused', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-legacy-state');
  for (const statePath of [applied.report.receipt.path, applied.report.snapshot.path]) {
    const record = readJson(statePath);
    delete record.stateVersion;
    delete record.authentication;
    writeJson(statePath, record);
  }

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /legacy|unsigned|authentication|state version/i
  );
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'after\n');
});

test('a successfully consumed rollback receipt cannot be replayed', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-rollback-replay');
  const first = rollbackApply(applied.report.receipt.id, applyOptions(applied));
  assert.equal(first.success, true);
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'before\n');

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /already rolled back|consumed|replay/i
  );
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'before\n');
});

test('rollback of a partial apply touches only operations that actually succeeded', (t) => {
  const f = fixture(t, 'gatefile-partial-rollback');
  const created = path.join(f.repoRoot, 'created.txt');
  const neverRun = path.join(f.repoRoot, 'never-run.txt');

  const report = applyApproved(f, [
    { id: 'created', type: 'file', action: 'create', path: created, after: 'created\n' },
    {
      id: 'runtime-failure',
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.exit(7)']
    },
    { id: 'never-run', type: 'file', action: 'create', path: neverRun, after: 'planned\n' }
  ]);
  assert.equal(report.success, false);
  assert.equal(fs.readFileSync(created, 'utf8'), 'created\n');
  assert.equal(fs.existsSync(neverRun), false);
  fs.writeFileSync(neverRun, 'third-party\n', 'utf8');

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true);
  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.readFileSync(neverRun, 'utf8'), 'third-party\n');
});

test('file operations cannot target the reserved .gatefile/state namespace', (t) => {
  const f = fixture(t, 'gatefile-reserved-state');
  const target = path.join(f.repoRoot, '.gatefile', 'state', 'attacker.json');
  const report = applyApproved(f, [
    { id: 'reserved', type: 'file', action: 'create', path: target, after: '{"owned":true}\n' }
  ]);

  assert.equal(report.success, false);
  assert.match(report.results[0].message, /reserved|internal state|file path denied/i);
  assert.equal(fs.existsSync(target), false);
});

test('replacing a checkout at the same path cannot reuse authenticated rollback state', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-replaced-checkout');
  const oldRepo = path.join(applied.base, 'old-repo');
  fs.renameSync(applied.repoRoot, oldRepo);
  fs.mkdirSync(applied.repoRoot, { mode: 0o700 });

  rollbackRejection(
    () => rollbackApply(applied.report.receipt.id, applyOptions(applied)),
    /missing|repository|binding|instance|receipt|state/i
  );
  assert.equal(fs.existsSync(path.join(applied.repoRoot, 'managed.txt')), false);
  assert.equal(fs.readFileSync(path.join(oldRepo, 'managed.txt'), 'utf8'), 'after\n');
});

test('rollback refuses a replaced allowed-root directory identity', (t) => {
  const f = fixture(t, 'gatefile-replaced-allowed-root');
  const workspace = path.join(f.repoRoot, 'workspace');
  fs.mkdirSync(workspace);
  const target = path.join(workspace, 'managed.txt');
  fs.writeFileSync(target, 'before\n', 'utf8');
  const report = applyApproved(f, [{
    id: 'update', type: 'file', action: 'update', path: target,
    before: 'before\n', after: 'after\n'
  }], [workspace]);
  assert.equal(report.success, true);

  const originalWorkspace = path.join(f.repoRoot, 'workspace-original');
  fs.renameSync(workspace, originalWorkspace);
  fs.mkdirSync(workspace);
  fs.writeFileSync(target, 'replacement\n', 'utf8');

  rollbackRejection(
    () => rollbackApply(report.receipt.id, applyOptions(f)),
    /directory.*identity|directory chain|allowed root|drift|binding/i
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement\n');
  assert.equal(fs.readFileSync(path.join(originalWorkspace, 'managed.txt'), 'utf8'), 'after\n');
});

test('a rollback invalidates direct and transitive dependency state', (t) => {
  const f = fixture(t, 'gatefile-rollback-dependencies');
  const makePlan = (id, dependsOn = []) => approvePlan(
    createPlanFromDraft({
      source: 'filesystem-state-hardening-test',
      summary: `Apply dependency ${id}`,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      operations: [{
        id: `create-${id}`,
        type: 'file',
        action: 'create',
        path: path.join(f.repoRoot, `${id}.txt`),
        after: `${id}\n`
      }],
      preconditions: [],
      execution: { filePolicy: { allowedRoots: [f.repoRoot] } }
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  const planA = makePlan('a');
  const reportA = applyPlan(planA, applyOptions(f));
  assert.equal(reportA.success, true);
  const planB = makePlan('b', [planA.id]);
  assert.equal(applyPlan(planB, applyOptions(f)).success, true);

  assert.equal(rollbackApply(reportA.receipt.id, applyOptions(f)).success, true);
  const direct = makePlan('direct-after-rollback', [planA.id]);
  assert.throws(
    () => applyPlan(direct, applyOptions(f)),
    /dependencies.*not satisfied|missing successful apply/i
  );
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'direct-after-rollback.txt')), false);

  const transitive = makePlan('transitive-after-rollback', [planB.id]);
  assert.throws(
    () => applyPlan(transitive, applyOptions(f)),
    /dependencies.*not satisfied|missing successful apply/i
  );
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'transitive-after-rollback.txt')), false);
});

test('post-commit directory fsync failure is structured and remains rollbackable', (t) => {
  const f = fixture(t, 'gatefile-postcommit-fsync');
  const target = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(target, 'before\n');
  const repoStat = fs.statSync(f.repoRoot);
  const plan = approvedPlan(f.repoRoot, [{
    id: 'update', type: 'file', action: 'update', path: target,
    before: 'before\n', after: 'after\n'
  }]);

  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === repoStat.dev &&
      stat.ino === repoStat.ino &&
      fs.existsSync(target) &&
      fs.readFileSync(target, 'utf8') === 'after\n'
    ) {
      injected = true;
      const error = new Error('injected target-directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };
  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(report.success, false);
  assert.equal(report.results[0].mutationStatus, 'committed');
  assert.match(report.results[0].message, /committed.*finalization|rollback is required/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
  const receipt = readJson(report.receipt.path);
  assert.equal(receipt.rollbackEntries.length, 1);
  assert.equal(receipt.results[0].mutationStatus, 'committed');
  assert.equal(rollbackApply(report.receipt.id, applyOptions(f)).success, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
});

test('failed committed receipt accepts authenticated before-state after an ambiguous crash outcome', (t) => {
  const f = fixture(t, 'gatefile-postcommit-fsync-crash-before-state');
  const target = path.join(f.repoRoot, 'managed.txt');
  const originalInode = path.join(f.outside, 'original-inode.txt');
  fs.writeFileSync(target, 'before\n');
  fs.linkSync(target, originalInode);
  const repoStat = fs.statSync(f.repoRoot);
  const plan = approvedPlan(f.repoRoot, [{
    id: 'update', type: 'file', action: 'update', path: target,
    before: 'before\n', after: 'after\n'
  }]);

  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === repoStat.dev &&
      stat.ino === repoStat.ino &&
      fs.readFileSync(target, 'utf8') === 'after\n'
    ) {
      injected = true;
      const error = new Error('injected ambiguous target-directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };
  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(report.success, false);
  assert.equal(report.results[0].mutationStatus, 'committed');
  assert.equal(report.results[0].success, false);

  // Model crash recovery choosing the old side of an unconfirmed rename.
  fs.unlinkSync(target);
  fs.linkSync(originalInode, target);
  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true);
  assert.equal(rollback.fileResults[0].action, 'unchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
});

test('authenticated rollback removes a hidden create-publication residue', (t) => {
  const f = fixture(t, 'gatefile-create-residue');
  const target = path.join(f.repoRoot, 'created.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'create', type: 'file', action: 'create', path: target, after: 'sensitive\n'
  }]);
  const originalUnlink = fs.unlinkSync;
  let failuresRemaining = 2;
  fs.unlinkSync = (pathname) => {
    if (
      failuresRemaining > 0 &&
      typeof pathname === 'string' &&
      pathname.includes('.created.txt.gatefile-') &&
      pathname.endsWith('.tmp')
    ) {
      failuresRemaining -= 1;
      const error = new Error('injected staged-link cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(pathname);
  };
  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(failuresRemaining, 0);
  assert.equal(report.success, false);
  assert.equal(report.results[0].mutationStatus, 'committed');
  const receipt = readJson(report.receipt.path);
  assert.equal(receipt.rollbackEntries[0].cleanupResidues.length, 1);
  const residuePath = receipt.rollbackEntries[0].cleanupResidues[0].path;
  assert.equal(fs.existsSync(residuePath), true);
  assert.equal(fs.readFileSync(residuePath, 'utf8'), 'sensitive\n');

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(residuePath), false);
});

test('write-ahead receipt survives final receipt-publication failure', (t) => {
  const f = fixture(t, 'gatefile-receipt-wal');
  const target = path.join(f.repoRoot, 'created.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'create', type: 'file', action: 'create', path: target, after: 'created\n'
  }]);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (
      !injected &&
      fs.existsSync(target) &&
      typeof to === 'string' &&
      to.includes(`${path.sep}receipts${path.sep}`)
    ) {
      injected = true;
      const error = new Error('injected final receipt publication failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(report.success, false);
  assert.match((report.warnings ?? []).join('\n'), /write-ahead receipt remains.*rollback/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'created\n');
  const wal = readJson(report.receipt.path);
  assert.equal(wal.success, false);
  assert.equal(wal.results[0].mutationStatus, 'intended');
  assert.equal(wal.rollbackEntries.length, 1);

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true, rollback.notes.join('\n'));
  assert.equal(rollback.fileResults[0].restored, true);
  assert.equal(fs.existsSync(target), false);
});

test('pre-commit update failure preserves an authenticated residue and rolls back as a no-op', (t) => {
  const f = fixture(t, 'gatefile-update-wal-before-commit');
  const target = path.join(f.repoRoot, 'managed.txt');
  fs.writeFileSync(target, 'before\n', { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  const canonicalTarget = fs.realpathSync(target);
  const plan = approvedPlan(f.repoRoot, [{
    id: 'update', type: 'file', action: 'update', path: target,
    before: 'before\n', after: 'TOP-SECRET-AFTER\n'
  }]);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  const originalFchmod = fs.fchmodSync;
  let publishBlocked = false;
  let intentDurableBeforeWidening = false;
  fs.fchmodSync = (fd, mode) => {
    if (mode === 0o644 && fs.fstatSync(fd).size === Buffer.byteLength('TOP-SECRET-AFTER\n')) {
      const { getStateLayout } = require('../dist/state');
      const layout = getStateLayout({
        repoRoot: f.repoRoot,
        repositoryId: plan.context.repositoryId,
        stateHome: f.stateHome
      });
      const receipts = fs.readdirSync(layout.receiptsDir).map((name) =>
        readJson(path.join(layout.receiptsDir, name))
      );
      const wal = receipts.find((candidate) =>
        candidate.results?.some((result) => result.mutationStatus === 'intended')
      );
      assert.ok(wal, 'authenticated intent must be durable before staged metadata widens');
      const residue = wal.rollbackEntries[0].cleanupResidues[0];
      const residueStat = fs.statSync(residue.path);
      const openedStat = fs.fstatSync(fd);
      assert.equal(residueStat.dev, openedStat.dev);
      assert.equal(residueStat.ino, openedStat.ino);
      assert.equal(residueStat.mode & 0o777, 0o600);
      intentDurableBeforeWidening = true;
    }
    return originalFchmod(fd, mode);
  };
  fs.renameSync = (from, to) => {
    if (
      !publishBlocked &&
      to === canonicalTarget &&
      typeof from === 'string' &&
      from.includes('.managed.txt.gatefile-')
    ) {
      publishBlocked = true;
      const error = new Error('injected target publication failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  fs.unlinkSync = (pathname) => {
    if (
      publishBlocked &&
      typeof pathname === 'string' &&
      pathname.includes('.managed.txt.gatefile-') &&
      pathname.endsWith('.tmp')
    ) {
      const error = new Error('injected staged cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(pathname);
  };

  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
    fs.fchmodSync = originalFchmod;
  }

  assert.equal(publishBlocked, true);
  assert.equal(intentDurableBeforeWidening, true);
  assert.equal(report.success, false);
  assert.equal(report.results[0].mutationStatus, 'intended');
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
  const receipt = readJson(report.receipt.path);
  assert.equal(receipt.results[0].mutationStatus, 'intended');
  assert.equal(receipt.rollbackEntries.length, 1);
  assert.equal(receipt.rollbackEntries[0].cleanupResidues.length, 1);
  const residuePath = receipt.rollbackEntries[0].cleanupResidues[0].path;
  assert.equal(fs.readFileSync(residuePath, 'utf8'), 'TOP-SECRET-AFTER\n');
  assert.equal(fs.statSync(residuePath).mode & 0o022, 0);

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true);
  assert.equal(rollback.fileResults[0].action, 'unchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
  assert.equal(fs.existsSync(residuePath), false);
});

test('write-ahead intent remains rollbackable when target and final receipt publication both fail', (t) => {
  const f = fixture(t, 'gatefile-wal-uncommitted-final-receipt');
  const target = path.join(f.repoRoot, 'created.txt');
  const canonicalTarget = path.join(fs.realpathSync(f.repoRoot), 'created.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'create', type: 'file', action: 'create', path: target, after: 'created\n'
  }]);
  const originalLink = fs.linkSync;
  const originalRename = fs.renameSync;
  let targetPublicationBlocked = false;
  let receiptReplacements = 0;
  fs.linkSync = (from, to) => {
    if (
      to === canonicalTarget &&
      typeof from === 'string' &&
      from.includes('.created.txt.gatefile-')
    ) {
      targetPublicationBlocked = true;
      const error = new Error('injected target link failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLink(from, to);
  };
  fs.renameSync = (from, to) => {
    if (typeof to === 'string' && to.includes(`${path.sep}receipts${path.sep}`)) {
      receiptReplacements += 1;
      if (receiptReplacements === 2) {
        const error = new Error('injected final receipt replacement failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalRename(from, to);
  };

  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.linkSync = originalLink;
    fs.renameSync = originalRename;
  }

  assert.equal(targetPublicationBlocked, true);
  assert.equal(receiptReplacements, 2);
  assert.equal(report.success, false);
  assert.equal(report.results[0].mutationStatus, 'intended');
  assert.match((report.warnings ?? []).join('\n'), /write-ahead receipt remains.*rollback/i);
  assert.equal(fs.existsSync(target), false);
  const wal = readJson(report.receipt.path);
  assert.equal(wal.results[0].mutationStatus, 'intended');
  assert.equal(wal.rollbackEntries.length, 1);

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true);
  assert.equal(rollback.fileResults[0].action, 'unchanged');
  assert.equal(fs.existsSync(target), false);
});

test('occupied plan-state cache is rejected before the target side effect', (t) => {
  const f = fixture(t, 'gatefile-plan-state-preflight');
  const target = path.join(f.repoRoot, 'must-not-exist.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'create', type: 'file', action: 'create', path: target, after: 'bad\n'
  }]);
  const { ensureStateLayout } = require('../dist/state');
  const crypto = require('node:crypto');
  const layout = ensureStateLayout({
    repoRoot: f.repoRoot,
    repositoryId: plan.context.repositoryId,
    stateHome: f.stateHome
  });
  const filename = `${crypto.createHash('sha256')
    .update('gatefile-plan-state-path-v1\0', 'utf8')
    .update(plan.id, 'utf8')
    .digest('hex')}.json`;
  fs.mkdirSync(path.join(layout.plansDir, filename));

  assert.throws(
    () => applyPlan(plan, applyOptions(f)),
    /state path is not a regular file|plan-state|occupied|directory/i
  );
  assert.equal(fs.existsSync(target), false);

  const occupied = path.join(layout.plansDir, filename);
  fs.rmdirSync(occupied);
  fs.symlinkSync(path.join(f.outside, 'missing-plan-state.json'), occupied);
  assert.throws(
    () => applyPlan(plan, applyOptions(f)),
    /symbolic-link state file|symlink|plan-state|state path/i
  );
  assert.equal(fs.existsSync(target), false);
});

test('post-commit rollback fsync failure reports restored but undurable state', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-rollback-postcommit-fsync');
  const repoStat = fs.statSync(applied.repoRoot);
  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === repoStat.dev &&
      stat.ino === repoStat.ino &&
      fs.readFileSync(applied.target, 'utf8') === 'before\n'
    ) {
      injected = true;
      const error = new Error('injected rollback directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };
  let rollback;
  try {
    rollback = rollbackApply(applied.report.receipt.id, applyOptions(applied));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(rollback.success, false);
  assert.equal(rollback.fileResults[0].restored, true);
  assert.equal(rollback.fileResults[0].durabilityConfirmed, false);
  assert.match(rollback.fileResults[0].message, /committed.*durability|durability.*failed/i);
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'before\n');
});

test('rollback marker post-commit failure returns a failed report instead of throwing', (t) => {
  const applied = makeAppliedUpdate(t, 'gatefile-marker-postcommit-fsync');
  const recordsRoot = path.dirname(path.dirname(applied.report.receipt.path));
  const rollbacksDir = path.join(path.dirname(recordsRoot), 'rollbacks');
  if (!fs.existsSync(rollbacksDir)) fs.mkdirSync(rollbacksDir, { mode: 0o700 });
  const rollbackDirStat = fs.statSync(rollbacksDir);
  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === rollbackDirStat.dev &&
      stat.ino === rollbackDirStat.ino
    ) {
      const markerFiles = fs.readdirSync(rollbacksDir);
      const complete = markerFiles.some((name) => {
        try {
          return readJson(path.join(rollbacksDir, name)).status === 'complete';
        } catch {
          return false;
        }
      });
      if (complete) {
        injected = true;
        const error = new Error('injected rollback-marker fsync failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalFsync(fd);
  };
  let rollback;
  try {
    rollback = rollbackApply(applied.report.receipt.id, applyOptions(applied));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(rollback.success, false);
  assert.equal(rollback.fileResults[0].restored, true);
  assert.match(rollback.notes.join('\n'), /marker replacement committed.*durability/i);
  assert.equal(fs.readFileSync(applied.target, 'utf8'), 'before\n');
});

test('plan-state cache finalization failure preserves the durable receipt and rollback path', (t) => {
  const f = fixture(t, 'gatefile-plan-cache-finalization');
  const target = path.join(f.repoRoot, 'created.txt');
  const plan = approvedPlan(f.repoRoot, [{
    id: 'create', type: 'file', action: 'create', path: target, after: 'created\n'
  }]);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (
      !injected &&
      typeof to === 'string' &&
      to.includes(`${path.sep}plans${path.sep}`)
    ) {
      injected = true;
      const error = new Error('injected plan-state cache publication failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  let report;
  try {
    report = applyPlan(plan, applyOptions(f));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(report.success, false);
  assert.match((report.warnings ?? []).join('\n'), /receipt is durable.*dependency-state cache/i);
  const receipt = readJson(report.receipt.path);
  assert.equal(receipt.success, true);
  assert.equal(receipt.results[0].mutationStatus, 'committed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'created\n');
  assert.equal(rollbackApply(report.receipt.id, applyOptions(f)).success, true);
  assert.equal(fs.existsSync(target), false);
});

test('an undurable visible plan-state cache remains fail-closed for dependents', (t) => {
  const f = fixture(t, 'gatefile-plan-cache-postcommit-deny');
  const target = path.join(f.repoRoot, 'predecessor.txt');
  const dependentTarget = path.join(f.repoRoot, 'dependent.txt');
  const predecessor = approvedPlan(f.repoRoot, [{
    id: 'create-predecessor',
    type: 'file',
    action: 'create',
    path: target,
    after: 'predecessor\n'
  }]);
  const dependent = approvePlan(
    createPlanFromDraft({
      source: 'dependency-durability-test',
      summary: 'Must not run from ambiguous dependency cache state',
      dependsOn: [predecessor.id],
      operations: [{
        id: 'create-dependent',
        type: 'file',
        action: 'create',
        path: dependentTarget,
        after: 'dependent\n'
      }],
      preconditions: [],
      execution: { filePolicy: { allowedRoots: [f.repoRoot] } }
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  let planStateCommitted = false;
  let injected = false;
  fs.renameSync = (from, to) => {
    const result = originalRename(from, to);
    if (
      typeof to === 'string' &&
      to.includes(`${path.sep}plans${path.sep}`) &&
      to.endsWith('.json')
    ) {
      planStateCommitted = true;
    }
    return result;
  };
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (!injected && planStateCommitted && stat.isDirectory()) {
      injected = true;
      const error = new Error('injected plan-state post-commit directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };

  let report;
  try {
    report = applyPlan(predecessor, applyOptions(f));
  } finally {
    fs.renameSync = originalRename;
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(report.success, false);
  assert.match((report.warnings ?? []).join('\n'), /dependency-state cache.*fail-closed/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'predecessor\n');

  const status = dependencyStatus(dependent, applyOptions(f));
  assert.equal(status.allSatisfied, false);
  assert.deepEqual(status.missingPlanIds, [predecessor.id]);
  assert.throws(
    () => applyPlan(dependent, applyOptions(f)),
    /dependencies are not satisfied/i
  );
  assert.equal(fs.existsSync(dependentTarget), false);

  const rollback = rollbackApply(report.receipt.id, applyOptions(f));
  assert.equal(rollback.success, true, rollback.notes.join('\n'));
  const retry = applyPlan(predecessor, applyOptions(f));
  assert.equal(retry.success, true, JSON.stringify(retry, null, 2));
  assert.equal(dependencyStatus(dependent, applyOptions(f)).allSatisfied, true);
});

test('pending-marker unlink ambiguity reports success and remains crash-conservative', (t) => {
  const f = fixture(t, 'gatefile-plan-cache-marker-unlink');
  const target = path.join(f.repoRoot, 'predecessor.txt');
  const dependentTarget = path.join(f.repoRoot, 'dependent.txt');
  const predecessor = approvedPlan(f.repoRoot, [{
    id: 'create-predecessor',
    type: 'file',
    action: 'create',
    path: target,
    after: 'predecessor\n'
  }]);
  const dependent = approvePlan(
    createPlanFromDraft({
      source: 'dependency-marker-cleanup-test',
      summary: 'Conservatively deny if a removed marker reappears after crash',
      dependsOn: [predecessor.id],
      operations: [{
        id: 'create-dependent',
        type: 'file',
        action: 'create',
        path: dependentTarget,
        after: 'dependent\n'
      }],
      preconditions: [],
      execution: { filePolicy: { allowedRoots: [f.repoRoot] } }
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  const originalUnlink = fs.unlinkSync;
  const originalFsync = fs.fsyncSync;
  let markerUnlinked = false;
  let injected = false;
  fs.unlinkSync = (pathname) => {
    const result = originalUnlink(pathname);
    if (typeof pathname === 'string' && pathname.endsWith('.pending')) {
      markerUnlinked = true;
    }
    return result;
  };
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (!injected && markerUnlinked && stat.isDirectory()) {
      injected = true;
      const error = new Error('injected pending-marker unlink fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync(fd);
  };

  let report;
  try {
    report = applyPlan(predecessor, applyOptions(f));
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.equal(report.success, true, JSON.stringify(report, null, 2));
  assert.match(
    (report.warnings ?? []).join('\n'),
    /cache is durable.*marker cleanup durability was not confirmed/i
  );
  assert.equal(dependencyStatus(dependent, applyOptions(f)).allSatisfied, true);

  const plansDir = path.join(path.dirname(path.dirname(report.receipt.path)), 'plans');
  const planStateName = fs.readdirSync(plansDir).find((name) => name.endsWith('.json'));
  assert.ok(planStateName, 'durable plan-state cache must exist');
  const pendingPath = path.join(plansDir, planStateName.replace(/\.json$/, '.pending'));
  fs.writeFileSync(pendingPath, '{}\n', { mode: 0o600, flag: 'wx' });
  assert.equal(
    dependencyStatus(dependent, applyOptions(f)).allSatisfied,
    false,
    'a marker that reappears after crash must conservatively deny dependency state'
  );
});

test('rollback never clears a pending marker bound to a different durable receipt digest', (t) => {
  const f = fixture(t, 'gatefile-plan-cache-repeat-digest');
  const repeatable = approvePlan(
    createPlanFromDraft({
      source: 'repeat-digest-test',
      summary: 'Repeatable command-only plan',
      operations: [{
        id: 'no-op',
        type: 'command',
        executable: process.execPath,
        args: ['-e', '']
      }],
      preconditions: []
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );
  const dependent = approvePlan(
    createPlanFromDraft({
      source: 'repeat-digest-dependent-test',
      summary: 'Depends on the repeatable plan',
      dependsOn: [repeatable.id],
      operations: [{
        id: 'dependent-no-op',
        type: 'command',
        executable: process.execPath,
        args: ['-e', '']
      }],
      preconditions: []
    }, { repoRoot: f.repoRoot }),
    'security-reviewer',
    { repoRoot: f.repoRoot }
  );

  const first = applyPlan(repeatable, applyOptions(f));
  assert.equal(first.success, true);
  assert.equal(dependencyStatus(dependent, applyOptions(f)).allSatisfied, true);

  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (
      !injected &&
      typeof to === 'string' &&
      to.includes(`${path.sep}receipts${path.sep}`)
    ) {
      injected = true;
      const error = new Error('injected repeated-plan final receipt failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  let second;
  try {
    second = applyPlan(repeatable, applyOptions(f));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(second.success, false);
  assert.equal(dependencyStatus(dependent, applyOptions(f)).allSatisfied, false);

  const rollback = rollbackApply(second.receipt.id, applyOptions(f));
  assert.equal(rollback.success, false);
  assert.match(rollback.notes.join('\n'), /marker does not match.*receipt|re-apply remains blocked/i);
  assert.equal(
    dependencyStatus(dependent, applyOptions(f)).allSatisfied,
    false,
    'rollback of the second receipt must not expose the first receipt plan-state cache'
  );
  assert.throws(
    () => applyPlan(repeatable, applyOptions(f)),
    /invalidation marker.*occupied|fail-closed/i
  );
});
