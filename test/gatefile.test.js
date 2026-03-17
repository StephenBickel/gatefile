const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createPlanFromDraft,
  approvePlan,
  verifyPlan,
  generateApprovalAttestationKeyPair,
  normalizeGatefileConfig
} = require('../dist');
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node ? node[key] : undefined), rootSchema);
}

function isDateTimeString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateAgainstSchema(schema, data, rootSchema = schema, pathLabel = '$') {
  const errors = [];

  if (schema.$ref) {
    const target = resolveRef(rootSchema, schema.$ref);
    if (!target) {
      return { valid: false, errors: [`${pathLabel}: unresolved $ref ${schema.$ref}`] };
    }
    return validateAgainstSchema(target, data, rootSchema, pathLabel);
  }

  if (schema.type) {
    const isArray = Array.isArray(data);
    const isObject = typeof data === 'object' && data !== null && !isArray;
    const typeMatches = {
      object: isObject,
      array: isArray,
      string: typeof data === 'string',
      number: typeof data === 'number' && Number.isFinite(data),
      boolean: typeof data === 'boolean'
    }[schema.type];

    if (!typeMatches) {
      errors.push(`${pathLabel}: expected type ${schema.type}`);
      return { valid: false, errors };
    }
  }

  if (schema.required) {
    for (const key of schema.required) {
      if (typeof data !== 'object' || data === null || !(key in data)) {
        errors.push(`${pathLabel}: missing required property ${key}`);
      }
    }
  }

  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in data) {
        const result = validateAgainstSchema(
          propSchema,
          data[key],
          rootSchema,
          `${pathLabel}.${key}`
        );
        if (!result.valid) {
          errors.push(...result.errors);
        }
      }
    }
  }

  if (schema.items && Array.isArray(data)) {
    data.forEach((item, index) => {
      const result = validateAgainstSchema(schema.items, item, rootSchema, `${pathLabel}[${index}]`);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    });
  }

  if (typeof schema.minItems === 'number' && Array.isArray(data) && data.length < schema.minItems) {
    errors.push(`${pathLabel}: expected at least ${schema.minItems} items`);
  }

  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${pathLabel}: value ${JSON.stringify(data)} not in enum`);
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && data !== schema.const) {
    errors.push(`${pathLabel}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${pathLabel}: string does not match pattern ${schema.pattern}`);
  }

  if (schema.format === 'date-time' && !isDateTimeString(data)) {
    errors.push(`${pathLabel}: expected RFC3339 date-time string`);
  }

  if (schema.allOf) {
    for (const part of schema.allOf) {
      const result = validateAgainstSchema(part, data, rootSchema, pathLabel);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    }
  }

  if (schema.oneOf) {
    const passing = schema.oneOf.filter((candidate) =>
      validateAgainstSchema(candidate, data, rootSchema, pathLabel).valid
    );
    if (passing.length !== 1) {
      errors.push(`${pathLabel}: expected exactly one oneOf branch to match`);
    }
  }

  if (schema.if && schema.then) {
    const ifResult = validateAgainstSchema(schema.if, data, rootSchema, pathLabel);
    if (ifResult.valid) {
      const thenResult = validateAgainstSchema(schema.then, data, rootSchema, pathLabel);
      if (!thenResult.valid) {
        errors.push(...thenResult.errors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function makeDraft() {
  return {
    source: 'test-agent',
    summary: 'Create a small file',
    operations: [
      {
        id: 'op_file_1',
        type: 'file',
        action: 'create',
        path: 'tmp/demo.txt',
        after: 'hello'
      }
    ],
    preconditions: [{ kind: 'git_clean' }]
  };
}

test('createPlanFromDraft -> verifyPlan before approval is not-ready', () => {
  const plan = createPlanFromDraft(makeDraft());
  const report = verifyPlan(plan);

  assert.equal(report.status, 'not-ready');
  assert.equal(report.approvalStatus, 'pending');
  assert.equal(report.checks.integrityMetadataExists, true);
  assert.equal(report.checks.recordedHashMatchesCurrent, true);
  assert.equal(report.checks.approvalBoundToCurrentHash, false);
});

test('approvePlan -> verifyPlan becomes ready', () => {
  const plan = createPlanFromDraft(makeDraft());
  const approved = approvePlan(plan, 'ci-user');
  const report = verifyPlan(approved);

  assert.equal(report.status, 'ready');
  assert.equal(report.approvalStatus, 'approved');
  assert.equal(report.checks.approvalBoundToCurrentHash, true);
  assert.equal(report.approvalIdentity, 'unsigned');
});

test('approvePlan with signing key adds valid signed attestation', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const report = verifyPlan(approved);

  assert.equal(approved.approval.attestation?.scheme, 'ed25519-sha256');
  assert.equal(report.status, 'ready');
  assert.equal(report.approvalIdentity, 'signed');
  assert.equal(report.checks.approvalAttestationPresent, true);
  assert.equal(report.checks.approvalAttestationValid, true);
  assert.equal(report.checks.approvalAttestationKeyIdMatches, true);
  assert.equal(report.checks.approvalAttestationPayloadMatchesApproval, true);
  assert.equal(report.signerTrust.status, 'not-configured');
});

test('verifyPlan marks signed approval as trusted when keyId is configured', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const report = verifyPlan(approved, {
    config: {
      signers: {
        trustedKeyIds: [keys.keyId]
      }
    }
  });

  assert.equal(report.status, 'ready');
  assert.equal(report.signerTrust.policyConfigured, true);
  assert.equal(report.signerTrust.status, 'trusted');
  assert.equal(report.signerTrust.matchedBy, 'keyId');
  assert.equal(report.checks.signerTrusted, true);
});

test('verifyPlan blocks signed approvals from untrusted key IDs when policy is configured', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const report = verifyPlan(approved, {
    config: {
      signers: {
        trustedKeyIds: ['trusted-signer-1']
      }
    }
  });

  assert.equal(report.status, 'not-ready');
  assert.equal(report.signerTrust.status, 'untrusted');
  assert.equal(report.checks.signerTrusted, false);
  assert.match(report.blockers.join('\n'), /not trusted/);
});

test('verifyPlan blocks unsigned approval when signer trust policy is configured', () => {
  const plan = createPlanFromDraft(makeDraft());
  const approved = approvePlan(plan, 'ci-user');
  const report = verifyPlan(approved, {
    config: {
      signers: {
        trustedKeyIds: ['trusted-signer-1']
      }
    }
  });

  assert.equal(report.status, 'not-ready');
  assert.equal(report.signerTrust.status, 'unsigned');
  assert.match(report.blockers.join('\n'), /approval is unsigned/);
});

test('verifyPlan throws on empty signer trust policy config', () => {
  const plan = approvePlan(createPlanFromDraft(makeDraft()), 'ci-user');
  assert.throws(
    () =>
      verifyPlan(plan, {
        config: {
          signers: {
            trustedKeyIds: ['   ']
          }
        }
      }),
    /trust policy is empty/
  );
});

test('normalizeGatefileConfig rejects malformed trusted public keys', () => {
  assert.throws(
    () =>
      normalizeGatefileConfig({
        signers: {
          trustedPublicKeys: ['not-a-pem']
        }
      }),
    /valid PEM-encoded public key/
  );
});

test('verifyPlan trusts canonicalized public key PEM values', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const report = verifyPlan(approved, {
    config: {
      signers: {
        trustedPublicKeys: [keys.publicKeyPem.replace(/\n/g, '\r\n')]
      }
    }
  });

  assert.equal(report.status, 'ready');
  assert.equal(report.signerTrust.status, 'trusted');
  assert.equal(report.signerTrust.matchedBy, 'publicKey');
});

test('tampered signed approval attestation is blocked', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const tampered = {
    ...approved,
    approval: {
      ...approved.approval,
      approvedBy: 'someone-else'
    }
  };

  const report = verifyPlan(tampered);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.approvalIdentity, 'invalid-attestation');
  assert.equal(report.checks.approvalAttestationPresent, true);
  assert.equal(report.checks.approvalAttestationValid, false);
  assert.match(report.blockers.join('\n'), /attestation is invalid/);
});

test('tampered approved plan -> verifyPlan becomes not-ready', () => {
  const plan = createPlanFromDraft(makeDraft());
  const approved = approvePlan(plan, 'ci-user');
  const tampered = {
    ...approved,
    summary: `${approved.summary} (tampered)`
  };
  const report = verifyPlan(tampered);

  assert.equal(report.approvalStatus, 'approved');
  assert.equal(report.status, 'not-ready');
  assert.equal(report.checks.recordedHashMatchesCurrent, false);
  assert.equal(report.checks.approvalBoundToCurrentHash, false);
});

test('generated plan validates against JSON schema', () => {
  const schemaPath = path.join(__dirname, '..', 'schema', 'gatefile.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const pending = createPlanFromDraft(makeDraft());
  const approved = approvePlan(pending, 'ci-user');

  const pendingResult = validateAgainstSchema(schema, pending);
  const approvedResult = validateAgainstSchema(schema, approved);

  assert.equal(pendingResult.valid, true, pendingResult.errors.join('\n'));
  assert.equal(approvedResult.valid, true, approvedResult.errors.join('\n'));
});

test('CLI generate-attestation-key + approve-plan --signing-key creates signed approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-attest-cli-'));
  const draftPath = path.join(root, 'draft.json');
  const planPath = path.join(root, 'plan.json');
  const privateKeyPath = path.join(root, 'approver.pem');
  const publicKeyPath = path.join(root, 'approver.pub.pem');

  fs.writeFileSync(draftPath, JSON.stringify(makeDraft(), null, 2));

  try {
    execFileSync(process.execPath, [CLI_PATH, 'create-plan', '--from', draftPath, '--out', planPath], {
      encoding: 'utf8'
    });
    execFileSync(
      process.execPath,
      [
        CLI_PATH,
        'generate-attestation-key',
        '--out-private',
        privateKeyPath,
        '--out-public',
        publicKeyPath
      ],
      { encoding: 'utf8' }
    );
    execFileSync(
      process.execPath,
      [CLI_PATH, 'approve-plan', planPath, '--by', 'cli-user', '--signing-key', privateKeyPath],
      { encoding: 'utf8' }
    );
  } catch (error) {
    if (error && error.code === 'EPERM') {
      return;
    }
    throw error;
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const verify = verifyPlan(plan);
  assert.equal(fs.existsSync(privateKeyPath), true);
  assert.equal(fs.existsSync(publicKeyPath), true);
  assert.equal(verify.approvalIdentity, 'signed');
  assert.equal(verify.status, 'ready');
});

test('CLI verify-plan enforces signer trust policy from gatefile.config.json', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-verify-trust-cli-'));
  const planPath = path.join(root, 'plan.json');
  const configPath = path.join(root, 'gatefile.config.json');
  const approved = approvePlan(createPlanFromDraft(makeDraft()), 'cli-user');

  fs.writeFileSync(planPath, JSON.stringify(approved, null, 2));
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        signers: {
          trustedKeyIds: ['trusted-signer-1']
        }
      },
      null,
      2
    )
  );

  let output;
  try {
    output = execFileSync(process.execPath, [CLI_PATH, 'verify-plan', planPath], {
      encoding: 'utf8',
      cwd: root
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('subprocess execution is blocked in this environment');
      return;
    }
    throw error;
  }
  const report = JSON.parse(output);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.signerTrust.status, 'unsigned');
  assert.match(report.blockers.join('\n'), /Signer trust policy is configured/);
});

test('CLI lint-config reports trust policy state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-lint-config-cli-'));
  const configPath = path.join(root, 'gatefile.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        signers: {
          trustedKeyIds: ['security-team-prod-1']
        }
      },
      null,
      2
    )
  );

  let output;
  try {
    output = execFileSync(process.execPath, [CLI_PATH, 'lint-config'], {
      encoding: 'utf8',
      cwd: root
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('subprocess execution is blocked in this environment');
      return;
    }
    throw error;
  }

  assert.match(output, /Gatefile config valid:/);
  assert.match(output, /trust policy configured/);
});

test('CLI lint-config fails for malformed trusted public keys', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-lint-config-invalid-cli-'));
  fs.writeFileSync(
    path.join(root, 'gatefile.config.json'),
    JSON.stringify(
      {
        signers: {
          trustedPublicKeys: ['not-a-pem']
        }
      },
      null,
      2
    )
  );

  try {
    execFileSync(process.execPath, [CLI_PATH, 'lint-config'], {
      encoding: 'utf8',
      cwd: root
    });
    assert.fail('expected lint-config to fail');
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('subprocess execution is blocked in this environment');
      return;
    }
    const stderr = error && typeof error.stderr === 'string' ? error.stderr : '';
    assert.match(stderr, /Invalid Gatefile config/);
    assert.match(stderr, /valid PEM-encoded public key/);
  }
});
