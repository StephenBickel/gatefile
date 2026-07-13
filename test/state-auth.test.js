const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES,
  assertAuthenticatedStatePlatformSupported,
  assertSafeStateId,
  canonicalizeStateJson,
  claimRollbackMarker,
  completeRollbackMarker,
  computeStateDigest,
  createStateRepositoryBinding,
  ensurePrivateStateDirectory,
  getOrCreateStateAuthKey,
  loadStateAuthKey,
  readPrivateStateFile,
  replacePrivateStateFile,
  resolveStateHome,
  rollbackMarkerPath,
  signStateEnvelope,
  stateRecordsRoot,
  writeExclusivePrivateStateFile,
  verifyStateEnvelope
} = require('../dist/state-auth');

test('authenticated state fails closed on Windows until private DACLs are enforced', () => {
  assert.throws(
    () => assertAuthenticatedStatePlatformSupported('win32'),
    /Windows.*fails closed|POSIX permissions/i
  );
  assert.doesNotThrow(() => assertAuthenticatedStatePlatformSupported(process.platform === 'win32' ? 'linux' : process.platform));
});

function makeFixture(t, prefix = 'gatefile-state-auth-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  const stateHome = path.join(root, 'external-state-home');
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repoRoot, stateHome };
}

function mode(pathname) {
  return fs.statSync(pathname).mode & 0o777;
}

test('canonicalizeStateJson is deterministic and rejects non-JSON values', () => {
  const left = {
    z: [3, { beta: true, alpha: null }],
    a: 'value'
  };
  const right = {
    a: 'value',
    z: [3, { alpha: null, beta: true }]
  };

  assert.equal(canonicalizeStateJson(left), canonicalizeStateJson(right));
  assert.equal(
    canonicalizeStateJson(left),
    '{"a":"value","z":[3,{"alpha":null,"beta":true}]}'
  );
  assert.throws(() => canonicalizeStateJson({ missing: undefined }), /undefined|JSON/i);
  assert.throws(() => canonicalizeStateJson(Number.POSITIVE_INFINITY), /finite|JSON/i);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeStateJson(cyclic), /cyclic|cycle/i);
});

test('createStateRepositoryBinding binds repository identity to the canonical root', (t) => {
  const { root, repoRoot } = makeFixture(t);
  const linkRoot = path.join(root, 'repo-link');
  fs.symlinkSync(repoRoot, linkRoot, 'dir');

  const direct = createStateRepositoryBinding(repoRoot, 'git:github.com/acme/widget');
  const throughLink = createStateRepositoryBinding(linkRoot, 'git:github.com/acme/widget');
  const otherIdentity = createStateRepositoryBinding(repoRoot, 'git:github.com/acme/other');

  assert.equal(direct.canonicalRepoRoot, fs.realpathSync(repoRoot));
  assert.equal(throughLink.repoInstanceId, direct.repoInstanceId);
  assert.match(direct.repoInstanceId, /^[a-f0-9]{64}$/);
  assert.notEqual(otherIdentity.repoInstanceId, direct.repoInstanceId);
});

test('repository binding changes when a checkout root is replaced at the same path', (t) => {
  const { repoRoot } = makeFixture(t, 'gatefile-state-auth-replaced-root-');
  const first = createStateRepositoryBinding(repoRoot, 'git:github.com/acme/widget');
  fs.renameSync(repoRoot, `${repoRoot}-replaced`);
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  const replacement = createStateRepositoryBinding(repoRoot, 'git:github.com/acme/widget');

  assert.notEqual(replacement.repoInstanceId, first.repoInstanceId);
});

test('resolveStateHome honors an explicit path before GATEFILE_STATE_HOME', (t) => {
  const { root } = makeFixture(t);
  const explicit = path.join(root, 'explicit');
  const fromEnv = path.join(root, 'from-env');
  const canonicalRoot = fs.realpathSync(root);

  assert.equal(
    resolveStateHome(explicit, { GATEFILE_STATE_HOME: fromEnv }),
    path.join(canonicalRoot, 'explicit')
  );
  assert.equal(
    resolveStateHome(undefined, { GATEFILE_STATE_HOME: fromEnv }),
    path.join(canonicalRoot, 'from-env')
  );
  assert.throws(
    () => resolveStateHome(undefined, { GATEFILE_STATE_HOME: 'relative-state-home' }),
    /absolute/i
  );
});

test('state home rejects a static user-controlled ancestor symlink', (t) => {
  const { root } = makeFixture(t, 'gatefile-state-auth-home-link-');
  const actualParent = path.join(root, 'actual-parent');
  const linkedParent = path.join(root, 'linked-parent');
  fs.mkdirSync(actualParent, { mode: 0o700 });
  fs.symlinkSync(actualParent, linkedParent, 'dir');
  const selectedHome = path.join(linkedParent, 'managed-home');

  assert.throws(
    () => resolveStateHome(selectedHome),
    /symbolic|symlink|ancestor/i
  );
  assert.equal(fs.existsSync(path.join(actualParent, 'managed-home')), false);
});

test('state home rejects a non-sticky group/world-writable ancestor', (t) => {
  const { root } = makeFixture(t, 'gatefile-state-auth-writable-ancestor-');
  const writableParent = path.join(root, 'shared-parent');
  fs.mkdirSync(writableParent, { mode: 0o777 });
  fs.chmodSync(writableParent, 0o777);
  const selectedHome = path.join(writableParent, 'managed-home');

  assert.throws(
    () => resolveStateHome(selectedHome),
    /ancestor.*writable|group.*writable|world.*writable|unsafe.*permission/i
  );
  assert.equal(fs.existsSync(selectedHome), false);
});

test('authenticated state home cannot be placed inside the repository', (t) => {
  const { repoRoot } = makeFixture(t, 'gatefile-state-auth-inside-repo-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:test-repo');
  const insideRepo = path.join(repoRoot, '.gatefile-auth-state');

  assert.throws(
    () => getOrCreateStateAuthKey(binding, insideRepo),
    /state home.*outside.*repository/i
  );
  assert.equal(fs.existsSync(insideRepo), false);
});

test('authenticated state home cannot contain the repository', (t) => {
  const { root, repoRoot } = makeFixture(t, 'gatefile-state-auth-home-ancestor-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:test-repo');

  assert.throws(
    () => getOrCreateStateAuthKey(binding, root),
    /state home.*disjoint.*repository/i
  );
});

test('case aliases cannot place authenticated state inside the repository', (t) => {
  const { repoRoot } = makeFixture(t, 'gatefile-state-auth-case-alias-');
  const basename = path.basename(repoRoot);
  const toggled = basename === basename.toUpperCase() ? basename.toLowerCase() : basename.toUpperCase();
  const alias = path.join(path.dirname(repoRoot), toggled);
  if (
    alias === repoRoot ||
    !fs.existsSync(alias) ||
    fs.realpathSync(alias) !== fs.realpathSync(repoRoot)
  ) {
    t.skip('filesystem is case-sensitive');
    return;
  }

  const binding = createStateRepositoryBinding(repoRoot, 'file:test-repo');
  assert.throws(
    () => getOrCreateStateAuthKey(binding, path.join(alias, 'state-auth')),
    /state home.*repository/i
  );
});

test('external state keys are created once, loadable, and private', (t) => {
  const { repoRoot, stateHome } = makeFixture(t);
  const binding = createStateRepositoryBinding(repoRoot, 'file:test-repo');

  const first = getOrCreateStateAuthKey(binding, stateHome);
  const second = getOrCreateStateAuthKey(binding, stateHome);
  const loaded = loadStateAuthKey(binding, first.keyId, stateHome);

  assert.match(first.keyId, /^[a-f0-9]{64}$/);
  assert.equal(first.keyBytes.length, 32);
  assert.deepEqual(second.keyBytes, first.keyBytes);
  assert.deepEqual(loaded.keyBytes, first.keyBytes);
  assert.equal(first.keyPath.startsWith(path.resolve(repoRoot) + path.sep), false);
  assert.equal(first.keyPath.startsWith(resolveStateHome(stateHome) + path.sep), true);
  if (process.platform !== 'win32') {
    assert.equal(mode(first.keyPath), 0o600);
    assert.equal(mode(path.dirname(first.keyPath)), 0o700);
    assert.equal(mode(path.dirname(path.dirname(first.keyPath))), 0o700);
    assert.equal(mode(path.resolve(stateHome)), 0o700);
  }
});

test('key loading rejects missing, symlinked, and overly permissive key files', (t) => {
  const missingFixture = makeFixture(t, 'gatefile-state-auth-missing-');
  const missingBinding = createStateRepositoryBinding(
    missingFixture.repoRoot,
    'file:missing-key-repo'
  );
  assert.throws(
    () => loadStateAuthKey(missingBinding, 'a'.repeat(64), missingFixture.stateHome),
    /missing|not found|ENOENT/i
  );
  assert.equal(fs.existsSync(missingFixture.stateHome), false, 'verification must not create state');

  const symlinkFixture = makeFixture(t, 'gatefile-state-auth-symlink-');
  const symlinkBinding = createStateRepositoryBinding(
    symlinkFixture.repoRoot,
    'file:symlink-key-repo'
  );
  const symlinkKey = getOrCreateStateAuthKey(symlinkBinding, symlinkFixture.stateHome);
  const keyBackup = path.join(symlinkFixture.root, 'key-backup');
  fs.writeFileSync(keyBackup, symlinkKey.keyBytes, { mode: 0o600 });
  fs.unlinkSync(symlinkKey.keyPath);
  fs.symlinkSync(keyBackup, symlinkKey.keyPath);
  assert.throws(
    () => loadStateAuthKey(symlinkBinding, symlinkKey.keyId, symlinkFixture.stateHome),
    /symbolic|symlink|no.?follow|ELOOP/i
  );

  const modeFixture = makeFixture(t, 'gatefile-state-auth-mode-');
  const modeBinding = createStateRepositoryBinding(modeFixture.repoRoot, 'file:mode-key-repo');
  const permissive = getOrCreateStateAuthKey(modeBinding, modeFixture.stateHome);
  if (process.platform !== 'win32') {
    fs.chmodSync(permissive.keyPath, 0o644);
    assert.throws(
      () => loadStateAuthKey(modeBinding, permissive.keyId, modeFixture.stateHome),
      /permission|mode|private/i
    );
  }
});

test('key loading rejects extended ACLs on private state files', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS ACL semantics');
    return;
  }

  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-state-auth-key-acl-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:key-acl-repo');
  const key = getOrCreateStateAuthKey(binding, stateHome);
  require('node:child_process').execFileSync(
    '/bin/chmod',
    ['+a', 'everyone allow read', key.keyPath]
  );

  assert.throws(
    () => loadStateAuthKey(binding, key.keyId, stateHome),
    /extended ACL/i
  );
});

test('key loading rejects extended ACLs on managed state directories', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS ACL semantics');
    return;
  }

  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-state-auth-directory-acl-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:directory-acl-repo');
  const key = getOrCreateStateAuthKey(binding, stateHome);
  require('node:child_process').execFileSync(
    '/bin/chmod',
    ['+a', 'everyone allow read', stateHome]
  );

  assert.throws(
    () => loadStateAuthKey(binding, key.keyId, stateHome),
    /extended ACL/i
  );
});

test('private state reads reject extended ACLs on their containing directory', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS ACL semantics');
    return;
  }

  const { root } = makeFixture(t, 'gatefile-state-auth-record-directory-acl-');
  const recordsDir = path.join(root, 'private-records');
  const recordPath = path.join(recordsDir, 'receipt.json');
  fs.mkdirSync(recordsDir, { mode: 0o700 });
  fs.writeFileSync(recordPath, '{}\n', { mode: 0o600 });
  require('node:child_process').execFileSync(
    '/bin/chmod',
    ['+a', 'everyone allow read', recordsDir]
  );

  assert.throws(
    () => readPrivateStateFile(recordPath),
    /extended ACL/i
  );
});

test('private state replacement fails closed when directory fsync is unsupported', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX directory durability semantics');
    return;
  }

  const { root } = makeFixture(t, 'gatefile-state-auth-directory-fsync-');
  const recordsDir = path.join(root, 'private-records');
  const recordPath = path.join(recordsDir, 'receipt.json');
  fs.mkdirSync(recordsDir, { mode: 0o700 });
  fs.writeFileSync(recordPath, 'before\n', { mode: 0o600 });
  const recordsStat = fs.statSync(recordsDir);
  const originalFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (
      !injected &&
      stat.isDirectory() &&
      stat.dev === recordsStat.dev &&
      stat.ino === recordsStat.ino &&
      fs.readFileSync(recordPath, 'utf8') === 'after\n'
    ) {
      injected = true;
      const error = new Error('directory fsync unsupported');
      error.code = 'EINVAL';
      throw error;
    }
    return originalFsync(fd);
  };

  try {
    assert.throws(
      () => replacePrivateStateFile(recordPath, 'after\n'),
      /committed.*durability|finalization.*failed|fsync unsupported/i
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), 'after\n');
});

test('state HMACs and digests are domain separated and tamper evident', (t) => {
  const { repoRoot, stateHome } = makeFixture(t);
  const binding = createStateRepositoryBinding(repoRoot, 'file:hmac-repo');
  const key = getOrCreateStateAuthKey(binding, stateHome);
  const body = {
    type: 'gatefile-rollback-snapshot',
    stateVersion: 1,
    plan: { id: 'plan_1', hash: 'b'.repeat(64) },
    files: [{ id: 'entry_1', before: 'before' }]
  };

  const auth = signStateEnvelope('snapshot', body, key);
  assert.equal(auth.scheme, 'hmac-sha256');
  assert.equal(auth.envelopeVersion, 1);
  assert.equal(auth.keyId, key.keyId);
  assert.match(auth.tag, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotThrow(() => verifyStateEnvelope('snapshot', body, auth, key));
  assert.throws(
    () => verifyStateEnvelope('snapshot', { ...body, stateVersion: 2 }, auth, key),
    /authentication|HMAC|tag/i
  );
  assert.throws(
    () => verifyStateEnvelope('receipt', body, auth, key),
    /authentication|HMAC|tag/i
  );

  const snapshotDigest = computeStateDigest('snapshot', body);
  const sameDigest = computeStateDigest('snapshot', {
    files: body.files,
    plan: body.plan,
    stateVersion: 1,
    type: body.type
  });
  assert.match(snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(sameDigest, snapshotDigest);
  assert.notEqual(computeStateDigest('receipt', body), snapshotDigest);
});

test('safe state IDs reject traversal, separators, dots, and excessive length', () => {
  assert.equal(assertSafeStateId('apply_2026-07-13T01-02-03Z_ab-CD_12'), 'apply_2026-07-13T01-02-03Z_ab-CD_12');
  for (const value of ['../receipt', '..', 'a/b', 'a\\b', '.hidden', '', 'a'.repeat(129)]) {
    assert.throws(() => assertSafeStateId(value), /safe state ID|invalid state ID/i, value);
  }
});

test('rollback marker claim is exclusive and completion is authenticated', (t) => {
  const { repoRoot, stateHome } = makeFixture(t);
  const binding = createStateRepositoryBinding(repoRoot, 'file:marker-repo');
  const key = getOrCreateStateAuthKey(binding, stateHome);
  const receiptId = 'apply_2026-07-13_marker';
  const receiptDigest = computeStateDigest('receipt', {
    id: receiptId,
    planId: 'plan_marker'
  });

  const claimed = claimRollbackMarker(binding, receiptId, receiptDigest, key, stateHome);
  assert.equal(claimed.marker.status, 'claimed');
  assert.equal(claimed.path, rollbackMarkerPath(binding, receiptId, stateHome));
  assert.equal(fs.existsSync(claimed.path), true);
  assert.throws(
    () => claimRollbackMarker(binding, receiptId, receiptDigest, key, stateHome),
    /already.*claimed|replay/i
  );

  const completed = completeRollbackMarker(binding, receiptId, receiptDigest, key, stateHome);
  assert.equal(completed.marker.status, 'complete');
  assert.equal(completed.marker.receiptDigest, receiptDigest);
  assert.equal(typeof completed.marker.completedAt, 'string');
  const persisted = JSON.parse(fs.readFileSync(completed.path, 'utf8'));
  assert.equal(persisted.status, 'complete');
  assert.throws(
    () => completeRollbackMarker(binding, receiptId, receiptDigest, key, stateHome),
    /already.*complete|not claimed/i
  );
});

test('tampered rollback markers cannot be completed', (t) => {
  const { repoRoot, stateHome } = makeFixture(t);
  const binding = createStateRepositoryBinding(repoRoot, 'file:tampered-marker-repo');
  const key = getOrCreateStateAuthKey(binding, stateHome);
  const receiptId = 'apply_tampered_marker';
  const receiptDigest = 'c'.repeat(64);
  const claim = claimRollbackMarker(binding, receiptId, receiptDigest, key, stateHome);
  const tampered = JSON.parse(fs.readFileSync(claim.path, 'utf8'));
  tampered.receiptDigest = 'd'.repeat(64);
  fs.writeFileSync(claim.path, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

  assert.throws(
    () => completeRollbackMarker(binding, receiptId, receiptDigest, key, stateHome),
    /authentication|HMAC|tag/i
  );
});

test('private state directories are confined beneath the per-repository records root', (t) => {
  const { root, repoRoot, stateHome } = makeFixture(t, 'gatefile-state-records-dir-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:state-records-dir-repo');
  getOrCreateStateAuthKey(binding, stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  const nested = path.join(recordsRoot, 'receipts', '2026');

  assert.equal(ensurePrivateStateDirectory(recordsRoot, nested), nested);
  assert.equal(recordsRoot.startsWith(path.resolve(repoRoot) + path.sep), false);
  if (process.platform !== 'win32') {
    assert.equal(mode(recordsRoot), 0o700);
    assert.equal(mode(path.join(recordsRoot, 'receipts')), 0o700);
    assert.equal(mode(nested), 0o700);
  }

  const escaped = path.join(recordsRoot, '..', 'escaped');
  assert.throws(
    () => ensurePrivateStateDirectory(recordsRoot, escaped),
    /outside|contain|records root/i
  );
  assert.equal(fs.existsSync(path.join(path.dirname(recordsRoot), 'escaped')), false);

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  const linkedSegment = path.join(recordsRoot, 'linked');
  fs.symlinkSync(outside, linkedSegment, 'dir');
  assert.throws(
    () => ensurePrivateStateDirectory(recordsRoot, path.join(linkedSegment, 'child')),
    /symbolic|symlink/i
  );
  assert.equal(fs.existsSync(path.join(outside, 'child')), false);
});

test('private state files support bounded no-clobber writes, reads, and atomic replacement', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-state-records-file-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:state-records-file-repo');
  getOrCreateStateAuthKey(binding, stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  const receipts = path.join(recordsRoot, 'receipts');
  ensurePrivateStateDirectory(recordsRoot, receipts);
  const receiptPath = path.join(receipts, 'receipt.json');

  writeExclusivePrivateStateFile(receiptPath, Buffer.from('first', 'utf8'));
  assert.equal(readPrivateStateFile(receiptPath).toString('utf8'), 'first');
  if (process.platform !== 'win32') assert.equal(mode(receiptPath), 0o600);

  assert.throws(
    () => writeExclusivePrivateStateFile(receiptPath, Buffer.from('clobber', 'utf8')),
    /EEXIST|exist|clobber/i
  );
  assert.equal(readPrivateStateFile(receiptPath).toString('utf8'), 'first');
  assert.deepEqual(fs.readdirSync(receipts), ['receipt.json']);

  const staleTemp = path.join(receipts, `.receipt.json.4242.${'a'.repeat(24)}.tmp`);
  fs.linkSync(receiptPath, staleTemp);
  assert.equal(fs.statSync(receiptPath).nlink, 2);
  assert.equal(readPrivateStateFile(receiptPath).toString('utf8'), 'first');
  assert.equal(fs.existsSync(staleTemp), false);
  assert.equal(fs.statSync(receiptPath).nlink, 1);

  replacePrivateStateFile(receiptPath, Buffer.from('replacement', 'utf8'));
  assert.equal(readPrivateStateFile(receiptPath).toString('utf8'), 'replacement');
  if (process.platform !== 'win32') assert.equal(mode(receiptPath), 0o600);
  assert.deepEqual(fs.readdirSync(receipts), ['receipt.json']);

  const newlyReplaced = path.join(receipts, 'new-state.json');
  replacePrivateStateFile(newlyReplaced, Buffer.from('created atomically', 'utf8'));
  assert.equal(readPrivateStateFile(newlyReplaced).toString('utf8'), 'created atomically');
  assert.deepEqual(fs.readdirSync(receipts).sort(), ['new-state.json', 'receipt.json']);
});

test('private state reads reject symlinks, non-regular files, oversized files, and unsafe modes', (t) => {
  const { root, repoRoot, stateHome } = makeFixture(t, 'gatefile-state-records-read-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:state-records-read-repo');
  getOrCreateStateAuthKey(binding, stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  ensurePrivateStateDirectory(recordsRoot, recordsRoot);

  const regular = path.join(recordsRoot, 'regular.json');
  writeExclusivePrivateStateFile(regular, Buffer.from('0123456789abcdefg', 'utf8'));
  assert.throws(() => readPrivateStateFile(regular, 16), /size|large|limit|16/i);
  assert.equal(readPrivateStateFile(regular, 17).length, 17);

  const linked = path.join(recordsRoot, 'linked.json');
  fs.symlinkSync(regular, linked);
  assert.throws(() => readPrivateStateFile(linked), /symbolic|symlink|no.?follow|ELOOP/i);

  const directory = path.join(recordsRoot, 'directory.json');
  ensurePrivateStateDirectory(recordsRoot, directory);
  assert.throws(() => readPrivateStateFile(directory), /regular file/i);

  if (process.platform !== 'win32') {
    const permissive = path.join(recordsRoot, 'permissive.json');
    writeExclusivePrivateStateFile(permissive, Buffer.from('private', 'utf8'));
    fs.chmodSync(permissive, 0o644);
    assert.throws(() => readPrivateStateFile(permissive), /permission|mode|private/i);
  }

  const outsideTarget = path.join(root, 'outside-target');
  fs.writeFileSync(outsideTarget, 'outside', { mode: 0o600 });
  const hardLinked = path.join(recordsRoot, 'hard-linked.json');
  fs.linkSync(outsideTarget, hardLinked);
  assert.throws(() => readPrivateStateFile(hardLinked), /hard-link|link count/i);
  assert.equal(fs.existsSync(hardLinked), true, 'unknown hardlinks must not be removed');
});

test('private state write failures leave no temporary files', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-state-records-temp-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:state-records-temp-repo');
  getOrCreateStateAuthKey(binding, stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  ensurePrivateStateDirectory(recordsRoot, recordsRoot);

  const existing = path.join(recordsRoot, 'existing.json');
  writeExclusivePrivateStateFile(existing, Buffer.from('original', 'utf8'));
  assert.throws(
    () => writeExclusivePrivateStateFile(existing, Buffer.from('second', 'utf8')),
    /EEXIST|exist|clobber/i
  );
  assert.deepEqual(fs.readdirSync(recordsRoot), ['existing.json']);

  const destinationDirectory = path.join(recordsRoot, 'destination.json');
  ensurePrivateStateDirectory(recordsRoot, destinationDirectory);
  assert.throws(
    () => replacePrivateStateFile(destinationDirectory, Buffer.from('not-a-directory', 'utf8')),
    /regular file|directory/i
  );
  assert.deepEqual(fs.readdirSync(recordsRoot).sort(), ['destination.json', 'existing.json']);
});

test('private state writes reject values larger than the exported read limit without residue', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-state-records-size-');
  const binding = createStateRepositoryBinding(repoRoot, 'file:state-records-size-repo');
  getOrCreateStateAuthKey(binding, stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  ensurePrivateStateDirectory(recordsRoot, recordsRoot);
  const oversized = Buffer.alloc(DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES + 1);

  assert.throws(
    () => writeExclusivePrivateStateFile(path.join(recordsRoot, 'exclusive.bin'), oversized),
    /size|large|limit/i
  );
  assert.throws(
    () => replacePrivateStateFile(path.join(recordsRoot, 'replace.bin'), oversized),
    /size|large|limit/i
  );
  assert.deepEqual(fs.readdirSync(recordsRoot), []);
});
