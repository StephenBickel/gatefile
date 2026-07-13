const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  applyPlan,
  applyPlanFile,
  approvePlan,
  approvePlanFile,
  createPlan,
  createPlanFromDraft,
  generateApprovalAttestationKeyPair,
  repositoryIdForRoot,
  rollbackApply,
  runPipeline
} = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');
const MCP_SERVER_PATH = path.join(__dirname, '..', 'dist', 'mcp-server.js');
const MCP_MODULE_PATH = path.join(__dirname, '..', 'dist', 'mcp.js');

function fixture(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(repoRoot);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, stateHome };
}

function childEnv(stateHome) {
  return { ...process.env, GATEFILE_STATE_HOME: stateHome };
}

function spawnCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    ...options
  });
}

function spawnMcp(requests, options = {}, startup = {}) {
  const script = [
    'const { startMcpServer } = require(process.argv[1]);',
    'startMcpServer(JSON.parse(process.argv[2]));'
  ].join(' ');
  const required = options.require ?? [];
  const { require: _require, ...spawnOptions } = options;
  return spawnSync(process.execPath, [
    ...required.flatMap((modulePath) => ['--require', modulePath]),
    '-e',
    script,
    MCP_MODULE_PATH,
    JSON.stringify(startup)
  ], {
    encoding: 'utf8',
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    ...spawnOptions
  });
}

function callMcp(name, args, options = {}, startup = {}) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  };
  const result = spawnMcp([request], options, startup);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function filePlanDraft(targetPath) {
  return {
    source: 'pr5-integration-test',
    summary: 'PR5 API and CLI integration',
    operations: [
      {
        id: 'op_file_create',
        type: 'file',
        action: 'create',
        path: targetPath,
        after: 'created by PR5 integration test\n'
      }
    ],
    preconditions: [],
    execution: { filePolicy: { allowedRoots: [path.dirname(targetPath)] } }
  };
}

function findFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(full));
    else found.push(full);
  }
  return found;
}

function writeFailedReportHook(root) {
  const hookPath = path.join(root, 'failed-report-hook.cjs');
  fs.writeFileSync(
    hookPath,
    `const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './applier') return loaded;
  return {
    ...loaded,
    applyPlan() {
      return { success: false, source: 'apply-stub' };
    },
    rollbackApply(receiptId) {
      return {
        receiptId,
        snapshotId: 'snapshot-stub',
        rolledBackAt: '2026-01-01T00:00:00.000Z',
        success: false,
        fileResults: [],
        notes: ['forced failed report']
      };
    }
  };
};
`,
    'utf8'
  );
  return hookPath;
}

test('SDK apply returns a complete rollback context that reuses explicit stateHome', async (t) => {
  const f = fixture(t, 'gatefile-pr5-sdk-');
  const target = path.join(f.repoRoot, 'sdk-output.txt');
  const planPath = path.join(f.repoRoot, 'plan.json');

  await createPlan(filePlanDraft(target), { outPath: planPath, repoRoot: f.repoRoot });
  await approvePlanFile(planPath, {
    approvedBy: 'sdk-reviewer',
    repoRoot: f.repoRoot
  });
  const report = await applyPlanFile(planPath, {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome
  });

  assert.equal(report.success, true);
  assert.deepEqual(report.rollbackContext, {
    receiptId: report.receipt.id,
    repoRoot: fs.realpathSync(f.repoRoot),
    repositoryId: repositoryIdForRoot(f.repoRoot),
    stateHome: fs.realpathSync(f.stateHome)
  });
  assert.match(report.rollbackCommand, /--repo-root/);
  assert.match(report.rollbackCommand, /--repository-id/);
  assert.match(report.rollbackCommand, /--state-home/);

  const rollback = rollbackApply(
    report.rollbackContext.receiptId,
    report.rollbackContext
  );
  assert.equal(rollback.success, true);
  assert.equal(fs.existsSync(target), false);
});

test('rollback CLI accepts explicit repository/state flags and can place flags before the receipt', (t) => {
  const f = fixture(t, 'gatefile-pr5-cli-rollback-');
  const target = path.join(f.repoRoot, 'cli-output.txt');
  const repositoryId = 'repo:pr5-cli-explicit';
  const plan = approvePlan(
    createPlanFromDraft(filePlanDraft(target), { context: { repositoryId } }),
    'cli-reviewer',
    { repoRoot: f.repoRoot, repositoryId }
  );
  const applied = applyPlan(plan, {
    repoRoot: f.repoRoot,
    repositoryId,
    stateHome: f.stateHome
  });
  assert.equal(applied.success, true);
  assert.deepEqual(applied.rollbackContext, {
    receiptId: applied.receipt.id,
    repoRoot: fs.realpathSync(f.repoRoot),
    repositoryId,
    stateHome: fs.realpathSync(f.stateHome)
  });
  assert.match(applied.rollbackCommand, /--repo-root.*--repository-id.*--state-home/);

  const unrelatedCwd = path.join(f.base, 'other-cwd');
  const decoyStateHome = path.join(f.base, 'decoy-state');
  fs.mkdirSync(unrelatedCwd);
  const result = spawnCli(
    [
      'rollback-apply',
      '--repo-root',
      f.repoRoot,
      '--repository-id',
      repositoryId,
      '--state-home',
      f.stateHome,
      applied.receipt.id,
      '--yes'
    ],
    { cwd: unrelatedCwd, env: childEnv(decoyStateHome) }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).success, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(decoyStateHome), false);
});

test('rollback CLI exits 1 when rollback returns a failure report', (t) => {
  const f = fixture(t, 'gatefile-pr5-cli-failed-report-');
  const hookPath = writeFailedReportHook(f.base);
  const result = spawnSync(
    process.execPath,
    ['--require', hookPath, CLI_PATH, 'rollback-apply', 'receipt-stub', '--yes'],
    { cwd: f.repoRoot, env: childEnv(f.stateHome), encoding: 'utf8' }
  );

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, false);
  assert.equal(report.receiptId, 'receipt-stub');
});

test('pipeline forwards repositoryId and stateHome through verify and apply', (t) => {
  const f = fixture(t, 'gatefile-pr5-pipeline-');
  const plansDir = path.join(f.repoRoot, 'plans');
  const target = path.join(f.repoRoot, 'pipeline-output.txt');
  const repositoryId = 'repo:pr5-pipeline-explicit';
  fs.mkdirSync(plansDir);

  const plan = approvePlan(
    createPlanFromDraft(filePlanDraft(target), { context: { repositoryId } }),
    'pipeline-reviewer',
    { repoRoot: f.repoRoot, repositoryId }
  );
  fs.writeFileSync(path.join(plansDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  const result = runPipeline(plansDir, {
    repoRoot: f.repoRoot,
    repositoryId,
    stateHome: f.stateHome
  });

  assert.equal(result.success, true, JSON.stringify(result, null, 2));
  assert.equal(fs.readFileSync(target, 'utf8'), 'created by PR5 integration test\n');
  assert.ok(
    findFiles(f.stateHome).some((file) => file.includes(`${path.sep}receipts${path.sep}`)),
    'pipeline apply receipt must be written beneath the explicit state home'
  );
});

test('MCP apply and rollback tool results set isError for failure reports', (t) => {
  const f = fixture(t, 'gatefile-pr5-mcp-failed-report-');
  const hookPath = writeFailedReportHook(f.base);
  const planPath = path.join(f.repoRoot, 'stub-plan.json');
  const plan = createPlanFromDraft(filePlanDraft(path.join(f.repoRoot, 'stub.txt')), {
    repoRoot: f.repoRoot
  });
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, 'utf8');

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'apply_plan', arguments: { path: 'stub-plan.json' } }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'rollback_apply', arguments: { receipt_id: 'receipt-stub' } }
    }
  ];
  const result = spawnMcp(
    requests,
    {
      cwd: f.repoRoot,
      env: childEnv(f.stateHome),
      require: [hookPath]
    },
    {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { apply: true, rollback: true }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  for (const response of responses) {
    assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).success, false);
  }
});

test('MCP approve enforces beforeApprove policy and preserves exact plan bytes', (t) => {
  const f = fixture(t, 'gatefile-pr6-mcp-before-approve-');
  const target = path.join(f.repoRoot, 'blocked-approval-output.txt');
  const planPath = path.join(f.repoRoot, 'blocked-approval-plan.json');
  const plan = createPlanFromDraft(filePlanDraft(target), { repoRoot: f.repoRoot });
  const originalBytes = Buffer.from(`${JSON.stringify(plan, null, 4)}\n\n`, 'utf8');
  fs.writeFileSync(planPath, originalBytes);
  fs.writeFileSync(
    path.join(f.repoRoot, 'gatefile.config.json'),
    JSON.stringify({
      hooks: {
        beforeApprove: {
          command: `"${process.execPath}" -e "process.exit(31)"`
        }
      }
    }),
    'utf8'
  );

  const response = callMcp(
    'approve_plan',
    { path: 'blocked-approval-plan.json' },
    { cwd: f.base, env: childEnv(f.stateHome) },
    {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { approve: true },
      approval: { approvedBy: 'blocked-mcp-reviewer' }
    }
  );

  assert.equal(response.result.isError, true, response.result.content[0].text);
  assert.match(response.result.content[0].text, /Policy hook beforeApprove blocked execution/);
  assert.deepEqual(fs.readFileSync(planPath), originalBytes);
  assert.equal(JSON.parse(originalBytes).approval.status, 'pending');
});

test('MCP signed approval remains adapter-owned and signer policy blocks apply without mutation', (t) => {
  const f = fixture(t, 'gatefile-pr6-mcp-signer-policy-');
  const target = path.join(f.repoRoot, 'untrusted-signer-output.txt');
  const planPath = path.join(f.repoRoot, 'untrusted-signer-plan.json');
  const privateKeyPath = path.join(f.base, 'approval-key.pem');
  const signingKeys = generateApprovalAttestationKeyPair();
  const trustedKeys = generateApprovalAttestationKeyPair();
  const plan = createPlanFromDraft(filePlanDraft(target), { repoRoot: f.repoRoot });
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(privateKeyPath, signingKeys.privateKeyPem, 'utf8');
  fs.writeFileSync(
    path.join(f.repoRoot, 'gatefile.config.json'),
    JSON.stringify({ signers: { trustedKeyIds: [trustedKeys.keyId] } }),
    'utf8'
  );

  const spawnOptions = { cwd: f.base, env: childEnv(f.stateHome) };
  const approveResponse = callMcp(
    'approve_plan',
    { path: 'untrusted-signer-plan.json' },
    spawnOptions,
    {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { approve: true },
      approval: {
        approvedBy: 'signed-mcp-reviewer',
        signingPrivateKeyPem: fs.readFileSync(privateKeyPath, 'utf8'),
        signingKeyId: signingKeys.keyId
      }
    }
  );
  assert.equal(
    approveResponse.result.isError,
    false,
    approveResponse.result.content[0].text
  );
  const approved = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.equal(approved.approval.attestation.keyId, signingKeys.keyId);

  const applyResponse = callMcp(
    'apply_plan',
    { path: 'untrusted-signer-plan.json' },
    spawnOptions,
    {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { apply: true }
    }
  );

  assert.equal(applyResponse.result.isError, true, applyResponse.result.content[0].text);
  assert.match(applyResponse.result.content[0].text, /signer is not trusted/i);
  assert.equal(fs.existsSync(target), false);
});

test('MCP schemas expose no request-selected authority and privileged tools are default-disabled', (t) => {
  const f = fixture(t, 'gatefile-pr5-mcp-schema-');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const result = spawnSync(process.execPath, [MCP_SERVER_PATH], {
    cwd: f.repoRoot,
    env: childEnv(f.stateHome),
    encoding: 'utf8',
    input: `${JSON.stringify(request)}\n`
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  const tools = new Map(response.result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], [
    'inspect_plan',
    'create_plan',
    'verify_plan',
    'dry_run_plan'
  ]);

  for (const [name, tool] of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    const properties = tool.inputSchema.properties;
    for (const authorityField of [
      'repo_root',
      'repository_id',
      'state_home',
      'by',
      'signing_key',
      'key_id'
    ]) {
      assert.equal(properties[authorityField], undefined, `${name}.${authorityField}`);
    }
  }
});

test('MCP startup-pinned runtime context survives unrelated cwd and state environment', (t) => {
  const f = fixture(t, 'gatefile-pr5-mcp-context-');
  const unrelatedCwd = path.join(f.base, 'unrelated');
  const decoyStateHome = path.join(f.base, 'decoy-state');
  fs.mkdirSync(unrelatedCwd);
  const repositoryId = 'repo:pr5-mcp-explicit';
  const target = path.join(f.repoRoot, 'mcp-context-output.txt');
  const planPath = path.join(f.repoRoot, 'apply-plan.json');
  const plan = approvePlan(
    createPlanFromDraft(filePlanDraft(target), { context: { repositoryId } }),
    'mcp-context-reviewer',
    { repoRoot: f.repoRoot, repositoryId }
  );
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const startup = {
    repoRoot: f.repoRoot,
    repositoryId,
    stateHome: f.stateHome,
    capabilities: { apply: true, rollback: true }
  };
  const spawnOptions = {
    cwd: unrelatedCwd,
    env: childEnv(decoyStateHome)
  };

  const appliedResponse = callMcp(
    'apply_plan',
    { path: 'apply-plan.json' },
    spawnOptions,
    startup
  );
  assert.equal(appliedResponse.result.isError, false, appliedResponse.result.content[0].text);
  const applied = JSON.parse(appliedResponse.result.content[0].text);
  assert.equal(applied.success, true);
  assert.deepEqual(applied.rollbackContext, {
    receiptId: applied.receipt.id,
    repoRoot: fs.realpathSync(f.repoRoot),
    repositoryId,
    stateHome: fs.realpathSync(f.stateHome)
  });

  const dependentPath = path.join(f.repoRoot, 'dependent-plan.json');
  const dependent = createPlanFromDraft(
    {
      ...filePlanDraft(path.join(f.repoRoot, 'dependent-output.txt')),
      dependsOn: [plan.id]
    },
    { context: { repositoryId } }
  );
  fs.writeFileSync(dependentPath, `${JSON.stringify(dependent, null, 2)}\n`, 'utf8');

  const inspectedResponse = callMcp(
    'inspect_plan',
    { path: 'dependent-plan.json', json: true },
    spawnOptions,
    startup
  );
  assert.equal(inspectedResponse.result.isError, false, inspectedResponse.result.content[0].text);
  const inspected = JSON.parse(inspectedResponse.result.content[0].text);
  assert.equal(inspected.dependencies.allSatisfied, true);

  const previewResponse = callMcp(
    'dry_run_plan',
    { path: 'dependent-plan.json' },
    spawnOptions,
    startup
  );
  assert.equal(previewResponse.result.isError, false, previewResponse.result.content[0].text);
  const preview = JSON.parse(previewResponse.result.content[0].text);
  assert.equal(preview.dependencies.allSatisfied, true);

  const verifiedResponse = callMcp(
    'verify_plan',
    { path: 'apply-plan.json' },
    spawnOptions,
    startup
  );
  assert.equal(verifiedResponse.result.isError, false, verifiedResponse.result.content[0].text);
  assert.equal(JSON.parse(verifiedResponse.result.content[0].text).status, 'ready');

  const createdPath = path.join(f.repoRoot, 'created-through-mcp.json');
  const createdResponse = callMcp(
    'create_plan',
    {
      draft: filePlanDraft(path.join(f.repoRoot, 'created-through-mcp.txt')),
      out: 'created-through-mcp.json'
    },
    spawnOptions,
    startup
  );
  assert.equal(createdResponse.result.isError, false, createdResponse.result.content[0].text);
  assert.equal(JSON.parse(fs.readFileSync(createdPath, 'utf8')).context.repositoryId, repositoryId);

  const rollbackResponse = callMcp(
    'rollback_apply',
    { receipt_id: applied.receipt.id },
    spawnOptions,
    startup
  );
  assert.equal(rollbackResponse.result.isError, false, rollbackResponse.result.content[0].text);
  assert.equal(JSON.parse(rollbackResponse.result.content[0].text).success, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(decoyStateHome), false);
});

test('generate-attestation-key writes private mode 0600 and public mode 0644', (t) => {
  const f = fixture(t, 'gatefile-pr5-key-mode-');
  const privatePath = path.join(f.base, 'approval-key.pem');
  const publicPath = path.join(f.base, 'approval-key.pub.pem');
  const result = spawnCli(
    [
      'generate-attestation-key',
      '--out-private',
      privatePath,
      '--out-public',
      publicPath
    ],
    { cwd: f.repoRoot, env: childEnv(f.stateHome) }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(publicPath).mode & 0o777, 0o644);
});

test('generate-attestation-key --force refuses private and public symlink outputs', (t) => {
  const f = fixture(t, 'gatefile-pr5-key-symlink-');
  const victim = path.join(f.base, 'victim.txt');
  const privateLink = path.join(f.base, 'private-link.pem');
  fs.writeFileSync(victim, 'do not overwrite\n', 'utf8');
  fs.symlinkSync(victim, privateLink);

  const privateResult = spawnCli(
    ['generate-attestation-key', '--out-private', privateLink, '--force'],
    { cwd: f.repoRoot, env: childEnv(f.stateHome) }
  );
  assert.equal(privateResult.status, 1);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not overwrite\n');
  assert.equal(fs.lstatSync(privateLink).isSymbolicLink(), true);

  const privatePath = path.join(f.base, 'new-private.pem');
  const publicLink = path.join(f.base, 'public-link.pem');
  fs.symlinkSync(victim, publicLink);
  const publicResult = spawnCli(
    [
      'generate-attestation-key',
      '--out-private',
      privatePath,
      '--out-public',
      publicLink,
      '--force'
    ],
    { cwd: f.repoRoot, env: childEnv(f.stateHome) }
  );
  assert.equal(publicResult.status, 1);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not overwrite\n');
  assert.equal(fs.existsSync(privatePath), false, 'all destinations are validated before writing');
});

test('generate-attestation-key rejects case-variant outputs that alias one filesystem entry', (t) => {
  const f = fixture(t, 'gatefile-pr5-key-case-alias-');
  const probeUpper = path.join(f.base, 'CaseProbe');
  const probeLower = path.join(f.base, 'caseprobe');
  fs.writeFileSync(probeUpper, 'probe', 'utf8');
  const caseInsensitive = fs.existsSync(probeLower);
  fs.unlinkSync(probeUpper);
  if (!caseInsensitive) {
    t.skip('filesystem is case-sensitive');
    return;
  }

  const privatePath = path.join(f.base, 'Signer.pem');
  const publicPath = path.join(f.base, 'signer.pem');
  const result = spawnCli(
    [
      'generate-attestation-key',
      '--out-private',
      privatePath,
      '--out-public',
      publicPath,
      '--force'
    ],
    { cwd: f.repoRoot, env: childEnv(f.stateHome) }
  );

  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(privatePath), false);
  assert.equal(fs.existsSync(publicPath), false);
});

test('the packaged gatefile-mcp executable target exists and serves initialize', (t) => {
  const f = fixture(t, 'gatefile-pr5-mcp-bin-');
  const packageVersion = require('../package.json').version;
  assert.equal(fs.existsSync(MCP_SERVER_PATH), true, 'package bin target must be built');
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  };
  const result = spawnSync(process.execPath, [MCP_SERVER_PATH], {
    cwd: f.repoRoot,
    env: childEnv(f.stateHome),
    encoding: 'utf8',
    input: `${JSON.stringify(request)}\n`
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'gatefile');
  assert.equal(response.result.serverInfo.version, packageVersion);
});
