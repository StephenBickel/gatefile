const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  createPlanFromDraft,
  approvePlan,
  verifyPlan,
  generateApprovalAttestationKeyPair,
  normalizeGatefileConfig,
  validatePlanFile,
  verifyApprovalAttestation
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

test('approval signing accepts only Ed25519 keys and their derived key ID', () => {
  const plan = createPlanFromDraft(makeDraft());
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPrivatePem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(
    () => approvePlan(plan, 'ci-user', { signingPrivateKeyPem: rsaPrivatePem }),
    /valid Ed25519 private key|must use Ed25519/i
  );

  const keys = generateApprovalAttestationKeyPair();
  assert.throws(
    () => approvePlan(plan, 'ci-user', {
      signingPrivateKeyPem: keys.privateKeyPem,
      signingKeyId: 'gfk1_0000000000000000'
    }),
    /key ID must match the signing key/i
  );
});

test('plan validation rejects private or non-Ed25519 attestation public-key material', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const privatePemPlan = {
    ...approved,
    approval: {
      ...approved.approval,
      attestation: {
        ...approved.approval.attestation,
        publicKeyPem: keys.privateKeyPem
      }
    }
  };

  assert.throws(
    () => validatePlanFile(privatePemPlan),
    /approval\.attestation\.publicKeyPem.*Ed25519 SPKI public PEM/i
  );
  assert.throws(
    () => verifyPlan(privatePemPlan, {
      config: { signers: { trustedPublicKeys: [keys.publicKeyPem] } }
    }),
    /approval\.attestation\.publicKeyPem.*Ed25519 SPKI public PEM/i
  );
});

test('approval signatures require canonical base64 for exactly 64 Ed25519 bytes', () => {
  const plan = createPlanFromDraft(makeDraft());
  const keys = generateApprovalAttestationKeyPair();
  const approved = approvePlan(plan, 'ci-user', { signingPrivateKeyPem: keys.privateKeyPem });
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'schema', 'gatefile.schema.json'),
    'utf8'
  ));
  const fields = {
    planId: approved.id,
    approvedBy: approved.approval.approvedBy,
    approvedAt: approved.approval.approvedAt,
    approvedPlanHash: approved.approval.approvedPlanHash
  };

  for (const suffix of ['!!!!', '\nignored', '====']) {
    const attestation = {
      ...approved.approval.attestation,
      signature: `${approved.approval.attestation.signature}${suffix}`
    };
    const tampered = {
      ...approved,
      approval: { ...approved.approval, attestation }
    };
    assert.throws(
      () => validatePlanFile(tampered),
      /approval\.attestation\.signature.*canonical base64.*64-byte/i
    );
    assert.equal(validateAgainstSchema(schema, tampered).valid, false);
    assert.equal(verifyApprovalAttestation(fields, attestation).valid, false);
  }

  const wrongScheme = {
    ...approved.approval.attestation,
    scheme: 'none'
  };
  const wrongSchemeResult = verifyApprovalAttestation(fields, wrongScheme);
  assert.equal(wrongSchemeResult.schemeMatches, false);
  assert.equal(wrongSchemeResult.valid, false);
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
        trustedKeyIds: ['gfk1_1111111111111111']
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
        trustedKeyIds: ['gfk1_1111111111111111']
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
          trustedKeyIds: ['gfk1_1111111111111111']
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

test('CLI plan commands reject symlink and oversized plan artifacts', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-cli-artifacts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const victim = path.join(root, 'victim.json');
  const planPath = path.join(root, 'plan.json');
  const pending = createPlanFromDraft(makeDraft(), { repoRoot: root });
  const victimBytes = `${JSON.stringify(pending, null, 2)}\n`;
  fs.writeFileSync(victim, victimBytes);
  fs.symlinkSync(victim, planPath);

  const symlinkResult = spawnSync(
    process.execPath,
    [CLI_PATH, 'approve-plan', planPath, '--by', 'cli-reviewer'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(symlinkResult.status, 1);
  assert.match(symlinkResult.stderr, /symbolic link/i);
  assert.equal(fs.readFileSync(victim, 'utf8'), victimBytes);

  fs.unlinkSync(planPath);
  fs.writeFileSync(planPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  const oversizedResult = spawnSync(
    process.execPath,
    [CLI_PATH, 'inspect-plan', planPath],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, /16777216-byte read limit/i);

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-cli-parent-link-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const draftPath = path.join(root, 'draft.json');
  fs.writeFileSync(draftPath, `${JSON.stringify(makeDraft(), null, 2)}\n`);
  fs.symlinkSync(outside, path.join(root, '.plan'));
  const ancestorResult = spawnSync(
    process.execPath,
    [CLI_PATH, 'create-plan', '--from', draftPath, '--out', '.plan/created.json'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(ancestorResult.status, 1);
  assert.match(ancestorResult.stderr, /parent contains a symbolic link/i);
  assert.equal(fs.existsSync(path.join(outside, 'created.json')), false);
});

test('CLI lint-config reports trust policy state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-lint-config-cli-'));
  const configPath = path.join(root, 'gatefile.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        signers: {
          trustedKeyIds: ['gfk1_0123456789abcdef']
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
