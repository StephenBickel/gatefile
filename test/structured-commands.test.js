const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');

const {
  adaptAgentInputToDraft,
  applyPlan,
  approvePlan,
  createPlanFromDraft,
  previewPlan,
  reviewPlan,
  scoreRisk,
  verifyPlan
} = require('../dist');

function nodeWriteOperation(id, filePath, value, overrides = {}) {
  return {
    id,
    type: 'command',
    executable: process.execPath,
    args: [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], process.argv[2], "utf8")',
      filePath,
      value
    ],
    ...overrides
  };
}

function approvedCommandPlan(operation, execution, repoRoot) {
  return approvePlan(
    createPlanFromDraft({
      source: 'structured-command-test',
      summary: 'Exercise structured command execution',
      operations: [operation],
      preconditions: [],
      ...(execution ? { execution } : {})
    }, { repoRoot }),
    'reviewer',
    { repoRoot }
  );
}

test('shell metacharacters in arguments remain literal data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-literal-'));
  try {
    const marker = path.join(root, 'marker.txt');
    const injected = path.join(root, 'injected.txt');
    const payload = `literal; touch ${injected}; $(touch ${injected}) > ${injected}`;
    const operation = nodeWriteOperation('literal', marker, payload);
    const report = applyPlan(approvedCommandPlan(operation, undefined, root), { repoRoot: root });

    assert.equal(report.success, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), payload);
    assert.equal(fs.existsSync(injected), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captured command mode keeps bounded stdout and stderr in the operation report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-capture-'));
  try {
    const operation = {
      id: 'captured-output',
      type: 'command',
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(Buffer.from("Q0FQVFVSRUQtU1RET1VU","base64"));' +
          'process.stderr.write(Buffer.from("Q0FQVFVSRUQtU1RERVJS","base64"))'
      ]
    };
    const report = applyPlan(approvedCommandPlan(operation, undefined, root), {
      repoRoot: root,
      commandOutput: { mode: 'capture', maxBytes: 4096 }
    });

    assert.equal(report.success, true, JSON.stringify(report, null, 2));
    assert.match(report.results[0].message, /CAPTURED-STDOUT/);
    assert.match(report.results[0].message, /CAPTURED-STDERR/);
    assert.ok(report.results[0].message.length < 16_384);

    const longOutput = {
      id: 'captured-output-truncated',
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("X".repeat(100))']
    };
    const truncated = applyPlan(approvedCommandPlan(longOutput, undefined, root), {
      repoRoot: root,
      commandOutput: { mode: 'capture', maxBytes: 16 }
    });
    assert.equal(truncated.success, true);
    assert.match(truncated.results[0].message, /stdout="XXXXXXXXXXXXXXXX"/);
    assert.match(truncated.results[0].message, /truncated at 16 bytes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an executable containing spaces is not parsed as a shell command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-executable-'));
  try {
    const marker = path.join(root, 'marker.txt');
    const operation = {
      id: 'space-executable',
      type: 'command',
      executable: `${process.execPath} -e`,
      args: ['require("node:fs").writeFileSync(process.argv[1], "bad", "utf8")', marker]
    };
    const report = applyPlan(approvedCommandPlan(operation, undefined, root), { repoRoot: root });

    assert.equal(report.success, false);
    assert.equal(report.results[0].success, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nonzero exits stop apply unless allowFailure explicitly permits continuation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-nonzero-'));
  try {
    const blockedMarker = path.join(root, 'blocked-after-exit.txt');
    const failingPlan = approvePlan(
      createPlanFromDraft({
        source: 'nonzero-test',
        summary: 'Nonzero exit stops apply',
        operations: [
          {
            id: 'exit-seven',
            type: 'command',
            executable: process.execPath,
            args: ['-e', 'process.exit(7)']
          },
          {
            id: 'must-not-run',
            type: 'file',
            action: 'create',
            path: blockedMarker,
            after: 'bad\n'
          }
        ],
        preconditions: [],
        execution: { filePolicy: { allowedRoots: [root] } }
      }, { repoRoot: root }),
      'reviewer'
    );
    const failed = applyPlan(failingPlan, { repoRoot: root });
    assert.equal(failed.success, false);
    assert.equal(failed.results.length, 1);
    assert.match(failed.results[0].message, /status 7/);
    assert.equal(fs.existsSync(blockedMarker), false);

    const continuedMarker = path.join(root, 'continued-after-exit.txt');
    const allowedPlan = approvePlan(
      createPlanFromDraft({
        source: 'nonzero-test',
        summary: 'allowFailure permits continuation after nonzero exit',
        operations: [
          {
            id: 'exit-seven-allowed',
            type: 'command',
            executable: process.execPath,
            args: ['-e', 'process.exit(7)'],
            allowFailure: true
          },
          {
            id: 'continue',
            type: 'file',
            action: 'create',
            path: continuedMarker,
            after: 'continued\n'
          }
        ],
        preconditions: [],
        execution: { filePolicy: { allowedRoots: [root] } }
      }, { repoRoot: root }),
      'reviewer'
    );
    const continued = applyPlan(allowedPlan, { repoRoot: root });
    assert.equal(continued.success, true);
    assert.equal(continued.results.length, 2);
    assert.equal(continued.results[0].success, true);
    assert.match(continued.results[0].message, /status 7/);
    assert.match(continued.results[0].message, /allowFailure=true/);
    assert.equal(fs.readFileSync(continuedMarker, 'utf8'), 'continued\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allow policy requires an exact executable and complete argument array', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-policy-'));
  try {
    const marker = path.join(root, 'marker.txt');
    const operation = nodeWriteOperation('exact-policy', marker, 'blocked', {
      args: [...nodeWriteOperation('template', marker, 'blocked').args, 'extra'],
      allowFailure: true
    });
    const execution = {
      commandPolicy: {
        mode: 'allow',
        rules: [
          {
            executable: process.execPath,
            args: nodeWriteOperation('rule', marker, 'blocked').args
          }
        ]
      }
    };
    const report = applyPlan(approvedCommandPlan(operation, execution, root), { repoRoot: root });

    assert.equal(report.success, false, 'allowFailure must not waive a policy denial');
    assert.equal(report.results[0].success, false);
    assert.match(report.results[0].message, /exactly match/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allow policy rejects executable and argument near-matches', () => {
  const exactOperation = {
    id: 'exact',
    type: 'command',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)', 'Value']
  };
  const rule = { executable: exactOperation.executable, args: [...exactOperation.args] };
  const variants = [
    { ...exactOperation, id: 'executable', executable: `${process.execPath}-other` },
    { ...exactOperation, id: 'missing', args: exactOperation.args.slice(0, -1) },
    { ...exactOperation, id: 'extra', args: [...exactOperation.args, 'extra'] },
    { ...exactOperation, id: 'reordered', args: [exactOperation.args[1], exactOperation.args[0], exactOperation.args[2]] },
    { ...exactOperation, id: 'whitespace', args: ['-e', 'process.exit(0) ', 'Value'] },
    { ...exactOperation, id: 'case', args: ['-e', 'process.exit(0)', 'value'] }
  ];

  for (const operation of variants) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `gatefile-policy-${operation.id}-`));
    try {
      const plan = approvedCommandPlan(operation, {
        commandPolicy: { mode: 'allow', rules: [rule] }
      }, root);
      const report = applyPlan(plan, { repoRoot: root });
      assert.equal(report.success, false, `policy accepted ${operation.id} near-match`);
      assert.match(report.results[0].message, /allow mode/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('deny policy blocks only the exact structured tuple', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-structured-deny-'));
  try {
    const marker = path.join(root, 'marker.txt');
    const operation = nodeWriteOperation('deny-policy', marker, 'blocked');
    const execution = {
      commandPolicy: {
        mode: 'deny',
        rules: [{ executable: operation.executable, args: [...operation.args] }]
      }
    };
    const report = applyPlan(approvedCommandPlan(operation, execution, root), { repoRoot: root });

    assert.equal(report.success, false);
    assert.match(report.results[0].message, /deny mode/);
    assert.equal(fs.existsSync(marker), false);

    const nearOperation = { ...operation, id: 'deny-near', args: [...operation.args, 'near-match'] };
    const nearPlan = approvedCommandPlan(nearOperation, execution, root);
    const nearReport = applyPlan(nearPlan, { repoRoot: root });
    assert.equal(nearReport.success, true, 'deny mode must block only an exact tuple');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed and legacy command contracts are rejected before execution', () => {
  const invalidOperations = [
    { id: 'legacy', type: 'command', command: 'echo unsafe' },
    { id: 'missing-args', type: 'command', executable: process.execPath },
    { id: 'non-string-arg', type: 'command', executable: process.execPath, args: [7] },
    { id: 'empty-executable', type: 'command', executable: '  ', args: [] },
    { id: 'nul-executable', type: 'command', executable: 'node\0evil', args: [] },
    { id: 'nul-argument', type: 'command', executable: process.execPath, args: ['bad\0arg'] },
    { id: 'nul-cwd', type: 'command', executable: process.execPath, args: [], cwd: 'bad\0cwd' },
    { id: 'invalid-timeout', type: 'command', executable: process.execPath, args: [], timeoutMs: 0 },
    { id: 'fractional-timeout', type: 'command', executable: process.execPath, args: [], timeoutMs: 0.5 },
    { id: 'oversized-timeout', type: 'command', executable: process.execPath, args: [], timeoutMs: 2147483648 },
    { id: 'non-finite-timeout', type: 'command', executable: process.execPath, args: [], timeoutMs: Infinity },
    { id: 'invalid-allow-failure', type: 'command', executable: process.execPath, args: [], allowFailure: 'yes' },
    { id: 'unknown-field', type: 'command', executable: process.execPath, args: [], shell: true }
  ];

  for (const operation of invalidOperations) {
    assert.throws(
      () =>
        createPlanFromDraft({
          source: 'invalid-test',
          summary: operation.id,
          operations: [operation],
          preconditions: []
        }),
      /command|executable|args|timeout|cwd|allowFailure|fields/i,
      `accepted invalid operation ${operation.id}`
    );
  }

  assert.throws(
    () =>
      createPlanFromDraft({
        source: 'invalid-policy-test',
        summary: 'empty policy',
        operations: [nodeWriteOperation('valid', '/tmp/unused', 'unused')],
        preconditions: [],
        execution: { commandPolicy: { mode: 'allow', rules: [] } }
      }),
    /rules/i
  );

  const invalidPolicies = [
    { mode: 'allow', patterns: ['node'] },
    { mode: 'unknown', rules: [{ executable: process.execPath, args: [] }] },
    { mode: 'allow', rules: [{ executable: process.execPath, args: [7] }] },
    { mode: 'allow', rules: [{ executable: 'node\0evil', args: [] }] }
  ];
  for (const commandPolicy of invalidPolicies) {
    assert.throws(
      () =>
        createPlanFromDraft({
          source: 'invalid-policy-test',
          summary: 'invalid policy',
          operations: [nodeWriteOperation('valid', '/tmp/unused', 'unused')],
          preconditions: [],
          execution: { commandPolicy }
        }),
      /policy|mode|rules|args|executable/i
    );
  }

  assert.throws(
    () =>
      createPlanFromDraft({
        source: 'invalid-timeout-test',
        summary: 'fractional plan timeout',
        operations: [nodeWriteOperation('valid', '/tmp/unused', 'unused')],
        preconditions: [],
        execution: { commandTimeoutMs: 0.5 }
      }),
    /integer from 1/i
  );

  assert.throws(
    () =>
      createPlanFromDraft({
        source: 'invalid-timeout-test',
        summary: 'oversized plan timeout',
        operations: [nodeWriteOperation('valid', '/tmp/unused', 'unused')],
        preconditions: [],
        execution: { commandTimeoutMs: 2147483648 }
      }),
    /2147483647/
  );
});

test('unknown operation discriminators fail closed before risk, approval, review, or apply', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-unknown-operation-'));
  try {
    const marker = path.join(root, 'marker.txt');
    const command = nodeWriteOperation('unknown', marker, 'must-not-run');
    const unknown = { ...command, type: 'future-command' };

    assert.throws(
      () =>
        createPlanFromDraft({
          source: 'unknown-operation-test',
          summary: 'Unknown operation must fail closed',
          operations: [unknown],
          preconditions: []
        }),
      /unsupported/i
    );
    assert.throws(() => scoreRisk([unknown]), /unsupported/i);

    const pending = createPlanFromDraft({
      source: 'unknown-operation-test',
      summary: 'Known control before mutation',
      operations: [command],
      preconditions: []
    });
    const pendingUnknown = { ...pending, operations: [unknown] };
    assert.throws(() => approvePlan(pendingUnknown, 'reviewer'), /unsupported/i);

    const approved = approvePlan(pending, 'reviewer');
    const approvedUnknown = { ...approved, operations: [unknown] };
    assert.throws(() => applyPlan(approvedUnknown, { repoRoot: root }), /unsupported/i);
    assert.equal(fs.existsSync(marker), false);

    const reviewPath = path.join(root, 'unknown-plan.json');
    fs.writeFileSync(reviewPath, `${JSON.stringify(approvedUnknown, null, 2)}\n`, 'utf8');
    await assert.rejects(() => reviewPlan(reviewPath), /unsupported/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('structured executable, arguments, and policy are approval-hash-bound', () => {
  const operation = {
    id: 'hash-bound',
    type: 'command',
    executable: process.execPath,
    args: ['--version']
  };
  const plan = approvedCommandPlan(operation, {
    commandPolicy: {
      mode: 'allow',
      rules: [{ executable: process.execPath, args: ['--version'] }]
    }
  });
  assert.equal(plan.version, '2');
  assert.equal(plan.integrity.canonicalizer, 'gatefile-v2');
  assert.equal(plan.integrity.envelopeVersion, 2);

  const mutations = [
    { ...plan, operations: [{ ...plan.operations[0], executable: `${process.execPath}-other` }] },
    { ...plan, operations: [{ ...plan.operations[0], args: ['--help'] }] },
    {
      ...plan,
      execution: {
        commandPolicy: {
          mode: 'allow',
          rules: [{ executable: process.execPath, args: ['--help'] }]
        }
      }
    }
  ];

  for (const mutated of mutations) {
    const report = verifyPlan(mutated);
    assert.equal(report.status, 'not-ready');
    assert.match(report.blockers.join('\n'), /hash|changed/i);
  }
});

test('JSON schema accepts structured commands and rejects legacy command strings', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schema/gatefile.schema.json'), 'utf8')
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const structured = createPlanFromDraft({
    source: 'schema-test',
    summary: 'Structured schema control',
    operations: [
      { id: 'schema-command', type: 'command', executable: process.execPath, args: ['--version'] }
    ],
    preconditions: []
  });
  assert.equal(validate(structured), true, JSON.stringify(validate.errors));

  const multiline = JSON.parse(JSON.stringify(structured));
  multiline.source = '\nagent';
  multiline.summary = 'line one\nline two';
  assert.equal(validate(multiline), true, JSON.stringify(validate.errors));

  const legacy = JSON.parse(JSON.stringify(structured));
  legacy.operations[0] = {
    id: 'schema-command',
    type: 'command',
    command: `${process.execPath} --version`
  };
  assert.equal(validate(legacy), false, 'schema accepted legacy command string');

  const invalidMutations = [
    ['whitespace executable', (plan) => { plan.operations[0].executable = '   '; }],
    ['NUL executable', (plan) => { plan.operations[0].executable = 'node\0evil'; }],
    ['NUL argument', (plan) => { plan.operations[0].args = ['bad\0arg']; }],
    ['whitespace cwd', (plan) => { plan.operations[0].cwd = '\t '; }],
    ['NUL cwd', (plan) => { plan.operations[0].cwd = 'bad\0cwd'; }],
    ['fractional operation timeout', (plan) => { plan.operations[0].timeoutMs = 0.5; }],
    ['oversized operation timeout', (plan) => { plan.operations[0].timeoutMs = 2147483648; }],
    ['fractional default timeout', (plan) => { plan.execution = { commandTimeoutMs: 0.5 }; }],
    ['oversized default timeout', (plan) => { plan.execution = { commandTimeoutMs: 2147483648 }; }],
    [
      'NUL policy executable',
      (plan) => {
        plan.execution = {
          commandPolicy: {
            mode: 'allow',
            rules: [{ executable: 'node\0evil', args: [] }]
          }
        };
      }
    ],
    [
      'NUL policy argument',
      (plan) => {
        plan.execution = {
          commandPolicy: {
            mode: 'allow',
            rules: [{ executable: process.execPath, args: ['bad\0arg'] }]
          }
        };
      }
    ]
  ];
  for (const [name, mutate] of invalidMutations) {
    const invalid = JSON.parse(JSON.stringify(structured));
    mutate(invalid);
    assert.equal(validate(invalid), false, `schema accepted ${name}`);
  }

  const invalidV2Mutations = [
    ['legacy plan version', (plan) => { plan.version = '0.1'; }],
    ['date-only createdAt', (plan) => { plan.createdAt = '2024-01-01'; }],
    ['lowercase timestamp delimiters', (plan) => { plan.createdAt = '2024-01-01t00:00:00z'; }],
    ['leap-second timestamp', (plan) => { plan.createdAt = '2024-12-31T23:59:60Z'; }],
    ['missing repository context', (plan) => { delete plan.context; }],
    ['legacy canonicalizer', (plan) => { plan.integrity.canonicalizer = 'gatefile-v1'; }],
    ['missing hash envelope version', (plan) => { delete plan.integrity.envelopeVersion; }],
    [
      'non-RFC3339 approvedAt',
      (plan) => {
        plan.approval = {
          status: 'approved',
          approvedBy: 'reviewer',
          approvedAt: 'tomorrow',
          approvedPlanHash: plan.integrity.planHash
        };
      }
    ],
    [
      'create with forbidden before',
      (plan) => {
        plan.operations = [
          { id: 'create', type: 'file', action: 'create', path: 'a', before: '', after: '' }
        ];
      }
    ],
    [
      'update without reviewed before',
      (plan) => {
        plan.operations = [
          { id: 'update', type: 'file', action: 'update', path: 'a', after: '' }
        ];
      }
    ],
    [
      'delete with forbidden after',
      (plan) => {
        plan.operations = [
          { id: 'delete', type: 'file', action: 'delete', path: 'a', before: '', after: '' }
        ];
      }
    ]
  ];
  for (const [name, mutate] of invalidV2Mutations) {
    const invalid = JSON.parse(JSON.stringify(structured));
    mutate(invalid);
    assert.equal(validate(invalid), false, `schema accepted ${name}`);
  }
});

test('adapter and preview preserve argument boundaries unambiguously', () => {
  const args = ['-e', 'console.log(process.argv[1])', 'value with spaces', 'semi;colon'];
  const draft = adaptAgentInputToDraft({
    summary: 'Preserve command argument boundaries',
    commands: [{ executable: process.execPath, args }]
  });
  args[2] = 'mutated after adaptation';

  const operation = draft.operations[0];
  assert.deepEqual(operation.args, [
    '-e',
    'console.log(process.argv[1])',
    'value with spaces',
    'semi;colon'
  ]);

  const plan = createPlanFromDraft(draft);
  const preview = previewPlan(plan);
  assert.match(preview.results[0].message, /"executable"/);
  assert.match(preview.results[0].message, /"args"/);
  assert.match(preview.results[0].message, /value with spaces/);
});

test('preview marks exact policy denials without losing argument boundaries', () => {
  const operation = {
    id: 'preview-denied',
    type: 'command',
    executable: process.execPath,
    args: ['--help', 'value with spaces']
  };
  const plan = createPlanFromDraft({
    source: 'preview-test',
    summary: 'Preview policy denial',
    operations: [operation],
    preconditions: [],
    execution: {
      commandPolicy: {
        mode: 'allow',
        rules: [{ executable: process.execPath, args: ['--version'] }]
      }
    }
  });

  const preview = previewPlan(plan);
  assert.match(preview.results[0].message, /DENIED by command policy/);
  assert.match(preview.results[0].message, /"value with spaces"/);
  assert.match(preview.results[0].details, /exactly match/);
});

test('risk scoring recognizes structured destructive executables and split flags', () => {
  const rmRisk = scoreRisk([
    { id: 'rm', type: 'command', executable: '/bin/rm', args: ['-r', '-f', '/tmp/example'] }
  ]);
  const sudoRisk = scoreRisk([
    { id: 'sudo', type: 'command', executable: '/usr/bin/sudo', args: ['true'] }
  ]);

  assert.equal(rmRisk.level, 'medium');
  assert.match(rmRisk.reasons.join('\n'), /Potentially destructive/);
  assert.equal(sudoRisk.level, 'medium');
  assert.match(sudoRisk.reasons.join('\n'), /Potentially destructive/);
});

test('all command policies are preflighted before an earlier file mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-policy-preflight-'));
  try {
    const created = path.join(root, 'must-not-exist.txt');
    const denied = {
      id: 'denied-later',
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)']
    };
    const plan = approvePlan(createPlanFromDraft({
      source: 'structured-command-test',
      summary: 'Deny the whole apply before its first side effect',
      operations: [
        { id: 'file-first', type: 'file', action: 'create', path: created, after: 'bad\n' },
        denied
      ],
      preconditions: [],
      execution: {
        filePolicy: { allowedRoots: [root] },
        commandPolicy: {
          mode: 'deny',
          rules: [{ executable: denied.executable, args: denied.args }]
        }
      }
    }, { repoRoot: root }), 'reviewer');

    const report = applyPlan(plan, { repoRoot: root });
    assert.equal(report.success, false);
    assert.equal(report.results[0].operationId, 'denied-later');
    assert.match(report.results[0].message, /deny mode/);
    assert.equal(fs.existsSync(created), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git top-level is the stable base for relative files and command cwd', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-execution-base-'));
  const root = path.join(base, 'repo');
  const subdir = path.join(root, 'nested');
  try {
    fs.mkdirSync(subdir, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    const plan = approvePlan(createPlanFromDraft({
      source: 'structured-command-test',
      summary: 'Bind relative execution to the repository top-level',
      operations: [
        {
          id: 'relative-file',
          type: 'file',
          action: 'create',
          path: 'file-at-root.txt',
          after: 'root\n'
        },
        {
          id: 'default-command-cwd',
          type: 'command',
          executable: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync("command-at-root.txt", process.cwd())']
        }
      ],
      preconditions: []
    }, { repoRoot: root }), 'reviewer');

    const report = applyPlan(plan, { repoRoot: subdir });
    assert.equal(report.success, true);
    assert.equal(fs.readFileSync(path.join(root, 'file-at-root.txt'), 'utf8'), 'root\n');
    assert.equal(fs.readFileSync(path.join(root, 'command-at-root.txt'), 'utf8'), fs.realpathSync(root));
    assert.equal(fs.existsSync(path.join(subdir, 'file-at-root.txt')), false);
    assert.equal(fs.existsSync(path.join(subdir, 'command-at-root.txt')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
