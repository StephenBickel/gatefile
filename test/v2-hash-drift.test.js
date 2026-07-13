const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyPlan,
  approvePlan,
  buildInspectReport,
  computePlanHash,
  createPlanFromDraft,
  normalizePlanForHash,
  verifyPlan
} = require('../dist');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDraft(operations, execution) {
  return {
    source: 'v2-contract-test',
    summary: 'Exercise the v2 integrity and drift contract',
    operations,
    preconditions: [],
    ...(execution ? { execution } : {})
  };
}

function createFilePlan(root, operation) {
  return createPlanFromDraft(
    createDraft([operation], {
      filePolicy: { allowedRoots: [root] }
    }),
    { repoRoot: root }
  );
}

function approveFilePlan(root, operation) {
  return approvePlan(createFilePlan(root, operation), 'reviewer', { repoRoot: root });
}

test('new plans use the v2 plan and hash-envelope discriminators', () => {
  const plan = createPlanFromDraft(
    createDraft([
      {
        id: 'create',
        type: 'file',
        action: 'create',
        path: 'tmp/v2.txt',
        after: 'v2\n'
      }
    ]),
    { context: { repositoryId: 'repo:example/gatefile' } }
  );

  assert.equal(plan.version, '2');
  assert.deepEqual(plan.context, { repositoryId: 'repo:example/gatefile' });
  assert.equal(plan.integrity.algorithm, 'sha256');
  assert.equal(plan.integrity.canonicalizer, 'gatefile-v2');
  assert.equal(plan.integrity.envelopeVersion, 2);

  const envelope = normalizePlanForHash(plan);
  assert.equal(envelope.type, 'gatefile-plan-hash');
  assert.equal(envelope.envelopeVersion, 2);
  assert.equal(envelope.plan.id, plan.id);
  assert.equal(envelope.plan.createdAt, plan.createdAt);
  assert.equal(envelope.plan.context.repositoryId, 'repo:example/gatefile');
  assert.equal('integrity' in envelope.plan, false);
  assert.equal('approval' in envelope.plan, false);
});

test('every execution-relevant v2 field is hash and approval bound', () => {
  const pending = createPlanFromDraft(
    {
      source: 'hash-test',
      summary: 'Hash all execution fields',
      dependsOn: ['plan_dependency'],
      operations: [
        {
          id: 'command',
          type: 'command',
          executable: process.execPath,
          args: ['--version']
        }
      ],
      preconditions: [{ kind: 'env_present', value: 'PATH' }],
      execution: {
        commandPolicy: {
          mode: 'allow',
          rules: [{ executable: process.execPath, args: ['--version'] }]
        }
      }
    },
    { context: { repositoryId: 'repo:hash-test' } }
  );
  const approved = approvePlan(pending, 'reviewer', { repositoryId: 'repo:hash-test' });
  const mutations = [
    ['id', (plan) => { plan.id = `${plan.id}_changed`; }],
    ['createdAt', (plan) => { plan.createdAt = '2030-01-01T00:00:00.000Z'; }],
    ['source', (plan) => { plan.source = 'changed-source'; }],
    ['summary', (plan) => { plan.summary = 'changed summary'; }],
    ['dependsOn', (plan) => { plan.dependsOn = ['different_dependency']; }],
    ['context', (plan) => { plan.context.repositoryId = 'repo:other'; }],
    ['operations', (plan) => { plan.operations[0].args = ['--help']; }],
    ['preconditions', (plan) => { plan.preconditions[0].value = 'HOME'; }],
    [
      'execution',
      (plan) => {
        plan.execution.commandPolicy.rules[0].args = ['--help'];
      }
    ]
  ];

  for (const [name, mutate] of mutations) {
    const changed = clone(approved);
    mutate(changed);
    const report = verifyPlan(changed);
    assert.equal(report.status, 'not-ready', `${name} mutation remained ready`);
    assert.equal(report.checks.recordedHashMatchesCurrent, false, `${name} was not hash bound`);
    assert.equal(report.checks.approvalBoundToCurrentHash, false, `${name} was not approval bound`);
  }
});

test('risk is recomputed for hashing and stored-risk drift blocks verification', () => {
  const plan = approvePlan(
    createPlanFromDraft(
      createDraft([
        {
          id: 'delete',
          type: 'file',
          action: 'delete',
          path: 'tmp/risky.txt',
          before: 'reviewed\n'
        }
      ])
    ),
    'reviewer'
  );
  const originalHash = computePlanHash(plan);
  const changed = clone(plan);
  changed.risk = { score: 0, level: 'low', reasons: [] };

  assert.equal(computePlanHash(changed), originalHash, 'stored risk must not feed the v2 hash');
  const report = verifyPlan(changed);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.checks.riskMatchesRecomputed, false);
  assert.match(report.blockers.join('\n'), /risk/i);

  const stalePending = clone(createPlanFromDraft(createDraft([
    {
      id: 'command',
      type: 'command',
      executable: process.execPath,
      args: ['--version']
    }
  ])));
  stalePending.risk = { score: 0, level: 'low', reasons: [] };
  assert.throws(() => approvePlan(stalePending, 'reviewer'), /risk.*recomputed/i);
});

test('approval and integrity metadata are excluded and canonical hashing is stable', () => {
  const plan = createPlanFromDraft(
    createDraft([
      {
        id: 'create',
        type: 'file',
        action: 'create',
        path: 'tmp/stable.txt',
        after: ''
      }
    ])
  );
  const expected = computePlanHash(plan);
  const metadataChanged = clone(plan);
  metadataChanged.approval = {
    status: 'approved',
    approvedBy: 'someone',
    approvedAt: new Date().toISOString(),
    approvedPlanHash: 'f'.repeat(64)
  };
  metadataChanged.integrity.planHash = '0'.repeat(64);
  assert.equal(computePlanHash(metadataChanged), expected);

  const reordered = Object.fromEntries(Object.entries(clone(plan)).reverse());
  assert.equal(computePlanHash(reordered), expected);
  assert.equal(computePlanHash(JSON.parse(JSON.stringify(plan))), expected);

  assert.throws(
    () => computePlanHash({ ...clone(plan), futureExecutionField: true }),
    /unknown fields/i
  );
  const wrongCanonicalizer = clone(plan);
  wrongCanonicalizer.integrity.canonicalizer = 'gatefile-v1';
  assert.throws(() => verifyPlan(wrongCanonicalizer), /canonicalizer.*gatefile-v2/i);
  const wrongEnvelope = clone(plan);
  wrongEnvelope.integrity.envelopeVersion = 1;
  assert.throws(() => verifyPlan(wrongEnvelope), /envelopeVersion.*2/i);
});

test('legacy v1 plans remain inspectable but cannot be approved or applied', () => {
  const legacy = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/legacy-v1-plan.json'), 'utf8')
  );
  assert.equal(computePlanHash(legacy), legacy.integrity.planHash);
  assert.equal(legacy.operations[0].command, 'node --version');

  const report = verifyPlan(legacy);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.checks.planVersionSupported, false);
  assert.match(report.blockers.join('\n'), /legacy|version|migrate|re-approve/i);
  assert.doesNotThrow(() => buildInspectReport(legacy));
  assert.throws(() => approvePlan(legacy, 'reviewer'), /version|v2/i);
  assert.throws(() => applyPlan(legacy), /version|v2/i);
});

test('runtime and schema date-time contracts reject non-RFC3339 timestamps', () => {
  const pending = createPlanFromDraft(createDraft([
    { id: 'command', type: 'command', executable: process.execPath, args: ['--version'] }
  ]));
  const invalidCreatedAt = clone(pending);
  invalidCreatedAt.createdAt = '2024-01-01';
  assert.throws(() => approvePlan(invalidCreatedAt, 'reviewer'), /createdAt.*RFC3339/i);

  const approved = approvePlan(pending, 'reviewer');
  const invalidApprovedAt = clone(approved);
  invalidApprovedAt.approval.approvedAt = 'next Tuesday';
  assert.throws(() => verifyPlan(invalidApprovedAt), /approvedAt.*RFC3339/i);

  for (const timestamp of ['2024-01-01t00:00:00z', '2024-12-31T23:59:60Z']) {
    const invalidCanonicalForm = clone(pending);
    invalidCanonicalForm.createdAt = timestamp;
    assert.throws(
      () => approvePlan(invalidCanonicalForm, 'reviewer'),
      /createdAt.*RFC3339/i,
      `runtime accepted non-canonical timestamp ${timestamp}`
    );
  }
});

test('runtime repository context mismatch blocks readiness', () => {
  const approved = approvePlan(
    createPlanFromDraft(createDraft([
      {
        id: 'command',
        type: 'command',
        executable: process.execPath,
        args: ['--version']
      }
    ]), { context: { repositoryId: 'repo:expected' } }),
    'reviewer',
    { repositoryId: 'repo:expected' }
  );

  assert.equal(verifyPlan(approved, { repositoryId: 'repo:expected' }).status, 'ready');
  const mismatch = verifyPlan(approved, { repositoryId: 'repo:different' });
  assert.equal(mismatch.status, 'not-ready');
  assert.equal(mismatch.checks.repositoryContextMatches, false);
  assert.match(mismatch.blockers.join('\n'), /repository context/i);
});

test('repository context is derived fail-closed across verify and apply', () => {
  const intendedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-context-intended-'));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-context-other-'));
  try {
    const marker = path.join(otherRoot, 'must-not-run.txt');
    const approved = approvePlan(
      createPlanFromDraft(
        createDraft([
          {
            id: 'command',
            type: 'command',
            executable: process.execPath,
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`]
          }
        ]),
        { repoRoot: intendedRoot }
      ),
      'reviewer',
      { repoRoot: intendedRoot }
    );

    assert.equal(verifyPlan(approved, { repoRoot: intendedRoot }).status, 'ready');
    assert.equal(verifyPlan(approved, { repoRoot: otherRoot }).status, 'not-ready');
    assert.equal(verifyPlan(approved).status, 'not-ready', 'omission disabled context binding');
    assert.throws(
      () => applyPlan(approved, { repoRoot: otherRoot }),
      /repository context/i
    );
    assert.throws(() => applyPlan(approved), /repository context/i);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(intendedRoot, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});

test('file action shapes require the reviewed pre-state fields', () => {
  const invalid = [
    { id: 'create-missing-after', type: 'file', action: 'create', path: 'a' },
    { id: 'create-with-before', type: 'file', action: 'create', path: 'a', before: '', after: '' },
    { id: 'update-missing-before', type: 'file', action: 'update', path: 'a', after: '' },
    { id: 'update-missing-after', type: 'file', action: 'update', path: 'a', before: '' },
    { id: 'delete-missing-before', type: 'file', action: 'delete', path: 'a' },
    { id: 'delete-with-after', type: 'file', action: 'delete', path: 'a', before: '', after: '' }
  ];
  for (const operation of invalid) {
    assert.throws(
      () => createPlanFromDraft(createDraft([operation])),
      /before|after|create|update|delete/i,
      `accepted ${operation.id}`
    );
  }

  assert.doesNotThrow(() =>
    createPlanFromDraft(createDraft([
      { id: 'empty-create', type: 'file', action: 'create', path: 'a', after: '' },
      { id: 'empty-update', type: 'file', action: 'update', path: 'b', before: '', after: '' },
      { id: 'empty-delete', type: 'file', action: 'delete', path: 'c', before: '' }
    ]))
  );
});

test('create refuses every existing destination without overwriting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-create-drift-'));
  try {
    const file = path.join(root, 'existing.txt');
    fs.writeFileSync(file, 'existing\n');
    const plan = approveFilePlan(root, {
      id: 'create',
      type: 'file',
      action: 'create',
      path: file,
      after: 'replacement\n'
    });
    const report = applyPlan(plan, { repoRoot: root });
    assert.equal(report.success, false);
    assert.equal(report.snapshot.fileCount, 0);
    assert.match(report.results[0].message, /already exists|drift/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing\n');

    const directory = path.join(root, 'directory');
    fs.mkdirSync(directory);
    const directoryPlan = approveFilePlan(root, {
      id: 'create-directory',
      type: 'file',
      action: 'create',
      path: directory,
      after: 'no\n'
    });
    assert.equal(applyPlan(directoryPlan, { repoRoot: root }).success, false);

    const danglingTarget = path.join(root, 'missing-target');
    const symlink = path.join(root, 'dangling-link');
    fs.symlinkSync(danglingTarget, symlink);
    const symlinkPlan = approveFilePlan(root, {
      id: 'create-symlink',
      type: 'file',
      action: 'create',
      path: symlink,
      after: 'no\n'
    });
    assert.equal(applyPlan(symlinkPlan, { repoRoot: root }).success, false);
    assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update and delete reject missing, non-regular, and drifted targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-update-delete-drift-'));
  try {
    const cases = [
      {
        name: 'update missing',
        operation: { id: 'u-missing', type: 'file', action: 'update', path: path.join(root, 'missing-u'), before: '', after: 'new' }
      },
      {
        name: 'delete missing',
        operation: { id: 'd-missing', type: 'file', action: 'delete', path: path.join(root, 'missing-d'), before: '' }
      }
    ];
    for (const entry of cases) {
      const report = applyPlan(approveFilePlan(root, entry.operation), {
        repoRoot: root
      });
      assert.equal(report.success, false, entry.name);
      assert.match(report.results[0].message, /missing|does not exist|drift/i);
    }

    const updatePath = path.join(root, 'update.txt');
    fs.writeFileSync(updatePath, 'unreviewed\r\n');
    const updatePlan = approveFilePlan(root, {
      id: 'update-drift',
      type: 'file',
      action: 'update',
      path: updatePath,
      before: 'reviewed\n',
      after: 'new\n'
    });
    assert.equal(applyPlan(updatePlan, { repoRoot: root }).success, false);
    assert.equal(fs.readFileSync(updatePath, 'utf8'), 'unreviewed\r\n');

    const deletePath = path.join(root, 'delete.txt');
    fs.writeFileSync(deletePath, 'unreviewed\n');
    const deletePlan = approveFilePlan(root, {
      id: 'delete-drift',
      type: 'file',
      action: 'delete',
      path: deletePath,
      before: 'reviewed\n'
    });
    assert.equal(applyPlan(deletePlan, { repoRoot: root }).success, false);
    assert.equal(fs.readFileSync(deletePath, 'utf8'), 'unreviewed\n');

    const directory = path.join(root, 'not-regular');
    fs.mkdirSync(directory);
    const directoryPlan = approveFilePlan(root, {
      id: 'delete-directory',
      type: 'file',
      action: 'delete',
      path: directory,
      before: ''
    });
    assert.equal(applyPlan(directoryPlan, { repoRoot: root }).success, false);

    const real = path.join(root, 'real.txt');
    const link = path.join(root, 'link.txt');
    fs.writeFileSync(real, 'reviewed\n');
    fs.symlinkSync(real, link);
    const linkPlan = approveFilePlan(root, {
      id: 'update-link',
      type: 'file',
      action: 'update',
      path: link,
      before: 'reviewed\n',
      after: 'changed\n'
    });
    const linkReport = applyPlan(linkPlan, { repoRoot: root });
    assert.equal(linkReport.success, false);
    assert.equal(linkReport.snapshot.fileCount, 0, 'snapshot followed a rejected symlink');
    assert.equal(fs.readFileSync(real, 'utf8'), 'reviewed\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('matching update/delete controls succeed and drift stops later commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-drift-controls-'));
  try {
    const updatePath = path.join(root, 'update.txt');
    const deletePath = path.join(root, 'delete.txt');
    fs.writeFileSync(updatePath, 'old\n');
    fs.writeFileSync(deletePath, 'remove\n');
    const control = approvePlan(
      createPlanFromDraft(
        createDraft(
          [
            { id: 'update', type: 'file', action: 'update', path: updatePath, before: 'old\n', after: 'new\n' },
            { id: 'delete', type: 'file', action: 'delete', path: deletePath, before: 'remove\n' }
          ],
          { filePolicy: { allowedRoots: [root] } }
        ),
        { repoRoot: root }
      ),
      'reviewer',
      { repoRoot: root }
    );
    const controlReport = applyPlan(control, { repoRoot: root });
    assert.equal(controlReport.success, true);
    assert.equal(fs.readFileSync(updatePath, 'utf8'), 'new\n');
    assert.equal(fs.existsSync(deletePath), false);

    const marker = path.join(root, 'command-marker.txt');
    const drifted = approvePlan(
      createPlanFromDraft(
        createDraft(
          [
            { id: 'drift', type: 'file', action: 'update', path: updatePath, before: 'old\n', after: 'again\n' },
            {
              id: 'must-not-run',
              type: 'command',
              executable: process.execPath,
              args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`]
            }
          ],
          { filePolicy: { allowedRoots: [root] } }
        ),
        { repoRoot: root }
      ),
      'reviewer',
      { repoRoot: root }
    );
    const driftReport = applyPlan(drifted, { repoRoot: root });
    assert.equal(driftReport.success, false);
    assert.equal(driftReport.results.length, 1);
    assert.equal(fs.readFileSync(updatePath, 'utf8'), 'new\n');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
