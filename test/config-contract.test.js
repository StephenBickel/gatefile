const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
      trustedKeyIds: ['gfk1_0123456789abcdef'],
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
    { signerz: { trustedKeyIds: ['gfk1_0123456789abcdef'] } },
    { signers: { trustedKeyIds: ['gfk1_0123456789abcdef'], trustEveryone: true } },
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
    [{ signers: { trustedKeyIds: ['security-team-prod-1'] } }, false],
    [{ signers: { trustedKeyIds: [' gfk1_0123456789abcdef'] } }, false],
    [{ signers: { trustedKeyIds: ['gfk1_0123456789abcdef\t'] } }, false],
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

test('runtime signer diagnostics retain the original array index after deduplication', () => {
  assert.throws(
    () => normalizeGatefileConfig({
      signers: {
        trustedKeyIds: [
          'gfk1_0123456789abcdef',
          'gfk1_0123456789abcdef',
          'not-a-derived-key-id'
        ]
      }
    }),
    (error) => (
      error instanceof GatefileConfigError &&
      error.issues.some((issue) => issue.path === 'signers.trustedKeyIds[2]')
    )
  );
});

test('schema and runtime accept only Ed25519 SPKI public keys as signer material', () => {
  const ed25519 = generateKeyPairSync('ed25519');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const canonicalEd25519 = ed25519.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const nonCanonicalLines = canonicalEd25519.trim().split('\n');
  const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encodedKey = nonCanonicalLines[1];
  const finalDataIndex = base64Alphabet.indexOf(encodedKey.at(-2));
  nonCanonicalLines[1] =
    `${encodedKey.slice(0, -2)}${base64Alphabet[finalDataIndex + 1]}=`;
  const nonCanonicalEd25519 = nonCanonicalLines.join('\n');
  const cases = [
    [canonicalEd25519, true],
    [ed25519.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), false],
    [rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString(), false],
    ['-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', false],
    [nonCanonicalEd25519, false]
  ];

  for (const [key, expected] of cases) {
    const config = { signers: { trustedPublicKeys: [key] } };
    assert.equal(
      validatesSchema(config),
      expected,
      `unexpected schema result for ${key.split('\n')[0]}: ${JSON.stringify(validatesSchema.errors)}`
    );
    assert.equal(
      runtimeAccepts(config),
      expected,
      `unexpected runtime result for ${key.split('\n')[0]}`
    );
  }
});

test('schema and runtime allow an empty optional signer array when the other source is non-empty', () => {
  const configs = [
    {
      signers: {
        trustedKeyIds: [],
        trustedPublicKeys: [publicKeyPem]
      }
    },
    {
      signers: {
        trustedKeyIds: ['gfk1_0123456789abcdef'],
        trustedPublicKeys: []
      }
    }
  ];

  for (const config of configs) {
    assert.equal(
      validatesSchema(config),
      true,
      `schema rejected ${JSON.stringify(config)}: ${JSON.stringify(validatesSchema.errors)}`
    );
    assert.equal(runtimeAccepts(config), true, `runtime rejected ${JSON.stringify(config)}`);
  }
});

test('schema and runtime share the documented lexical webhook contract', () => {
  const cases = [
    ['https://example.com/event', true],
    ['http://example.com/event', true],
    ['http://127.0.0.1:65535/event', true],
    ['HTTPS://example.com/event', false],
    ['HTTP://example.com/event', false],
    ['http://', false],
    ['http://?x', false],
    ['http://#x', false],
    ['http://example.com/%zz', true],
    ['http://例.example/event', true],
    ['http://example.com\\redirect', false]
  ];

  for (const [webhook, expected] of cases) {
    const config = { notifications: { onPlanCreated: { webhook } } };
    assert.equal(
      validatesSchema(config),
      expected,
      `unexpected schema result for ${webhook}: ${JSON.stringify(validatesSchema.errors)}`
    );
    assert.equal(runtimeAccepts(config), expected, `unexpected runtime result for ${webhook}`);
  }
});

test('runtime rejects webhook URLs that pass the schema prefilter but cannot be dispatched', () => {
  const malformedAuthorities = [
    'http://%',
    'http://[',
    'http://:80',
    'http://a:b',
    'http://user@:80',
    'http://example.com:65536',
    'http://example.com:99999'
  ];

  for (const webhook of malformedAuthorities) {
    const config = { notifications: { onPlanCreated: { webhook } } };
    assert.equal(
      validatesSchema(config),
      true,
      `fixture no longer exercises the schema's lexical prefilter: ${webhook}`
    );
    assert.equal(runtimeAccepts(config), false, `runtime accepted undispatchable URL ${webhook}`);
  }
});

test('public GatefileConfig types require non-empty signer and notification shapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-config-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.resolve(__dirname, '..');

  fs.writeFileSync(path.join(root, 'consumer.ts'), `
import type { GatefileConfig } from ${JSON.stringify(path.join(packageRoot, 'dist'))};

const validKeyId: GatefileConfig = { signers: { trustedKeyIds: ['gfk1_0123456789abcdef'] } };
const validPublicKey: GatefileConfig = { signers: { trustedPublicKeys: ['public-key-pem'] } };
const emptyOptionalIds: GatefileConfig = {
  signers: { trustedKeyIds: [], trustedPublicKeys: ['public-key-pem'] }
};
const emptyOptionalKeys: GatefileConfig = {
  signers: { trustedKeyIds: ['gfk1_0123456789abcdef'], trustedPublicKeys: [] }
};
const validWebhook: GatefileConfig = {
  notifications: { onPlanCreated: { webhook: 'https://example.com/event' } }
};
const validShell: GatefileConfig = {
  notifications: { onPlanApproved: { shell: 'node notify.js' } }
};
const validLegacyCreatedWithCanonicalApproved: GatefileConfig = {
  hooks: { onPlanCreated: { shell: 'node legacy-created.js' } },
  notifications: { onPlanApproved: { shell: 'node approved.js' } }
};

// @ts-expect-error A signer policy must contain at least one non-empty trust source.
const emptySigners: GatefileConfig = { signers: {} };
// @ts-expect-error An empty key ID array is not a trust source.
const emptyKeyIds: GatefileConfig = { signers: { trustedKeyIds: [] } };
// @ts-expect-error An empty public-key array is not a trust source.
const emptyPublicKeys: GatefileConfig = { signers: { trustedPublicKeys: [] } };
// @ts-expect-error A notification action must select a webhook or shell command.
const emptyNotification: GatefileConfig = { notifications: { onPlanCreated: {} } };
// @ts-expect-error Deprecated and canonical plan-created actions conflict.
const conflictingCreated: GatefileConfig = {
  hooks: { onPlanCreated: { shell: 'node old.js' } },
  notifications: { onPlanCreated: { shell: 'node new.js' } }
};
// @ts-expect-error Deprecated and canonical approval actions conflict.
const conflictingApproved: GatefileConfig = {
  hooks: { onApprovalNeeded: { shell: 'node old.js' } },
  notifications: { onPlanApproved: { shell: 'node new.js' } }
};

void [
  validKeyId,
  validPublicKey,
  emptyOptionalIds,
  emptyOptionalKeys,
  validWebhook,
  validShell,
  validLegacyCreatedWithCanonicalApproved,
  emptySigners,
  emptyKeyIds,
  emptyPublicKeys,
  emptyNotification,
  conflictingCreated,
  conflictingApproved
];
`, 'utf8');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      lib: ['ES2020'],
      module: 'commonjs',
      moduleResolution: 'node'
    },
    files: ['consumer.ts']
  }, null, 2)}\n`, 'utf8');

  const tsc = path.join(packageRoot, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(tsc, ['-p', path.join(root, 'tsconfig.json')], {
    cwd: root,
    encoding: 'utf8',
    shell: false
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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

test('deprecated approval notification API dispatches the canonical plan-approved action', async (t) => {
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
