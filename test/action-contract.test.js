const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const actionRelativePath = path.join('.github', 'actions', 'gatefile-pr-gate');
const PINNED_GATEFILE_ACTION_SHA = '9c193dd39c7c1e7b20ca3f8c42f0a72860b15814';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function copyActionCheckout(root) {
  const checkout = path.join(root, 'trusted-action-checkout');
  fs.mkdirSync(checkout);
  for (const entry of ['package.json', 'package-lock.json', 'src', 'tsconfig.json', 'schema']) {
    fs.cpSync(path.join(projectRoot, entry), path.join(checkout, entry), { recursive: true });
  }
  const actionPath = path.join(checkout, actionRelativePath);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.cpSync(path.join(projectRoot, actionRelativePath), actionPath, { recursive: true });
  return { checkout, actionPath };
}

function makeConsumerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-action-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const consumer = path.join(root, 'consumer');
  const runnerTemp = path.join(root, 'runner-temp');
  fs.mkdirSync(consumer);
  fs.mkdirSync(runnerTemp, { mode: 0o700 });
  git(consumer, ['init', '-q']);
  git(consumer, ['config', 'user.name', 'Gatefile Action Test']);
  git(consumer, ['config', 'user.email', 'gatefile-action@example.invalid']);

  const { GatefileEngine, generateApprovalAttestationKeyPair } = require('../dist');
  const keyPair = generateApprovalAttestationKeyPair();
  const config = { signers: { trustedKeyIds: [keyPair.keyId] } };
  const engine = new GatefileEngine({ repoRoot: consumer, config });
  const pending = engine.createPlan({
    source: 'action-contract-test',
    summary: 'Prove the reusable Action uses trusted code and policy',
    operations: [
      {
        id: 'op_action_evidence',
        type: 'file',
        action: 'create',
        path: 'action-output.txt',
        after: 'action preview only\n'
      }
    ],
    preconditions: []
  });
  const plan = engine.approvePlan(pending, 'trusted-action-reviewer', {
    signingPrivateKeyPem: keyPair.privateKeyPem,
    signingKeyId: keyPair.keyId
  });

  fs.mkdirSync(path.join(consumer, '.plan'));
  fs.writeFileSync(path.join(consumer, '.plan', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const configBytes = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(path.join(consumer, 'gatefile.config.json'), configBytes);

  const maliciousMarker = path.join(root, 'consumer-verifier-ran');
  fs.mkdirSync(path.join(consumer, 'dist'));
  fs.writeFileSync(
    path.join(consumer, 'dist', 'cli.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(maliciousMarker)}, 'ran'); console.log('{"status":"ready"}');\n`,
    'utf8'
  );

  git(consumer, ['add', '.plan/plan.json', 'gatefile.config.json']);
  git(consumer, ['commit', '-q', '-m', 'add reviewed plan and trusted policy']);
  const head = git(consumer, ['rev-parse', 'HEAD']);
  const policyDigest = sha256(configBytes);
  const action = copyActionCheckout(root);

  return {
    root,
    consumer,
    runnerTemp,
    action,
    maliciousMarker,
    plan,
    configBytes,
    head,
    policyDigest
  };
}

function actionEnvironment(fixture, overrides = {}) {
  const output = path.join(fixture.root, `github-output-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(output, '');
  return {
    ...process.env,
    GITHUB_ACTION_PATH: fixture.action.actionPath,
    GITHUB_WORKSPACE: fixture.consumer,
    GITHUB_OUTPUT: output,
    GITHUB_SHA: fixture.head,
    RUNNER_TEMP: fixture.runnerTemp,
    INPUT_PLAN_PATH: '.plan/plan.json',
    INPUT_TRUSTED_POLICY_REF: fixture.head,
    INPUT_TRUSTED_POLICY_PATH: 'gatefile.config.json',
    INPUT_TRUSTED_POLICY_SHA256: fixture.policyDigest,
    INPUT_ALLOW_UNSIGNED_NO_POLICY: 'false',
    ...overrides
  };
}

function runAction(fixture, overrides = {}) {
  const env = actionEnvironment(fixture, overrides);
  const result = spawnSync('bash', [path.join(fixture.action.actionPath, 'run.sh')], {
    cwd: fixture.consumer,
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000
  });
  result.githubOutput = env.GITHUB_OUTPUT;
  return result;
}

function readActionOutputs(result) {
  const entries = fs.readFileSync(result.githubOutput, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      assert.notEqual(separator, -1, `invalid GitHub output line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
  return Object.fromEntries(entries);
}

test('Action metadata owns its verifier and preserves evidence before enforcement', () => {
  const actionPath = path.join(projectRoot, actionRelativePath);
  const metadata = fs.readFileSync(path.join(actionPath, 'action.yml'), 'utf8');
  const runScript = fs.readFileSync(path.join(actionPath, 'run.sh'), 'utf8');

  assert.match(metadata, /^name: Gatefile PR Gate$/m);
  assert.doesNotMatch(metadata, /install-command|build-command/);
  assert.doesNotMatch(metadata, /node dist\/cli\.js/);
  assert.match(metadata, /GITHUB_ACTION_PATH/);
  for (const output of [
    'evidence-directory',
    'inspect-report-path',
    'verify-report-path',
    'dry-run-report-path',
    'manifest-path'
  ]) {
    assert.match(metadata, new RegExp(`^  ${output}:`, 'm'));
  }
  assert.match(metadata, /if: \$\{\{ always\(\) \}\}/);
  assert.match(metadata, /if-no-files-found: error/);
  assert.match(metadata, /path: \$\{\{ steps\.gate\.outputs\.evidence-directory \}\}/);
  assert.doesNotMatch(metadata, /path:\s*\|[\s\S]*inputs\.plan-path/);
  assert.ok(
    metadata.indexOf('Upload Gatefile evidence') < metadata.indexOf('Enforce Gatefile readiness'),
    'evidence upload must precede the failing readiness step'
  );
  assert.doesNotMatch(runScript, /GITHUB_WORKSPACE[^\n]*dist\/cli|node[ \t]+dist\/cli\.js/);

  const syntax = spawnSync('bash', ['-n', path.join(actionPath, 'run.sh')], {
    encoding: 'utf8'
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('Action runner uses action-owned code, trusted policy, and bound evidence', (t) => {
  const fixture = makeConsumerFixture(t);

  // A PR may weaken its workspace config, but the gate must use the pinned base snapshot.
  fs.writeFileSync(path.join(fixture.consumer, 'gatefile.config.json'), '{}\n', 'utf8');
  const result = runAction(fixture);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Gatefile evidence generated/, result.stderr);
  assert.equal(fs.existsSync(fixture.maliciousMarker), false, 'consumer dist/cli.js was executed');

  const outputs = readActionOutputs(result);
  assert.ok(outputs['evidence-directory'].startsWith(`${fs.realpathSync(fixture.runnerTemp)}${path.sep}`));
  assert.deepEqual(fs.readdirSync(outputs['evidence-directory']).sort(), [
    'dry-run-report.json',
    'gatefile-manifest.json',
    'inspect-report.json',
    'plan.json',
    'verify-report.json'
  ]);
  const inspect = JSON.parse(fs.readFileSync(outputs['inspect-report-path'], 'utf8'));
  const verify = JSON.parse(fs.readFileSync(outputs['verify-report-path'], 'utf8'));
  const dryRun = JSON.parse(fs.readFileSync(outputs['dry-run-report-path'], 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(outputs['manifest-path'], 'utf8'));
  assert.equal(inspect.id ?? inspect.planId, fixture.plan.id);
  assert.equal(verify.planId, fixture.plan.id);
  assert.equal(verify.status, 'ready');
  assert.equal(verify.signerTrust.status, 'trusted');
  assert.equal(dryRun.planId, fixture.plan.id);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.gatefileVersion, require('../package.json').version);
  assert.equal(manifest.plan.id, fixture.plan.id);
  assert.equal(manifest.plan.semanticHash, verify.hashes.currentPlanHash);
  assert.equal(
    manifest.plan.rawSha256,
    sha256(fs.readFileSync(path.join(outputs['evidence-directory'], 'plan.json')))
  );
  assert.equal(manifest.git.head, fixture.head);
  assert.deepEqual(manifest.policy, {
    mode: 'trusted-snapshot',
    ref: fixture.head,
    path: 'gatefile.config.json',
    sha256: fixture.policyDigest
  });

  const enforced = spawnSync(
    process.execPath,
    [path.join(fixture.action.actionPath, 'enforce.js'), outputs['evidence-directory']],
    { cwd: fixture.consumer, encoding: 'utf8', shell: false }
  );
  assert.equal(enforced.status, 0, enforced.stderr);
  fs.appendFileSync(outputs['verify-report-path'], ' ');
  const tamperedEvidence = spawnSync(
    process.execPath,
    [path.join(fixture.action.actionPath, 'enforce.js'), outputs['evidence-directory']],
    { cwd: fixture.consumer, encoding: 'utf8', shell: false }
  );
  assert.equal(tamperedEvidence.status, 1);
  assert.match(tamperedEvidence.stderr, /digest.*manifest/i);

  const gitConfigPath = path.join(fixture.consumer, '.git', 'config');
  const gitConfigBefore = fs.readFileSync(gitConfigPath);
  fs.symlinkSync(gitConfigPath, path.join(fixture.consumer, 'inspect-report.json'));
  const stagedDespiteWorkspaceSymlink = runAction(fixture);
  assert.equal(
    stagedDespiteWorkspaceSymlink.status,
    0,
    `${stagedDespiteWorkspaceSymlink.stdout}\n${stagedDespiteWorkspaceSymlink.stderr}`
  );
  const stagedOutputs = readActionOutputs(stagedDespiteWorkspaceSymlink);
  assert.notEqual(stagedOutputs['inspect-report-path'], path.join(fixture.consumer, 'inspect-report.json'));
  assert.equal(fs.lstatSync(stagedOutputs['inspect-report-path']).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(gitConfigPath), gitConfigBefore);

  fs.writeFileSync(path.join(fixture.consumer, '.plan', 'plan.json'), '{}\n');
  const mutated = runAction(fixture);
  assert.notEqual(mutated.status, 0);
  assert.match(mutated.stderr, /unchanged|differs from HEAD/i);

  execFileSync('git', ['-C', fixture.consumer, 'restore', '.plan/plan.json']);
  fs.writeFileSync(path.join(fixture.consumer, 'untracked-plan.json'), JSON.stringify(fixture.plan));
  const untracked = runAction(fixture, { INPUT_PLAN_PATH: 'untracked-plan.json' });
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /Git-tracked/i);

  const wrongDigest = runAction(fixture, { INPUT_TRUSTED_POLICY_SHA256: '0'.repeat(64) });
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /digest mismatch/i);

  const missingPolicy = runAction(fixture, {
    INPUT_TRUSTED_POLICY_REF: '',
    INPUT_TRUSTED_POLICY_SHA256: ''
  });
  assert.notEqual(missingPolicy.status, 0);
  assert.match(missingPolicy.stderr, /trusted policy.*required/i);
});

test('Action emits failed verification evidence before its final enforcement step', (t) => {
  const fixture = makeConsumerFixture(t);
  const { GatefileEngine } = require('../dist');
  const trustedConfig = JSON.parse(fixture.configBytes);
  const engine = new GatefileEngine({ repoRoot: fixture.consumer, config: trustedConfig });
  const pending = engine.createPlan({
    source: 'action-contract-test',
    summary: 'Pending plan must preserve not-ready evidence',
    operations: [
      {
        id: 'op_pending_action',
        type: 'file',
        action: 'create',
        path: 'pending.txt',
        after: 'pending\n'
      }
    ],
    preconditions: []
  });
  fs.writeFileSync(
    path.join(fixture.consumer, '.plan', 'plan.json'),
    `${JSON.stringify(pending, null, 2)}\n`
  );
  execFileSync('git', ['-C', fixture.consumer, 'restore', 'gatefile.config.json']);
  git(fixture.consumer, ['add', '.plan/plan.json']);
  git(fixture.consumer, ['commit', '-q', '-m', 'replace plan with pending evidence fixture']);
  fixture.head = git(fixture.consumer, ['rev-parse', 'HEAD']);

  const generated = runAction(fixture, {
    INPUT_TRUSTED_POLICY_REF: fixture.head
  });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const outputs = readActionOutputs(generated);
  const verifyPath = outputs['verify-report-path'];
  const dryRunPath = outputs['dry-run-report-path'];
  const manifestPath = outputs['manifest-path'];
  assert.equal(JSON.parse(fs.readFileSync(verifyPath, 'utf8')).status, 'not-ready');
  assert.equal(JSON.parse(fs.readFileSync(dryRunPath, 'utf8')).planId, pending.id);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).plan.id, pending.id);

  const enforcement = spawnSync(
    process.execPath,
    [path.join(fixture.action.actionPath, 'enforce.js'), outputs['evidence-directory']],
    { cwd: fixture.consumer, encoding: 'utf8', shell: false }
  );
  assert.equal(enforcement.status, 1);
  assert.match(enforcement.stderr, /not ready/i);
});

test('published Action examples pin a release and bind policy to the PR base', () => {
  const files = [
    'README.md',
    'docs/github-pr-gate-example.md',
    'docs/examples/github-pr-gate.yml',
    'docs/examples/github-pr-gate.inlined.yml'
  ];
  for (const relativePath of files) {
    const contents = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(contents, /gatefile-pr-gate@main/);
    assert.doesNotMatch(contents, /\bPlanfile\b/);
  }
  const reusable = fs.readFileSync(
    path.join(projectRoot, 'docs/examples/github-pr-gate.yml'),
    'utf8'
  );
  assert.match(
    reusable,
    new RegExp(`gatefile-pr-gate@${PINNED_GATEFILE_ACTION_SHA}`)
  );
  assert.doesNotMatch(reusable, /gatefile-pr-gate@v/);
  assert.match(reusable, /fetch-depth: 0/);
  assert.match(reusable, /trusted-policy-ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(reusable, /trusted-policy-sha256: \$\{\{ vars\.GATEFILE_POLICY_SHA256 \}\}/);
});
