const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const PINNED_GATEFILE_ACTION_SHA = '9c193dd39c7c1e7b20ca3f8c42f0a72860b15814';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseSuccessfulJson(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`${label} did not emit one JSON document: ${error.message}\n${result.stdout}`);
  }
}

function spawnNode(args, options, label) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
    ...options
  });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  return result;
}

function createFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-cross-interface-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repoRoot = path.join(base, 'repo');
  const consumer = path.join(base, 'consumer');
  const runnerTemp = path.join(base, 'runner-temp');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(consumer);
  fs.mkdirSync(runnerTemp, { mode: 0o700 });
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'Gatefile Contract Test']);
  git(repoRoot, ['config', 'user.email', 'gatefile-contract@example.invalid']);

  const {
    GatefileEngine,
    generateApprovalAttestationKeyPair
  } = require('../dist');
  const keyPair = generateApprovalAttestationKeyPair();
  const config = { signers: { trustedKeyIds: [keyPair.keyId] } };
  const engine = new GatefileEngine({
    repoRoot,
    stateHome: path.join(base, 'fixture-state'),
    config
  });
  const pending = engine.createPlan({
    source: 'cross-interface-contract',
    summary: 'All public adapters must report the same gate decision',
    operations: [
      {
        id: 'op_cross_interface',
        type: 'file',
        action: 'create',
        path: 'cross-interface-output.txt',
        after: 'previewed consistently; never applied\n'
      }
    ],
    preconditions: []
  });
  const plan = engine.approvePlan(pending, 'cross-interface-reviewer', {
    signingPrivateKeyPem: keyPair.privateKeyPem,
    signingKeyId: keyPair.keyId
  });

  const planRelativePath = path.join('.plan', 'plan.json');
  const planPath = path.join(repoRoot, planRelativePath);
  fs.mkdirSync(path.dirname(planPath));
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const configPath = path.join(repoRoot, 'gatefile.config.json');
  fs.writeFileSync(configPath, configBytes);
  git(repoRoot, ['add', planRelativePath, 'gatefile.config.json']);
  git(repoRoot, ['commit', '-q', '-m', 'add signed cross-interface fixture']);

  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'cross-interface-consumer', private: true, type: 'module' })}\n`,
    'utf8'
  );
  const packed = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', base],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 60_000
    }
  );
  assert.equal(packed.status, 0, `npm pack\n${packed.stdout}\n${packed.stderr}`);
  const [packMetadata] = JSON.parse(packed.stdout);
  const tarballPath = path.join(base, packMetadata.filename);
  const installed = spawnSync(
    'npm',
    ['install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: consumer,
      encoding: 'utf8',
      shell: false,
      timeout: 60_000
    }
  );
  assert.equal(installed.status, 0, `npm install\n${installed.stdout}\n${installed.stderr}`);
  assert.equal(
    fs.lstatSync(path.join(consumer, 'node_modules', 'gatefile')).isSymbolicLink(),
    false,
    'cross-interface consumers must use a packed installation, not a source-tree symlink'
  );
  const installedCliPath = fs.realpathSync(
    path.join(consumer, 'node_modules', '.bin', 'gatefile')
  );

  const actionCheckout = path.join(base, 'pinned-action');
  const cloned = spawnSync(
    'git',
    ['clone', '--quiet', '--no-checkout', '--no-hardlinks', projectRoot, actionCheckout],
    { encoding: 'utf8', shell: false, timeout: 60_000 }
  );
  assert.equal(cloned.status, 0, `clone pinned Action\n${cloned.stdout}\n${cloned.stderr}`);
  git(actionCheckout, ['checkout', '--quiet', '--detach', PINNED_GATEFILE_ACTION_SHA]);
  assert.equal(git(actionCheckout, ['rev-parse', 'HEAD']), PINNED_GATEFILE_ACTION_SHA);
  const actionPath = path.join(actionCheckout, '.github', 'actions', 'gatefile-pr-gate');

  return {
    base,
    repoRoot,
    consumer,
    runnerTemp,
    plan,
    planPath,
    planRelativePath,
    config,
    configPath,
    configBytes,
    keyPair,
    installedCliPath,
    actionPath,
    head: git(repoRoot, ['rev-parse', 'HEAD'])
  };
}

const rootConsumerProgram = String.raw`
const { readFileSync } = require('node:fs');
const { GatefileEngine } = require('gatefile');
const [repoRoot, planPath, configPath, stateHome] = process.argv.slice(1);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const engine = new GatefileEngine({ repoRoot, stateHome, config });
process.stdout.write(JSON.stringify({
  inspect: engine.inspectPlan(plan),
  verify: engine.verifyPlan(plan),
  dryRun: engine.previewPlan(plan, { planPath })
}));
`;

const esmRootConsumerProgram = String.raw`
import { readFileSync } from 'node:fs';
import { GatefileEngine } from 'gatefile';
const [repoRoot, planPath, configPath, stateHome] = process.argv.slice(1);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const engine = new GatefileEngine({ repoRoot, stateHome, config });
process.stdout.write(JSON.stringify({
  inspect: engine.inspectPlan(plan),
  verify: engine.verifyPlan(plan),
  dryRun: engine.previewPlan(plan, { planPath })
}));
`;

function collectRootEvidence(fixture, moduleKind) {
  const stateHome = path.join(fixture.base, `root-${moduleKind}-state`);
  const args = moduleKind === 'esm'
    ? ['--input-type=module', '-e', esmRootConsumerProgram]
    : ['--input-type=commonjs', '-e', rootConsumerProgram];
  args.push(fixture.repoRoot, fixture.planPath, fixture.configPath, stateHome);
  return parseSuccessfulJson(
    spawnNode(args, { cwd: fixture.consumer }, `${moduleKind.toUpperCase()} package root`),
    `${moduleKind.toUpperCase()} package root`
  );
}

function collectCliEvidence(fixture) {
  const env = {
    ...process.env,
    GATEFILE_STATE_HOME: path.join(fixture.base, 'cli-state')
  };
  const run = (args, label) => parseSuccessfulJson(
    spawnNode([fixture.installedCliPath, ...args], { cwd: fixture.repoRoot, env }, `CLI ${label}`),
    `CLI ${label}`
  );
  return {
    inspect: run(['inspect-plan', fixture.planRelativePath, '--json'], 'inspect'),
    verify: run(['verify-plan', fixture.planRelativePath], 'verify'),
    dryRun: run(['apply-plan', fixture.planRelativePath, '--dry-run'], 'dry-run')
  };
}

function mcpCall(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  };
}

function collectMcpEvidence(fixture) {
  const requests = [
    mcpCall(1, 'inspect_plan', { path: fixture.planRelativePath, json: true }),
    mcpCall(2, 'verify_plan', { path: fixture.planRelativePath }),
    mcpCall(3, 'dry_run_plan', { path: fixture.planRelativePath })
  ];
  const startup = {
    repoRoot: fixture.repoRoot,
    stateHome: path.join(fixture.base, 'mcp-state'),
    config: fixture.config
  };
  const program = [
    'const { startMcpServer } = require("gatefile");',
    'startMcpServer(JSON.parse(process.argv[1]));'
  ].join(' ');
  const result = spawnNode(
    ['-e', program, JSON.stringify(startup)],
    {
      cwd: fixture.consumer,
      input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
    },
    'MCP evidence'
  );
  assert.equal(result.status, 0, `MCP evidence\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.id), [1, 2, 3]);
  const reports = responses.map((response) => {
    assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  });
  return { inspect: reports[0], verify: reports[1], dryRun: reports[2] };
}

function collectActionEvidence(fixture) {
  const outputPath = path.join(fixture.base, 'github-output.txt');
  fs.writeFileSync(outputPath, '', 'utf8');
  const result = spawnSync('bash', [path.join(fixture.actionPath, 'run.sh')], {
    cwd: fixture.repoRoot,
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: fixture.actionPath,
      GITHUB_WORKSPACE: fixture.repoRoot,
      GITHUB_OUTPUT: outputPath,
      GITHUB_SHA: fixture.head,
      RUNNER_TEMP: fixture.runnerTemp,
      INPUT_PLAN_PATH: fixture.planRelativePath,
      INPUT_TRUSTED_POLICY_REF: fixture.head,
      INPUT_TRUSTED_POLICY_PATH: 'gatefile.config.json',
      INPUT_TRUSTED_POLICY_SHA256: sha256(fixture.configBytes),
      INPUT_ALLOW_UNSIGNED_NO_POLICY: 'false'
    },
    encoding: 'utf8',
    shell: false,
    timeout: 60_000
  });
  assert.equal(result.status, 0, `Action runner\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const outputs = Object.fromEntries(
    fs.readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  const readReport = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'));
  const evidence = {
    inspect: readReport(outputs['inspect-report-path']),
    verify: readReport(outputs['verify-report-path']),
    dryRun: readReport(outputs['dry-run-report-path'])
  };
  const manifest = readReport(outputs['manifest-path']);
  assert.equal(manifest.plan.id, evidence.verify.planId);
  assert.equal(manifest.plan.semanticHash, evidence.verify.hashes.currentPlanHash);
  assert.equal(manifest.decision.verificationStatus, evidence.verify.status);
  assert.equal(manifest.decision.staticGatePassed, evidence.dryRun.staticGate.passed);
  return evidence;
}

function normalizeEvidence(label, reports) {
  const { inspect, verify, dryRun } = reports;
  const inspectPlanId = inspect.id ?? inspect.planId;
  assert.equal(inspectPlanId, verify.planId, `${label}: inspect/verify plan ID`);
  assert.equal(dryRun.planId, verify.planId, `${label}: dry-run/verify plan ID`);
  assert.equal(
    inspect.verification.hashes.currentPlanHash,
    verify.hashes.currentPlanHash,
    `${label}: inspect/verify semantic hash`
  );
  assert.equal(inspect.verification.status, verify.status, `${label}: inspect/verify status`);
  assert.deepEqual(
    inspect.verification.signerTrust,
    verify.signerTrust,
    `${label}: inspect/verify signer trust`
  );
  assert.equal(dryRun.verification.status, verify.status, `${label}: dry-run/verify status`);
  assert.equal(
    dryRun.verification.signerTrustStatus,
    verify.signerTrust.status,
    `${label}: dry-run/verify signer trust status`
  );
  return {
    planId: verify.planId,
    semanticHash: verify.hashes.currentPlanHash,
    status: verify.status,
    signerTrust: verify.signerTrust,
    staticGatePassed: dryRun.staticGate.passed
  };
}

test('signed trusted plan has one gate decision across CJS, ESM, CLI, MCP, and Action', (t) => {
  const fixture = createFixture(t);
  const expected = {
    planId: fixture.plan.id,
    semanticHash: fixture.plan.integrity.planHash,
    status: 'ready',
    signerTrust: {
      policyConfigured: true,
      status: 'trusted',
      keyId: fixture.keyPair.keyId,
      matchedBy: 'keyId'
    },
    staticGatePassed: true
  };
  const interfaces = {
    cjs: collectRootEvidence(fixture, 'cjs'),
    esm: collectRootEvidence(fixture, 'esm'),
    cli: collectCliEvidence(fixture),
    mcp: collectMcpEvidence(fixture),
    action: collectActionEvidence(fixture)
  };

  for (const [name, reports] of Object.entries(interfaces)) {
    assert.deepEqual(normalizeEvidence(name, reports), expected, name);
  }
  assert.equal(fs.existsSync(path.join(fixture.repoRoot, 'cross-interface-output.txt')), false);
});
