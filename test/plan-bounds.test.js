const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');

const {
  applyPlan,
  APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES,
  AUTHENTICATED_STATE_FILE_MAX_BYTES,
  approvePlan,
  computePlanHash,
  createPlanFromDraft,
  MAX_PLAN_OPERATIONS: RUNTIME_MAX_PLAN_OPERATIONS,
  STATE_RECORD_BOUND_ID_MAX_LENGTH: RUNTIME_BOUND_ID_MAX_LENGTH,
  MAX_WORST_CASE_APPLY_RECEIPT_BYTES,
  scoreRisk,
  validatePlanFile
} = require('../dist');

const MAX_PLAN_OPERATIONS = 32;
const MAX_STATE_BOUND_ID_LENGTH = 1024;

function fixture(t, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome };
}

function nodeCommand(id, markerPath, writesMarker = false) {
  return {
    id,
    type: 'command',
    executable: process.execPath,
    args: writesMarker
      ? [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed', 'utf8')`
        ]
      : ['-e', '']
  };
}

/** Build a hash-bound approved plan without re-running draft validation. */
function approvedPlanWithOperations(repoRoot, operations) {
  const seed = approvePlan(
    createPlanFromDraft(
      {
        source: 'plan-bounds-test',
        summary: 'Seed a valid plan before adversarial mutation',
        operations: [nodeCommand('seed', path.join(repoRoot, 'unused.txt'))],
        preconditions: []
      },
      { repoRoot }
    ),
    'bounds-reviewer',
    { repoRoot }
  );
  const mutated = {
    ...seed,
    operations,
    risk: scoreRisk(operations),
    approval: {
      status: 'approved',
      approvedBy: 'bounds-reviewer',
      approvedAt: seed.approval.approvedAt
    }
  };
  const planHash = computePlanHash(mutated);
  return {
    ...mutated,
    integrity: { ...seed.integrity, planHash },
    approval: { ...mutated.approval, approvedPlanHash: planHash }
  };
}

function schemaValidator() {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schema', 'gatefile.schema.json'), 'utf8')
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function validCommandPlan() {
  return createPlanFromDraft({
    source: 'runtime-bounds-test',
    summary: 'Start from a valid command plan',
    operations: [nodeCommand('valid-id', '/unused')],
    preconditions: []
  });
}

test('apply rejects a 1025-character command ID before command side effects', (t) => {
  const f = fixture(t, 'gatefile-command-id-bound');
  const marker = path.join(f.repoRoot, 'marker.txt');
  const plan = approvedPlanWithOperations(f.repoRoot, [
    nodeCommand('x'.repeat(MAX_STATE_BOUND_ID_LENGTH + 1), marker, true)
  ]);

  assert.throws(
    () => applyPlan(plan, { repoRoot: f.repoRoot, stateHome: f.stateHome }),
    /operations\[0\]\.id.*1024|operation ID.*1024/i
  );
  assert.equal(fs.existsSync(marker), false);
});

test('apply rejects an excessive operation list before the first command side effect', (t) => {
  const f = fixture(t, 'gatefile-operation-count-bound');
  const marker = path.join(f.repoRoot, 'marker.txt');
  const operations = Array.from({ length: MAX_PLAN_OPERATIONS + 1 }, (_, index) =>
    nodeCommand(`command-${index}`, marker, index === 0)
  );
  const plan = approvedPlanWithOperations(f.repoRoot, operations);

  assert.throws(
    () => applyPlan(plan, { repoRoot: f.repoRoot, stateHome: f.stateHome }),
    /operations.*at most 32|operation count.*32/i
  );
  assert.equal(fs.existsSync(marker), false);
});

test('JSON schema rejects operation IDs longer than the state-record bound', () => {
  const validate = schemaValidator();
  const plan = createPlanFromDraft({
    source: 'schema-bounds-test',
    summary: 'Start from a valid command plan',
    operations: [nodeCommand('valid-id', '/unused')],
    preconditions: []
  });
  plan.operations[0].id = 'x'.repeat(MAX_STATE_BOUND_ID_LENGTH + 1);

  assert.equal(validate(plan), false, 'schema accepted an oversized operation ID');
  assert.match(JSON.stringify(validate.errors), /maxLength/);
});

test('JSON schema rejects plans exceeding the operation-count receipt budget', () => {
  const validate = schemaValidator();
  const plan = createPlanFromDraft({
    source: 'schema-bounds-test',
    summary: 'Start from a valid command plan',
    operations: [nodeCommand('valid-id', '/unused')],
    preconditions: []
  });
  plan.operations = Array.from({ length: MAX_PLAN_OPERATIONS + 1 }, (_, index) =>
    nodeCommand(`command-${index}`, '/unused')
  );

  assert.equal(validate(plan), false, 'schema accepted too many operations');
  assert.match(JSON.stringify(validate.errors), /maxItems/);
});

const receiptBoundMutations = [
  [
    'plan ID',
    (plan) => { plan.id = 'p'.repeat(MAX_STATE_BOUND_ID_LENGTH + 1); },
    /id.*1024/i
  ],
  [
    'dependency ID',
    (plan) => { plan.dependsOn = ['d'.repeat(MAX_STATE_BOUND_ID_LENGTH + 1)]; },
    /dependsOn\[0\].*1024/i
  ],
  [
    'repository binding',
    (plan) => { plan.context.repositoryId = 'r'.repeat(16001); },
    /context\.repositoryId.*16000/i
  ],
  [
    'file result path',
    (plan) => {
      plan.operations = [
        { id: 'file', type: 'file', action: 'create', path: 'f'.repeat(16001), after: '' }
      ];
    },
    /operations\[0\]\.path.*16000/i
  ],
  [
    'allowed root',
    (plan) => {
      plan.execution = { filePolicy: { allowedRoots: ['a'.repeat(16001)] } };
    },
    /allowedRoots\[0\].*16000/i
  ],
  [
    'command argument count',
    (plan) => { plan.operations[0].args = Array.from({ length: 4097 }, () => ''); },
    /args.*4096/i
  ]
];

for (const [label, mutate, expected] of receiptBoundMutations) {
  test(`runtime validation bounds receipt-derived ${label}`, () => {
    const plan = validCommandPlan();
    mutate(plan);
    assert.throws(() => validatePlanFile(plan), expected);
  });
}

test('runtime and schema accept the operation-ID and count boundaries', () => {
  const validateSchema = schemaValidator();
  const plan = validCommandPlan();
  plan.operations = Array.from({ length: MAX_PLAN_OPERATIONS }, (_, index) =>
    nodeCommand(index === 0 ? 'x'.repeat(MAX_STATE_BOUND_ID_LENGTH) : `command-${index}`, '/unused')
  );

  assert.doesNotThrow(() => validatePlanFile(plan));
  assert.equal(validateSchema(plan), true, JSON.stringify(validateSchema.errors));
});

test('runtime and schema agree on independent command token boundaries', () => {
  const validateSchema = schemaValidator();
  const atBoundary = validCommandPlan();
  atBoundary.operations[0].executable = 'e'.repeat(16000);
  atBoundary.operations[0].args = ['a'.repeat(16000)];
  atBoundary.operations[0].cwd = 'c'.repeat(16000);

  assert.doesNotThrow(() => validatePlanFile(atBoundary));
  assert.equal(validateSchema(atBoundary), true, JSON.stringify(validateSchema.errors));

  const overBoundaryMutations = [
    (plan) => { plan.operations[0].executable = 'e'.repeat(16001); },
    (plan) => { plan.operations[0].args = ['a'.repeat(16001)]; },
    (plan) => { plan.operations[0].cwd = 'c'.repeat(16001); }
  ];
  for (const mutate of overBoundaryMutations) {
    const plan = validCommandPlan();
    mutate(plan);
    assert.throws(() => validatePlanFile(plan), /at most 16000/i);
    assert.equal(validateSchema(plan), false, 'schema accepted a command token over 16000 characters');
  }
});

test('runtime and schema count astral Unicode as one character at every bound', () => {
  const validateSchema = schemaValidator();
  const scalar = '😀';
  const atBoundary = validCommandPlan();
  atBoundary.id = scalar.repeat(1024);
  atBoundary.operations[0].id = scalar.repeat(1024);
  atBoundary.operations[0].executable = scalar.repeat(16000);
  atBoundary.operations[0].args = [scalar.repeat(16000)];
  atBoundary.operations[0].cwd = scalar.repeat(16000);
  atBoundary.execution = {
    filePolicy: { allowedRoots: [scalar.repeat(16000)] }
  };

  assert.doesNotThrow(() => validatePlanFile(atBoundary));
  assert.equal(validateSchema(atBoundary), true, JSON.stringify(validateSchema.errors));

  const overBoundaryMutations = [
    (plan) => { plan.id = scalar.repeat(1025); },
    (plan) => { plan.operations[0].id = scalar.repeat(1025); },
    (plan) => { plan.operations[0].executable = scalar.repeat(16001); },
    (plan) => { plan.operations[0].args = [scalar.repeat(16001)]; },
    (plan) => { plan.operations[0].cwd = scalar.repeat(16001); },
    (plan) => {
      plan.execution = { filePolicy: { allowedRoots: [scalar.repeat(16001)] } };
    }
  ];
  for (const mutate of overBoundaryMutations) {
    const plan = validCommandPlan();
    mutate(plan);
    assert.throws(() => validatePlanFile(plan), /at most (?:1024|16000)|exceeds (?:1024|16000)/i);
    assert.equal(validateSchema(plan), false, 'schema accepted an astral string over its character bound');
  }
});

test('worst-case allowed receipt estimate remains below both state budgets', () => {
  assert.equal(RUNTIME_MAX_PLAN_OPERATIONS, MAX_PLAN_OPERATIONS);
  assert.equal(RUNTIME_BOUND_ID_MAX_LENGTH, MAX_STATE_BOUND_ID_LENGTH);
  assert.ok(MAX_WORST_CASE_APPLY_RECEIPT_BYTES > 0);
  assert.ok(MAX_WORST_CASE_APPLY_RECEIPT_BYTES <= APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES);
  assert.ok(APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES < AUTHENTICATED_STATE_FILE_MAX_BYTES);
});

test('excessive directory chains are rejected before the target mutation', (t) => {
  const f = fixture(t, 'gatefile-directory-chain-bound');
  const segments = Array.from({ length: 129 }, (_, index) => `d${index}`);
  const parent = path.join(f.repoRoot, ...segments);
  fs.mkdirSync(parent, { recursive: true });
  const target = path.join(parent, 'must-not-exist.txt');
  const plan = approvePlan(createPlanFromDraft({
    source: 'plan-bounds-test',
    summary: 'Reject receipt-amplifying directory metadata',
    operations: [{
      id: 'deep-create',
      type: 'file',
      action: 'create',
      path: target,
      after: 'bad\n'
    }],
    preconditions: [],
    execution: { filePolicy: { allowedRoots: [f.repoRoot] } }
  }, { repoRoot: f.repoRoot }), 'bounds-reviewer', { repoRoot: f.repoRoot });

  const report = applyPlan(plan, { repoRoot: f.repoRoot, stateHome: f.stateHome });
  assert.equal(report.success, false);
  assert.match(report.results[0].message, /directory chain exceeds 128/i);
  assert.equal(fs.existsSync(target), false);
});
