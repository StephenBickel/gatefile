const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;

const {
  GatefileConfigError,
  normalizeGatefileConfig
} = require('../dist/config');
const {
  fireOnApprovalNeeded,
  fireOnPlanCreated,
  fireOnPlanApproved,
  loadHooksConfig
} = require('../dist/hooks');

const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schema', 'gatefile.config.schema.json'), 'utf8')
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatesSchema = ajv.compile(schema);

const publicKeyPem = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEA3BpXovQEPSywMnUz4IdaCBTGcIH+6gRV9kt1SMjg7bE=',
  '-----END PUBLIC KEY-----'
].join('\n');

function runtimeAccepts(value) {
  try {
    normalizeGatefileConfig(value);
    return true;
  } catch {
    return false;
  }
}

test('canonical config is accepted identically by the schema and runtime normalizer', () => {
  const config = {
    signers: {
      trustedKeyIds: ['security-team-prod-1'],
      trustedPublicKeys: [publicKeyPem]
    },
    hooks: {
      beforeApprove: {
        command: 'node ./scripts/before-approve.js',
        cwd: 'automation'
      },
      beforeApply: {
        command: 'node ./scripts/before-apply.js'
      }
    },
    notifications: {
      onPlanCreated: {
        webhook: 'https://example.com/plan-created',
        shell: 'node ./scripts/plan-created.js'
      },
      onPlanApproved: {
        webhook: 'http://127.0.0.1:8080/plan-approved'
      }
    }
  };

  assert.equal(validatesSchema(config), true, JSON.stringify(validatesSchema.errors, null, 2));
  assert.deepEqual(normalizeGatefileConfig(config), config);
});

test('schema and runtime reject unknown config keys instead of failing policy open', () => {
  const invalidConfigs = [
    { signerz: { trustedKeyIds: ['security-team-prod-1'] } },
    { signers: { trustedKeyIds: ['security-team-prod-1'], trustEveryone: true } },
    { hooks: { beforeApplly: { command: 'exit 1' } } },
    { hooks: { beforeApply: { command: 'exit 1', ignoreFailure: true } } },
    { notifications: { onPlanCreate: { shell: 'echo typo' } } },
    { notifications: { onPlanCreated: { shell: 'echo ok', ignoreFailure: true } } }
  ];

  for (const config of invalidConfigs) {
    assert.equal(validatesSchema(config), false, `schema accepted ${JSON.stringify(config)}`);
    assert.throws(
      () => normalizeGatefileConfig(config, '/repo/gatefile.config.json'),
      (error) =>
        error instanceof GatefileConfigError &&
        error.configPath === '/repo/gatefile.config.json' &&
        /unknown field/.test(error.message),
      `runtime accepted ${JSON.stringify(config)}`
    );
  }
});

test('schema and runtime enforce policy, signer, and notification shapes consistently', () => {
  const cases = [
    [{}, true],
    [{ hooks: { beforeApply: { command: 'node check.js' } } }, true],
    [{ hooks: { beforeApply: { command: '   ' } } }, false],
    [{ hooks: { beforeApply: { command: 'node\u0000check.js' } } }, false],
    [{ signers: { trustedKeyIds: [] } }, false],
    [{ signers: { trustedKeyIds: ['trusted\u0000suffix'] } }, false],
    [{ signers: { trustedPublicKeys: ['not a public key'] } }, false],
    [{ notifications: { onPlanCreated: {} } }, false],
    [{ notifications: { onPlanCreated: { webhook: 'ftp://example.com/event' } } }, false],
    [{ notifications: { onPlanCreated: { webhook: ' https://example.com/event' } } }, false],
    [{ notifications: { onPlanApproved: { shell: '   ' } } }, false],
    [{ notifications: { onPlanApproved: { shell: 'echo\u0000approved' } } }, false]
  ];

  for (const [config, expected] of cases) {
    const schemaAccepted = validatesSchema(config);
    const runtimeAccepted = runtimeAccepts(config);
    assert.equal(
      schemaAccepted,
      expected,
      `unexpected schema result for ${JSON.stringify(config)}: ${JSON.stringify(validatesSchema.errors)}`
    );
    assert.equal(runtimeAccepted, expected, `unexpected runtime result for ${JSON.stringify(config)}`);
  }
});

test('deprecated notification hook keys migrate to canonical notifications', () => {
  const legacy = {
    hooks: {
      beforeApply: { command: 'node ./scripts/policy.js' },
      onPlanCreated: { shell: 'node ./scripts/created.js' },
      onApprovalNeeded: { webhook: 'https://example.com/approved' }
    }
  };

  assert.equal(validatesSchema(legacy), true, JSON.stringify(validatesSchema.errors, null, 2));
  assert.deepEqual(normalizeGatefileConfig(legacy), {
    hooks: {
      beforeApply: { command: 'node ./scripts/policy.js' }
    },
    notifications: {
      onPlanCreated: { shell: 'node ./scripts/created.js' },
      onPlanApproved: { webhook: 'https://example.com/approved' }
    }
  });
});

test('canonical and deprecated notification keys cannot configure the same event twice', () => {
  const conflicts = [
    {
      hooks: { onPlanCreated: { shell: 'echo legacy' } },
      notifications: { onPlanCreated: { shell: 'echo canonical' } }
    },
    {
      hooks: { onApprovalNeeded: { shell: 'echo legacy' } },
      notifications: { onPlanApproved: { shell: 'echo canonical' } }
    }
  ];

  for (const config of conflicts) {
    assert.equal(validatesSchema(config), false, `schema accepted ${JSON.stringify(config)}`);
    assert.throws(
      () => normalizeGatefileConfig(config),
      (error) => error instanceof GatefileConfigError && /configured twice/.test(error.message)
    );
  }
});

test('notification loading and shell execution use the explicitly pinned repository root', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-config-context-'));
  const repoPath = path.join(base, 'repo');
  fs.mkdirSync(repoPath);
  const repoRoot = fs.realpathSync(repoPath);
  const marker = path.join(base, 'notification-cwd.txt');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const shell = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`
  )}`;
  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    `${JSON.stringify({ notifications: { onPlanCreated: { shell } } }, null, 2)}\n`,
    'utf8'
  );

  assert.deepEqual(loadHooksConfig({ repoRoot }), {
    onPlanCreated: { shell }
  });

  await fireOnPlanCreated(
    {
      id: 'plan_notification_context',
      summary: 'Pinned notification context',
      source: 'config-contract-test',
      operations: [],
      risk: { score: 0, level: 'low', reasons: [] },
      approval: { status: 'pending' }
    },
    { repoRoot }
  );

  assert.equal(fs.readFileSync(marker, 'utf8'), repoRoot);
});

test('deprecated approval notification API dispatches the canonical plan-approved event', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-config-approved-alias-'));
  const repoPath = path.join(base, 'repo');
  fs.mkdirSync(repoPath);
  const repoRoot = fs.realpathSync(repoPath);
  const marker = path.join(base, 'approved.txt');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const shell = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'approved')`
  )}`;
  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    `${JSON.stringify({ notifications: { onPlanApproved: { shell } } }, null, 2)}\n`,
    'utf8'
  );
  const plan = {
    id: 'plan_approved_notification',
    summary: 'Approved notification compatibility',
    source: 'config-contract-test',
    operations: [],
    risk: { score: 0, level: 'low', reasons: [] },
    approval: { status: 'approved', approvedBy: 'reviewer' }
  };

  assert.deepEqual(loadHooksConfig({ repoRoot }), {
    onPlanApproved: { shell },
    onApprovalNeeded: { shell }
  });

  await fireOnPlanApproved(plan, { repoRoot });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'approved');
  fs.rmSync(marker);

  await fireOnApprovalNeeded(plan, { repoRoot });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'approved');
});
