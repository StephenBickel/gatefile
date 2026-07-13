const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeStateDigest,
  createStateRepositoryBinding,
  getOrCreateStateAuthKey,
  signStateEnvelope
} = require('../dist/state-auth');
const {
  STATE_RECORD_VERSION,
  computeReceiptRecordDigest,
  computeSnapshotRecordDigest,
  createPlanStateRecord,
  createReceiptRecord,
  createSnapshotRecord,
  decodeStoredExactFileState,
  exactFileStateToStored,
  extractUntrustedStateRecordHeader,
  parseAndVerifyPlanStateRecord,
  parseAndVerifyReceiptRecord,
  parseAndVerifySnapshotRecord
} = require('../dist/state-records');

function fixture(t, suffix = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gatefile-state-records-${suffix}`));
  const repoRoot = path.join(root, 'repo');
  const stateHome = path.join(root, 'state-home');
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  const binding = createStateRepositoryBinding(repoRoot, `file:state-records-${suffix || 'repo'}`);
  const key = getOrCreateStateAuthKey(binding, stateHome);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repoRoot, stateHome, binding, key };
}

function repository(binding) {
  return {
    repositoryId: binding.repositoryId,
    repoInstanceId: binding.repoInstanceId
  };
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function storedRegular(
  content,
  identity = { device: '101', inode: '202' },
  mode = 0o640,
  uid = '501',
  gid = '20'
) {
  const bytes = Buffer.from(content);
  return {
    kind: 'regular',
    contentBase64: bytes.toString('base64'),
    sha256: digest(bytes),
    byteLength: bytes.length,
    mode,
    uid,
    gid,
    identity
  };
}

function compactRegular(
  content,
  identity = { device: '303', inode: '404' },
  mode = 0o640,
  uid = '501',
  gid = '20'
) {
  const bytes = Buffer.from(content);
  return {
    kind: 'regular',
    sha256: digest(bytes),
    byteLength: bytes.length,
    mode,
    uid,
    gid,
    identity
  };
}

function directoryChain(relativePath) {
  const parentSegments = relativePath.split(/[\\/]/).slice(0, -1);
  const chain = [
    { relativePath: '', identity: { device: '11', inode: '22' } }
  ];
  let current = '';
  parentSegments.forEach((segment, index) => {
    current = current ? path.join(current, segment) : segment;
    chain.push({
      relativePath: current,
      identity: { device: '11', inode: String(23 + index) }
    });
  });
  return chain;
}

function snapshotBody(binding) {
  return {
    type: 'gatefile-rollback-snapshot',
    stateVersion: 1,
    id: 'snapshot_2026-07-13_001',
    repository: repository(binding),
    plan: { id: 'plan_state_records_001', hash: 'a'.repeat(64) },
    createdAt: '2026-07-13T01:02:03.004Z',
    entries: [
      {
        id: 'snapshot_entry_create',
        operationId: 'create_config',
        action: 'create',
        requestedPath: 'config/new.json',
        allowedRoot: binding.canonicalRepoRoot,
        relativePath: 'config/new.json',
        directoryChain: directoryChain('config/new.json'),
        before: { kind: 'absent' }
      },
      {
        id: 'snapshot_entry_update',
        operationId: 'update_readme',
        action: 'update',
        requestedPath: 'README.md',
        allowedRoot: binding.canonicalRepoRoot,
        relativePath: 'README.md',
        directoryChain: directoryChain('README.md'),
        before: storedRegular('before\n')
      },
      {
        id: 'snapshot_entry_delete',
        operationId: 'delete_old',
        action: 'delete',
        requestedPath: 'old.txt',
        allowedRoot: binding.canonicalRepoRoot,
        relativePath: 'old.txt',
        directoryChain: directoryChain('old.txt'),
        before: storedRegular('old\n', { device: '101', inode: '203' }, 0o600)
      }
    ]
  };
}

function receiptBody(binding, snapshot) {
  return {
    type: 'gatefile-apply-receipt',
    stateVersion: 1,
    id: 'receipt_2026-07-13_001',
    repository: repository(binding),
    plan: { ...snapshot.plan },
    appliedAt: '2026-07-13T01:03:04.005Z',
    snapshotId: snapshot.id,
    snapshotDigest: computeSnapshotRecordDigest(snapshot),
    success: false,
    results: [
      { operationId: 'create_config', success: true, message: 'created', mutationStatus: 'committed' },
      { operationId: 'update_readme', success: true, message: 'updated', mutationStatus: 'committed' },
      { operationId: 'delete_old', success: false, message: 'blocked', mutationStatus: 'none' },
      { operationId: 'notify', success: true, message: 'command completed', mutationStatus: 'none' }
    ],
    dependencies: {
      requiredPlanIds: ['plan_dependency_1'],
      missingPlanIds: [],
      allSatisfied: true
    },
    rollbackEntries: [
      {
        snapshotEntryId: 'snapshot_entry_create',
        operationId: 'create_config',
        action: 'create',
        requestedPath: 'config/new.json',
        allowedRoot: binding.canonicalRepoRoot,
        relativePath: 'config/new.json',
        directoryChain: directoryChain('config/new.json'),
        after: compactRegular('{"created":true}\n'),
        cleanupResidues: []
      },
      {
        snapshotEntryId: 'snapshot_entry_update',
        operationId: 'update_readme',
        action: 'update',
        requestedPath: 'README.md',
        allowedRoot: binding.canonicalRepoRoot,
        relativePath: 'README.md',
        directoryChain: directoryChain('README.md'),
        after: compactRegular('after\n', { device: '303', inode: '405' }),
        cleanupResidues: []
      }
    ]
  };
}

function planStateBody(binding, receipt) {
  return {
    type: 'gatefile-plan-state',
    stateVersion: 1,
    repository: repository(binding),
    plan: { ...receipt.plan },
    receiptId: receipt.id,
    receiptDigest: computeReceiptRecordDigest(receipt),
    appliedAt: receipt.appliedAt,
    success: receipt.success
  };
}

function bodyOf(record) {
  const { authentication: _authentication, ...body } = record;
  return body;
}

function authenticate(kind, body, key) {
  return { ...body, authentication: signStateEnvelope(kind, body, key) };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)])
  );
}

test('authenticated snapshot, receipt, and plan-state records round trip after JSON key reordering', (t) => {
  const { binding, key } = fixture(t, 'roundtrip');
  assert.equal(STATE_RECORD_VERSION, 1);

  const snapshot = createSnapshotRecord(snapshotBody(binding), key);
  const receipt = createReceiptRecord(receiptBody(binding, snapshot), key, snapshot);
  assert.equal(receipt.audit, undefined, 'authenticated v1 receipts without audit metadata remain readable');
  const planState = createPlanStateRecord(planStateBody(binding, receipt), key, receipt);

  const snapshotJson = JSON.stringify(reverseObjectKeys(snapshot));
  const receiptJson = Buffer.from(JSON.stringify(reverseObjectKeys(receipt)));
  const planStateJson = JSON.stringify(reverseObjectKeys(planState));
  const expectedRepository = repository(binding);

  assert.deepEqual(
    parseAndVerifySnapshotRecord(snapshotJson, key, {
      repository: expectedRepository,
      id: snapshot.id,
      plan: snapshot.plan
    }),
    reverseObjectKeys(snapshot)
  );
  assert.deepEqual(
    parseAndVerifyReceiptRecord(receiptJson, key, {
      repository: expectedRepository,
      id: receipt.id,
      plan: receipt.plan,
      snapshot
    }),
    reverseObjectKeys(receipt)
  );
  assert.deepEqual(
    parseAndVerifyPlanStateRecord(planStateJson, key, {
      repository: expectedRepository,
      plan: planState.plan,
      receipt
    }),
    reverseObjectKeys(planState)
  );

  assert.match(computeSnapshotRecordDigest(snapshot), /^[a-f0-9]{64}$/);
  assert.match(computeReceiptRecordDigest(receipt), /^[a-f0-9]{64}$/);
  assert.notEqual(computeSnapshotRecordDigest(snapshot), computeReceiptRecordDigest(receipt));

  const snapshotHeader = extractUntrustedStateRecordHeader(snapshotJson);
  assert.deepEqual(snapshotHeader, {
    kind: 'snapshot',
    type: 'gatefile-rollback-snapshot',
    stateVersion: 1,
    id: snapshot.id,
    repository: expectedRepository,
    authentication: snapshot.authentication
  });
  const planStateHeader = extractUntrustedStateRecordHeader(planStateJson);
  assert.equal(planStateHeader.kind, 'plan-state');
  assert.equal(planStateHeader.id, planState.plan.id);
  assert.equal(planStateHeader.authentication.keyId, key.keyId);
});

test('receipt audit metadata is optional for old records and strict when present', (t) => {
  const { binding, key } = fixture(t, 'audit-metadata');
  const snapshot = createSnapshotRecord(snapshotBody(binding), key);
  const oldReceipt = createReceiptRecord(receiptBody(binding, snapshot), key, snapshot);
  assert.equal(oldReceipt.audit, undefined);

  const body = receiptBody(binding, snapshot);
  body.audit = {
    summary: 'Authenticated receipt metadata',
    source: 'state-record-test',
    approvedBy: 'release-reviewer',
    approvedAt: '2026-07-13T01:02:59.000Z',
    approvalIdentity: 'signed',
    signerKeyId: 'release-key'
  };
  const receipt = createReceiptRecord(body, key, snapshot);
  assert.deepEqual(receipt.audit, body.audit);
  assert.deepEqual(parseAndVerifyReceiptRecord(receipt, key, { snapshot }).audit, body.audit);

  const unknown = receiptBody(binding, snapshot);
  unknown.audit = { ...body.audit, forged: true };
  assert.throws(() => createReceiptRecord(unknown, key, snapshot), /unknown field.*forged/i);

  const inconsistent = receiptBody(binding, snapshot);
  inconsistent.audit = { ...body.audit, approvalIdentity: 'unsigned' };
  assert.throws(() => createReceiptRecord(inconsistent, key, snapshot), /unsigned.*signerKeyId/i);
});

test('receipt audit approval timestamps accept equivalent RFC3339 offsets and canonicalize to UTC', (t) => {
  const { binding, key } = fixture(t, 'audit-metadata-timestamp');
  const snapshot = createSnapshotRecord(snapshotBody(binding), key);
  const body = receiptBody(binding, snapshot);
  body.audit = {
    summary: 'Canonical receipt approval time',
    source: 'state-record-test',
    approvedBy: 'release-reviewer',
    approvedAt: '2026-07-12T21:02:59-04:00',
    approvalIdentity: 'unsigned',
    signerKeyId: null
  };

  const receipt = createReceiptRecord(body, key, snapshot);

  assert.equal(receipt.audit.approvedAt, '2026-07-13T01:02:59.000Z');
  assert.equal(
    parseAndVerifyReceiptRecord(receipt, key, { snapshot }).audit.approvedAt,
    '2026-07-13T01:02:59.000Z'
  );
});

test('state-record character bounds count astral Unicode scalars, not UTF-16 units', (t) => {
  const { binding, key } = fixture(t, 'unicode-bounds');
  const scalar = '😀';

  const snapshotAtBoundaryBody = snapshotBody(binding);
  snapshotAtBoundaryBody.plan.id = scalar.repeat(1024);
  const snapshotAtBoundary = createSnapshotRecord(snapshotAtBoundaryBody, key);
  const receiptAtBoundaryBody = receiptBody(binding, snapshotAtBoundary);
  receiptAtBoundaryBody.results[0].message = scalar.repeat(16384);
  assert.doesNotThrow(
    () => createReceiptRecord(receiptAtBoundaryBody, key, snapshotAtBoundary)
  );

  const oversizedId = snapshotBody(binding);
  oversizedId.plan.id = scalar.repeat(1025);
  assert.throws(() => createSnapshotRecord(oversizedId, key), /1024|bounded string/i);

  const normalSnapshot = createSnapshotRecord(snapshotBody(binding), key);
  const oversizedText = receiptBody(binding, normalSnapshot);
  oversizedText.results[0].message = scalar.repeat(16385);
  assert.throws(
    () => createReceiptRecord(oversizedText, key, normalSnapshot),
    /bounded string/i
  );
});

test('exact file-state conversion preserves arbitrary bytes and validates digest, size, mode, and identity', (t) => {
  const { binding, key } = fixture(t, 'file-state');
  const content = Buffer.from([0, 255, 1, 2, 3, 128]);
  const stored = exactFileStateToStored({
    kind: 'regular',
    content,
    sha256: digest(content),
    byteLength: content.length,
    mode: 0o754,
    uid: '501',
    gid: '20',
    identity: { device: '7', inode: '9' }
  });
  assert.deepEqual(decodeStoredExactFileState(stored), {
    kind: 'regular',
    content,
    sha256: digest(content),
    byteLength: content.length,
    mode: 0o754,
    uid: '501',
    gid: '20',
    identity: { device: '7', inode: '9' }
  });

  const badBody = snapshotBody(binding);
  badBody.entries[1].before = { ...stored, sha256: '0'.repeat(64) };
  assert.throws(() => createSnapshotRecord(badBody, key), /digest|sha-?256|content/i);
  badBody.entries[1].before = { ...stored, byteLength: stored.byteLength + 1 };
  assert.throws(() => createSnapshotRecord(badBody, key), /length|size/i);
  badBody.entries[1].before = { ...stored, mode: 0o10000 };
  assert.throws(() => createSnapshotRecord(badBody, key), /mode|range/i);
  badBody.entries[1].before = { ...stored, identity: { device: '-1', inode: '9' } };
  assert.throws(() => createSnapshotRecord(badBody, key), /identity|device/i);
  badBody.entries[1].before = { ...stored, uid: '-1' };
  assert.throws(() => createSnapshotRecord(badBody, key), /uid|owner/i);
  badBody.entries[1].before = { ...stored, gid: '01' };
  assert.throws(() => createSnapshotRecord(badBody, key), /gid|group/i);
});

test('verification rejects tampering, signed unknown fields, unsupported versions, and legacy unsigned records', (t) => {
  const { binding, key } = fixture(t, 'invalid');
  const snapshot = createSnapshotRecord(snapshotBody(binding), key);

  const tampered = structuredClone(snapshot);
  tampered.entries[1].before.uid = '0';
  assert.throws(
    () => parseAndVerifySnapshotRecord(tampered, key),
    /authentication|HMAC|tag/i
  );

  const unknownBody = { ...bodyOf(snapshot), attackerControlled: true };
  const signedUnknown = authenticate('snapshot', unknownBody, key);
  assert.throws(
    () => parseAndVerifySnapshotRecord(signedUnknown, key),
    /unknown|fields/i
  );

  const versionBody = { ...bodyOf(snapshot), stateVersion: 2 };
  const signedVersion = authenticate('snapshot', versionBody, key);
  assert.throws(
    () => parseAndVerifySnapshotRecord(signedVersion, key),
    /version|unsupported/i
  );

  const legacyUnsigned = bodyOf(snapshot);
  assert.throws(
    () => extractUntrustedStateRecordHeader(legacyUnsigned),
    /legacy.*unsigned|authentication.*required/i
  );
  assert.throws(
    () => parseAndVerifySnapshotRecord(legacyUnsigned, key),
    /legacy.*unsigned|authentication.*required/i
  );
});

test('verification rejects a wrong key, repository, record ID, and plan binding', (t) => {
  const first = fixture(t, 'binding-first');
  const second = fixture(t, 'binding-second');
  const snapshot = createSnapshotRecord(snapshotBody(first.binding), first.key);

  assert.throws(
    () => parseAndVerifySnapshotRecord(snapshot, second.key),
    /key|repository|authentication/i
  );
  assert.throws(
    () => parseAndVerifySnapshotRecord(snapshot, first.key, {
      repository: repository(second.binding)
    }),
    /repository/i
  );
  assert.throws(
    () => parseAndVerifySnapshotRecord(snapshot, first.key, { id: 'snapshot_other' }),
    /snapshot.*ID|record.*ID|expected/i
  );
  assert.throws(
    () => parseAndVerifySnapshotRecord(snapshot, first.key, {
      plan: { id: 'plan_other', hash: snapshot.plan.hash }
    }),
    /plan/i
  );
});

test('strict records reject duplicate IDs and mismatched snapshot/receipt references', (t) => {
  const { binding, key } = fixture(t, 'references');

  const duplicateSnapshotBody = snapshotBody(binding);
  duplicateSnapshotBody.entries[1].id = duplicateSnapshotBody.entries[0].id;
  assert.throws(
    () => createSnapshotRecord(duplicateSnapshotBody, key),
    /duplicate.*entry.*ID/i
  );
  const duplicateOperationBody = snapshotBody(binding);
  duplicateOperationBody.entries[1].operationId = duplicateOperationBody.entries[0].operationId;
  assert.throws(
    () => createSnapshotRecord(duplicateOperationBody, key),
    /duplicate.*operation/i
  );

  const snapshot = createSnapshotRecord(snapshotBody(binding), key);
  const duplicateResult = receiptBody(binding, snapshot);
  duplicateResult.results[1].operationId = duplicateResult.results[0].operationId;
  assert.throws(() => createReceiptRecord(duplicateResult, key, snapshot), /duplicate.*result|operation/i);

  const failedReference = receiptBody(binding, snapshot);
  failedReference.rollbackEntries[0].operationId = 'delete_old';
  assert.throws(
    () => createReceiptRecord(failedReference, key, snapshot),
    /succeeded|successful|reference|mismatch|intended|committed/i
  );

  const wrongSnapshotEntry = receiptBody(binding, snapshot);
  wrongSnapshotEntry.rollbackEntries[0].snapshotEntryId = 'snapshot_entry_missing';
  assert.throws(
    () => createReceiptRecord(wrongSnapshotEntry, key, snapshot),
    /snapshot.*mismatch|reference.*mismatch|metadata/i
  );

  for (const mutationStatus of ['intended', 'committed']) {
    const missingRecovery = receiptBody(binding, snapshot);
    const updateResult = missingRecovery.results.find(
      (result) => result.operationId === 'update_readme'
    );
    updateResult.success = false;
    updateResult.message = `${mutationStatus} update outcome requires recovery`;
    updateResult.mutationStatus = mutationStatus;
    missingRecovery.rollbackEntries = missingRecovery.rollbackEntries.filter(
      (entry) => entry.operationId !== 'update_readme'
    );
    assert.throws(
      () => createReceiptRecord(missingRecovery, key, snapshot),
      /intended|committed|rollback entry|recovery/i,
      `failed ${mutationStatus} mutation without rollback metadata`
    );
  }

  const receipt = createReceiptRecord(receiptBody(binding, snapshot), key, snapshot);
  const badPlanState = planStateBody(binding, receipt);
  badPlanState.receiptDigest = computeStateDigest('receipt', { not: 'the receipt' });
  assert.throws(
    () => createPlanStateRecord(badPlanState, key, receipt),
    /receipt.*digest|reference.*mismatch/i
  );

  const signedBadReceiptBody = receiptBody(binding, snapshot);
  signedBadReceiptBody.snapshotDigest = 'f'.repeat(64);
  const signedBadReceipt = authenticate('receipt', signedBadReceiptBody, key);
  assert.throws(
    () => parseAndVerifyReceiptRecord(signedBadReceipt, key, { snapshot }),
    /snapshot.*digest|reference.*mismatch/i
  );
});

test('strict validation rejects unsafe IDs, non-canonical timestamps/base64, traversal paths, and dependency inconsistencies', (t) => {
  const { binding, key } = fixture(t, 'strict');

  for (const id of ['../snapshot', 'with/slash', '.hidden']) {
    const body = snapshotBody(binding);
    body.id = id;
    assert.throws(() => createSnapshotRecord(body, key), /safe.*ID|invalid.*ID/i, id);
  }

  const timestamp = snapshotBody(binding);
  timestamp.createdAt = '2026-07-13T01:02:03Z';
  assert.throws(() => createSnapshotRecord(timestamp, key), /timestamp|RFC3339|canonical/i);

  const base64 = snapshotBody(binding);
  base64.entries[1].before.contentBase64 = '***';
  assert.throws(() => createSnapshotRecord(base64, key), /base64/i);

  const traversal = snapshotBody(binding);
  traversal.entries[1].relativePath = '../outside';
  assert.throws(() => createSnapshotRecord(traversal, key), /relative.*path|traversal/i);

  const snapshot = createSnapshotRecord(snapshotBody(binding), key);
  const dependencyMismatch = receiptBody(binding, snapshot);
  dependencyMismatch.dependencies = {
    requiredPlanIds: ['plan_dependency_1'],
    missingPlanIds: ['plan_not_required'],
    allSatisfied: false
  };
  assert.throws(
    () => createReceiptRecord(dependencyMismatch, key, snapshot),
    /missing.*required|dependency/i
  );
});
