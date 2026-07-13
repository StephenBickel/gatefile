const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  SAFE_FS_CONCURRENT_NAMESPACE_LIMITATION,
  captureCompactCurrentState,
  createSafeFsContext,
  preflightFileOperations,
  resolveSafeTarget,
  safeCreate,
  safeDelete,
  safeRestore,
  safeUpdate
} = require('../dist/safe-fs');

function tempRoot(t, prefix = 'gatefile-safe-fs-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createOp(id, filePath, after = 'created\n') {
  return { id, type: 'file', action: 'create', path: filePath, after };
}

function updateOp(id, filePath, before = 'before\n', after = 'after\n') {
  return { id, type: 'file', action: 'update', path: filePath, before, after };
}

function deleteOp(id, filePath, before = 'before\n') {
  return { id, type: 'file', action: 'delete', path: filePath, before };
}

test('relative roots and targets are anchored to repoRoot and require existing parents', (t) => {
  const repoRoot = tempRoot(t);
  fs.mkdirSync(path.join(repoRoot, 'allowed'));
  const context = createSafeFsContext(repoRoot, ['allowed']);
  assert.throws(
    () => resolveSafeTarget(context, 'allowed/a/b/file.txt', 'create'),
    /parent does not exist/i
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'allowed/a')), false);
  fs.mkdirSync(path.join(repoRoot, 'allowed/a/b'), { recursive: true });
  const target = resolveSafeTarget(context, 'allowed/a/b/file.txt', 'create');

  assert.equal(target.targetPath, path.join(fs.realpathSync(repoRoot), 'allowed/a/b/file.txt'));
  assert.equal(target.allowedRoot, fs.realpathSync(path.join(repoRoot, 'allowed')));
  assert.equal(target.relativePath, path.join('a', 'b', 'file.txt'));
  assert.equal(target.requestedPath, 'allowed/a/b/file.txt');
  assert.deepEqual(
    target.directoryChain.map((entry) => entry.relativePath),
    ['', 'a', path.join('a', 'b')]
  );
});

test('repo roots and declared allowed roots may not themselves be symlinks', (t) => {
  const base = tempRoot(t);
  const realRepo = path.join(base, 'real-repo');
  const linkedRepo = path.join(base, 'linked-repo');
  fs.mkdirSync(realRepo);
  fs.symlinkSync(realRepo, linkedRepo);

  assert.throws(() => createSafeFsContext(linkedRepo), /repo root.*symbolic link/i);

  const realAllowed = path.join(realRepo, 'real-allowed');
  const linkedAllowed = path.join(realRepo, 'linked-allowed');
  fs.mkdirSync(realAllowed);
  fs.symlinkSync(realAllowed, linkedAllowed);
  assert.throws(
    () => createSafeFsContext(realRepo, [linkedAllowed]),
    /allowed root.*symbolic link/i
  );
});

test('ancestor and final symlinks are rejected without touching their targets', (t) => {
  const base = tempRoot(t);
  const repoRoot = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(outside);
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'before\n');
  fs.symlinkSync(outside, path.join(repoRoot, 'ancestor-link'));
  fs.symlinkSync(victim, path.join(repoRoot, 'final-link'));
  const context = createSafeFsContext(repoRoot);

  assert.throws(
    () => resolveSafeTarget(context, path.join(repoRoot, 'ancestor-link/victim.txt'), 'update'),
    /ancestor.*symbolic link/i
  );
  assert.throws(
    () => resolveSafeTarget(context, path.join(repoRoot, 'final-link'), 'update'),
    /target.*symbolic link/i
  );
  assert.throws(
    () => resolveSafeTarget(context, path.join(repoRoot, 'final-link'), 'create'),
    /target.*symbolic link|already exists/i
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'before\n');
});

test('Gatefile state storage is reserved even when it does not exist yet', (t) => {
  const repoRoot = tempRoot(t);
  const context = createSafeFsContext(repoRoot);

  assert.throws(
    () =>
      resolveSafeTarget(context, path.join(repoRoot, '.gatefile/state/receipt.json'), 'create'),
    /reserved.*\.gatefile.*state/i
  );
  assert.equal(fs.existsSync(path.join(repoRoot, '.gatefile')), false);
});

test('preflight rejects canonical duplicate and ancestor-overlap targets before creating parents', (t) => {
  const repoRoot = tempRoot(t);
  const context = createSafeFsContext(repoRoot);

  assert.throws(
    () =>
      preflightFileOperations(context, [
        createOp('one', path.join(repoRoot, 'dir/../same.txt')),
        createOp('two', path.join(repoRoot, 'same.txt'))
      ]),
    /duplicate.*target/i
  );

  assert.throws(
    () =>
      preflightFileOperations(context, [
        createOp('parent', path.join(repoRoot, 'tree')),
        createOp('child', path.join(repoRoot, 'tree/child.txt'))
      ]),
    /overlap.*target/i
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'tree')), false);
});

test('preflight rejects case aliases of the same existing target', (t) => {
  const repoRoot = tempRoot(t, 'gatefile-safe-fs-case-existing-');
  const mixedCase = path.join(repoRoot, 'ManagedCase.txt');
  const foldedCase = path.join(repoRoot, 'managedcase.txt');
  fs.writeFileSync(mixedCase, 'before\n');
  if (
    !fs.existsSync(foldedCase) ||
    fs.statSync(mixedCase).ino !== fs.statSync(foldedCase).ino
  ) {
    t.skip('filesystem is case-sensitive');
    return;
  }

  const context = createSafeFsContext(repoRoot);
  assert.throws(
    () => preflightFileOperations(context, [
      updateOp('mixed-case', mixedCase),
      updateOp('folded-case', foldedCase)
    ]),
    /duplicate.*target|case.*alias/i
  );
});

test('preflight rejects case aliases of the same absent create target', (t) => {
  const repoRoot = tempRoot(t, 'gatefile-safe-fs-case-create-');
  const probe = path.join(repoRoot, 'CaseProbe');
  const probeAlias = path.join(repoRoot, 'caseprobe');
  fs.writeFileSync(probe, 'probe\n');
  const caseInsensitive =
    fs.existsSync(probeAlias) && fs.statSync(probe).ino === fs.statSync(probeAlias).ino;
  fs.unlinkSync(probe);
  if (!caseInsensitive) {
    t.skip('filesystem is case-sensitive');
    return;
  }

  const context = createSafeFsContext(repoRoot);
  assert.throws(
    () => preflightFileOperations(context, [
      createOp('mixed-case', path.join(repoRoot, 'NewCaseTarget.txt')),
      createOp('folded-case', path.join(repoRoot, 'newcasetarget.txt'))
    ]),
    /duplicate.*target|case.*alias/i
  );
});

test('safe update fails exact drift and leaves the drifted file unchanged', (t) => {
  const repoRoot = tempRoot(t);
  const filePath = path.join(repoRoot, 'update.txt');
  fs.writeFileSync(filePath, 'before\n');
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [updateOp('update', filePath)]);

  fs.writeFileSync(filePath, 'unreviewed\n');
  assert.throws(
    () => safeUpdate(context, prepared.target, prepared.beforeState, 'after\n'),
    /drift|no longer matches/i
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'unreviewed\n');
});

test('atomic update replaces only the reviewed hardlink and preserves its mode', (t) => {
  const base = tempRoot(t);
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot);
  const peer = path.join(base, 'outside-peer.txt');
  const targetPath = path.join(repoRoot, 'target.txt');
  fs.writeFileSync(peer, 'before\n');
  fs.chmodSync(peer, 0o640);
  fs.linkSync(peer, targetPath);
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [updateOp('update', targetPath)]);

  const afterState = safeUpdate(context, prepared.target, prepared.beforeState, 'after\n');

  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(peer, 'utf8'), 'before\n');
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640);
  assert.equal(afterState.afterState.kind, 'regular');
  assert.equal(
    afterState.afterState.sha256,
    captureCompactCurrentState(context, prepared.target).sha256
  );
});

test('safe create is exclusive and safe delete requires the captured identity and bytes', (t) => {
  const repoRoot = tempRoot(t);
  const context = createSafeFsContext(repoRoot);
  const createPath = path.join(repoRoot, 'new.txt');
  const [preparedCreate] = preflightFileOperations(context, [createOp('create', createPath)]);
  const created = safeCreate(context, preparedCreate.target, preparedCreate.beforeState, 'created\n');
  assert.equal(created.afterState.kind, 'regular');
  assert.equal(fs.readFileSync(createPath, 'utf8'), 'created\n');
  assert.throws(
    () => safeCreate(context, preparedCreate.target, preparedCreate.beforeState, 'replace\n'),
    /exists|drift/i
  );

  const [preparedDelete] = preflightFileOperations(context, [
    deleteOp('delete', createPath, 'created\n')
  ]);
  fs.writeFileSync(createPath, 'changed\n');
  assert.throws(
    () => safeDelete(context, preparedDelete.target, preparedDelete.beforeState),
    /drift|no longer matches/i
  );
  assert.equal(fs.readFileSync(createPath, 'utf8'), 'changed\n');
});

test('safe restore requires exact post-state and restores reviewed bytes and mode', (t) => {
  const repoRoot = tempRoot(t);
  const targetPath = path.join(repoRoot, 'restore.txt');
  fs.writeFileSync(targetPath, 'before\n');
  fs.chmodSync(targetPath, 0o600);
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [updateOp('update', targetPath)]);
  const appliedState = safeUpdate(
    context,
    prepared.target,
    prepared.beforeState,
    'after\n'
  ).afterState;

  fs.chmodSync(targetPath, 0o644);
  assert.throws(
    () => safeRestore(context, prepared.target, appliedState, prepared.beforeState),
    /rollback drift|expected current state/i
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'after\n');

  fs.chmodSync(targetPath, 0o600);
  const refreshedAppliedState = captureCompactCurrentState(context, prepared.target);
  const restored = safeRestore(
    context,
    prepared.target,
    refreshedAppliedState,
    prepared.beforeState
  );
  assert.equal(restored.kind, 'regular');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'before\n');
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);
});

test('safe restore refuses a missing captured parent and does not recreate it', (t) => {
  const repoRoot = tempRoot(t);
  const parent = path.join(repoRoot, 'nested');
  const targetPath = path.join(parent, 'deleted.txt');
  fs.mkdirSync(parent);
  fs.writeFileSync(targetPath, 'before\n');
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [deleteOp('delete', targetPath)]);
  const absent = safeDelete(context, prepared.target, prepared.beforeState).afterState;
  fs.rmdirSync(parent);

  assert.throws(
    () => safeRestore(context, prepared.target, absent, prepared.beforeState),
    /rollback drift|parent does not exist|directory chain/i
  );
  assert.equal(fs.existsSync(parent), false);
  assert.equal(fs.existsSync(targetPath), false);
});

test('allowed roots and every existing directory below them reject group/world writers', (t) => {
  const base = tempRoot(t);
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.chmodSync(repoRoot, 0o777);
  assert.throws(
    () => createSafeFsContext(repoRoot),
    /group\/world-writable|concurrent namespace writer/i
  );

  fs.chmodSync(repoRoot, 0o700);
  const writableAncestor = path.join(repoRoot, 'writable');
  fs.mkdirSync(writableAncestor, { mode: 0o777 });
  fs.chmodSync(writableAncestor, 0o777);
  const context = createSafeFsContext(repoRoot);
  assert.throws(
    () => resolveSafeTarget(context, path.join(writableAncestor, 'target.txt'), 'create'),
    /group\/world-writable|concurrent namespace writer/i
  );
  assert.match(SAFE_FS_CONCURRENT_NAMESPACE_LIMITATION, /concurrent.*same.*identity|same.*user/i);
});

test('exact state captures ownership and atomic update preserves uid gid and set-id mode bits', (t) => {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    t.skip('POSIX ownership APIs are unavailable');
    return;
  }
  const repoRoot = tempRoot(t);
  const targetPath = path.join(repoRoot, 'metadata.txt');
  fs.writeFileSync(targetPath, 'before\n');
  fs.chownSync(targetPath, process.getuid(), process.getgid());
  fs.chmodSync(targetPath, 0o6750);
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [updateOp('metadata', targetPath)]);

  assert.equal(prepared.beforeState.kind, 'regular');
  assert.equal(prepared.beforeState.uid, String(process.getuid()));
  assert.equal(prepared.beforeState.gid, String(process.getgid()));
  assert.equal(prepared.beforeState.mode, 0o6750);

  const applied = safeUpdate(context, prepared.target, prepared.beforeState, 'after\n');
  const stat = fs.statSync(targetPath);
  assert.equal(applied.afterState.uid, String(process.getuid()));
  assert.equal(applied.afterState.gid, String(process.getgid()));
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.gid, process.getgid());
  assert.equal(stat.mode & 0o7777, 0o6750);
});

test('restore metadata failure happens while staging and leaves the current target untouched', (t) => {
  if (typeof process.getuid !== 'function') {
    t.skip('POSIX ownership APIs are unavailable');
    return;
  }
  const repoRoot = tempRoot(t);
  const targetPath = path.join(repoRoot, 'precommit.txt');
  fs.writeFileSync(targetPath, 'current\n');
  const context = createSafeFsContext(repoRoot);
  const [prepared] = preflightFileOperations(context, [
    updateOp('precommit', targetPath, 'current\n', 'applied\n')
  ]);
  const current = captureCompactCurrentState(context, prepared.target);
  const impossibleRestore = {
    ...prepared.beforeState,
    content: Buffer.from('restored\n'),
    sha256: require('node:crypto').createHash('sha256').update('restored\n').digest('hex'),
    byteLength: Buffer.byteLength('restored\n'),
    uid: String(Number.MAX_SAFE_INTEGER),
    gid: String(Number.MAX_SAFE_INTEGER)
  };

  assert.throws(
    () => safeRestore(context, prepared.target, current, impossibleRestore),
    /chown|operation not permitted|metadata/i
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'current\n');
  assert.equal(
    fs.readdirSync(repoRoot).some((name) => name.includes('.gatefile-') && name.endsWith('.tmp')),
    false
  );
});

test('macOS extended directory ACLs are rejected as namespace writers', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS ACL semantics');
    return;
  }
  const repoRoot = tempRoot(t);
  const ancestor = path.join(repoRoot, 'acl-writable');
  fs.mkdirSync(ancestor, { mode: 0o700 });
  execFileSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', ancestor]);
  const context = createSafeFsContext(repoRoot);

  assert.throws(
    () => resolveSafeTarget(context, path.join(ancestor, 'target.txt'), 'create'),
    /extended ACL/i
  );
  assert.equal(fs.existsSync(path.join(ancestor, 'target.txt')), false);
});

test('macOS target ACLs and security-sensitive xattrs fail closed before replacement', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS ACL and xattr semantics');
    return;
  }
  const repoRoot = tempRoot(t);
  const aclTarget = path.join(repoRoot, 'acl-target.txt');
  fs.writeFileSync(aclTarget, 'before\n');
  execFileSync('/bin/chmod', ['+a', 'everyone allow write', aclTarget]);
  const context = createSafeFsContext(repoRoot);
  assert.throws(
    () => preflightFileOperations(context, [updateOp('acl', aclTarget)]),
    /extended ACL/i
  );
  assert.equal(fs.readFileSync(aclTarget, 'utf8'), 'before\n');

  const xattrTarget = path.join(repoRoot, 'quarantined-target.txt');
  fs.writeFileSync(xattrTarget, 'before\n');
  execFileSync('/usr/bin/xattr', [
    '-w',
    'com.apple.quarantine',
    '0081;00000000;GatefileTest;',
    xattrTarget
  ]);
  assert.throws(
    () => preflightFileOperations(context, [updateOp('xattr', xattrTarget)]),
    /extended attributes.*cannot preserve|quarantine/i
  );
  assert.equal(fs.readFileSync(xattrTarget, 'utf8'), 'before\n');
  assert.match(execFileSync('/usr/bin/xattr', [xattrTarget], { encoding: 'utf8' }), /com\.apple\.quarantine/);
});
