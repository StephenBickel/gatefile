const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  platformAliasTarget,
  readUtf8Artifact,
  readJsonArtifact,
  writeUtf8ArtifactAtomic,
  writeJsonArtifactAtomic
} = require('../dist/artifact-io');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-artifact-io-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('artifact reads return a stable revision and parsed JSON', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'plan.json');
  fs.writeFileSync(target, '{"status":"pending"}\n', { mode: 0o640 });

  const raw = readUtf8Artifact(target, { label: 'plan' });
  const parsed = readJsonArtifact(target, { label: 'plan' });

  assert.equal(raw.contents, '{"status":"pending"}\n');
  assert.equal(parsed.value.status, 'pending');
  assert.equal(raw.absolutePath, fs.realpathSync(target));
  assert.match(raw.revision.inode, /^\d+$/);
  assert.match(raw.revision.parentInode, /^\d+$/);
});

test('artifact reads reject symlinks, hard links, special files, and oversized input', (t) => {
  const root = fixture(t);
  const regular = path.join(root, 'regular.json');
  const symlink = path.join(root, 'symlink.json');
  const hardlink = path.join(root, 'hardlink.json');
  const directory = path.join(root, 'directory.json');
  const oversized = path.join(root, 'oversized.json');
  fs.writeFileSync(regular, '{}\n');
  fs.symlinkSync(regular, symlink);
  fs.linkSync(regular, hardlink);
  fs.mkdirSync(directory);
  fs.writeFileSync(oversized, '{"payload":"0123456789"}\n');

  assert.throws(() => readUtf8Artifact(symlink), /symbolic link/i);
  assert.throws(() => readUtf8Artifact(regular), /multiple hard links/i);
  assert.throws(() => readUtf8Artifact(directory), /regular file/i);
  assert.throws(
    () => readUtf8Artifact(oversized, { maxBytes: 8, label: 'small input' }),
    /8-byte read limit/i
  );
});

test('artifact reads remain bounded when the file grows during the read', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'growing.json');
  fs.writeFileSync(target, '{}\n');

  const originalRead = fs.readSync;
  let injected = false;
  fs.readSync = (...args) => {
    if (!injected) {
      injected = true;
      fs.appendFileSync(target, Buffer.alloc(1024, 0x20));
    }
    return originalRead(...args);
  };
  try {
    assert.throws(
      () => readUtf8Artifact(target, { maxBytes: 4, label: 'growing input' }),
      /changed while it was being read/i
    );
  } finally {
    fs.readSync = originalRead;
  }
});

test('artifact reads and writes reject symlinks in parent components', (t) => {
  const root = fixture(t);
  const outside = path.join(root, 'outside');
  const linkedParent = path.join(root, 'linked-parent');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'plan.json'), '{}\n');
  fs.symlinkSync(outside, linkedParent);

  assert.throws(
    () => readJsonArtifact(path.join(linkedParent, 'plan.json')),
    /parent contains a symbolic link/i
  );
  assert.throws(
    () => writeJsonArtifactAtomic(path.join(linkedParent, 'created.json'), { unsafe: true }),
    /parent contains a symbolic link/i
  );
  assert.equal(fs.existsSync(path.join(outside, 'created.json')), false);
});

test('platform aliases are exact and independent of repository ownership', () => {
  for (const [alias, target] of [
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
    ['/etc', '/private/etc']
  ]) {
    assert.equal(platformAliasTarget(alias, 'darwin'), target);
  }
  assert.equal(platformAliasTarget('/workspace/.plan', 'darwin'), undefined);
  assert.equal(platformAliasTarget('/workspace/.plan', 'linux'), undefined);
  assert.equal(platformAliasTarget('/var', 'linux'), undefined);
});

test('create-only atomic writes refuse existing and symlink destinations', (t) => {
  const root = fixture(t);
  const existing = path.join(root, 'existing.txt');
  const victim = path.join(root, 'victim.txt');
  const symlink = path.join(root, 'output.txt');
  fs.writeFileSync(existing, 'keep-existing\n');
  fs.writeFileSync(victim, 'keep-victim\n');
  fs.symlinkSync(victim, symlink);

  assert.throws(
    () => writeUtf8ArtifactAtomic(existing, 'replace\n'),
    /create-only destination already exists/i
  );
  assert.throws(
    () => writeUtf8ArtifactAtomic(symlink, 'replace\n'),
    /symbolic link|create-only destination already exists/i
  );
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep-existing\n');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep-victim\n');
});

test('revision-aware atomic writes reject replacement and symlink swaps', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'plan.json');
  const victim = path.join(root, 'victim.json');
  fs.writeFileSync(target, '{"status":"pending"}\n', { mode: 0o640 });
  fs.writeFileSync(victim, '{"keep":true}\n');

  const firstRead = readJsonArtifact(target, { label: 'plan' });
  fs.writeFileSync(target, '{"status":"regenerated"}\n');
  assert.throws(
    () => writeJsonArtifactAtomic(
      target,
      { status: 'approved' },
      { expectedRevision: firstRead.revision, label: 'plan' }
    ),
    /changed since it was read/i
  );
  assert.equal(fs.readFileSync(target, 'utf8'), '{"status":"regenerated"}\n');

  const secondRead = readJsonArtifact(target, { label: 'plan' });
  fs.unlinkSync(target);
  fs.symlinkSync(victim, target);
  assert.throws(
    () => writeJsonArtifactAtomic(
      target,
      { status: 'approved' },
      { expectedRevision: secondRead.revision, label: 'plan' }
    ),
    /symbolic link|changed since it was read/i
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"keep":true}\n');
});

test('atomic writes publish complete content and preserve replacement mode', (t) => {
  const root = fixture(t);
  const created = path.join(root, 'created.json');
  const replaced = path.join(root, 'replaced.json');

  writeJsonArtifactAtomic(created, { status: 'pending' }, { mode: 0o640 });
  assert.deepEqual(JSON.parse(fs.readFileSync(created, 'utf8')), { status: 'pending' });
  assert.equal(fs.statSync(created).mode & 0o777, 0o640);

  fs.writeFileSync(replaced, '{"status":"pending"}\n', { mode: 0o644 });
  const read = readJsonArtifact(replaced);
  writeJsonArtifactAtomic(
    replaced,
    { status: 'approved' },
    { expectedRevision: read.revision }
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(replaced, 'utf8')), { status: 'approved' });
  assert.equal(fs.statSync(replaced).mode & 0o777, 0o644);
});

test('directory durability is preflighted before publication', (t) => {
  if (process.platform === 'win32') {
    t.skip('directory fsync is not used on Windows');
    return;
  }
  const root = fixture(t);
  const target = path.join(root, 'preflight.json');
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('injected preflight directory fsync failure'); };
  try {
    assert.throws(
      () => writeJsonArtifactAtomic(target, { status: 'pending' }),
      /injected preflight directory fsync failure/
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test('post-publication durability failure is explicitly reported as committed', (t) => {
  if (process.platform === 'win32') {
    t.skip('directory fsync is not used on Windows');
    return;
  }
  const root = fixture(t);
  const target = path.join(root, 'committed.json');
  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  fs.fsyncSync = (descriptor) => {
    fsyncCalls += 1;
    if (fsyncCalls === 3) throw new Error('injected post-commit directory fsync failure');
    return originalFsync(descriptor);
  };
  try {
    assert.throws(
      () => writeJsonArtifactAtomic(target, { status: 'approved' }),
      (error) => {
        assert.equal(error.name, 'ArtifactPostCommitError');
        assert.equal(error.committed, true);
        assert.equal(error.artifactPath, target);
        assert.match(error.message, /atomically published.*durability could not be confirmed/i);
        return true;
      }
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { status: 'approved' });
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test('temporary-link cleanup failure cannot erase committed publication state', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'committed-with-residue.json');
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (candidate) => {
    if (path.basename(candidate).includes('.gatefile-') && candidate.endsWith('.tmp')) {
      throw new Error('injected temporary-link cleanup failure');
    }
    return originalUnlink(candidate);
  };
  try {
    assert.throws(
      () => writeJsonArtifactAtomic(target, { status: 'approved' }),
      (error) => {
        assert.equal(error.name, 'ArtifactPostCommitError');
        assert.equal(error.committed, true);
        assert.equal(error.artifactPath, target);
        assert.match(error.message, /temporary-link cleanup failure/i);
        return true;
      }
    );
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.equal(
      fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length,
      1
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
});
