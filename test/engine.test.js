const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { GatefileEngine } = require('../dist');

function makeFixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const otherRepoRoot = path.join(base, 'other-repo');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(otherRepoRoot);
  execFileSync('git', ['init', '-q', repoRoot]);
  execFileSync('git', ['init', '-q', otherRepoRoot]);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { repoRoot, otherRepoRoot, stateHome };
}

function commitOnBranch(repoRoot, branch) {
  execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-b', branch]);
  execFileSync('git', [
    '-C',
    repoRoot,
    '-c',
    'user.name=Gatefile Tests',
    '-c',
    'user.email=gatefile-tests@example.invalid',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'initial commit'
  ]);
}

function runWithProcessContext(cwd, environment, action) {
  const originalCwd = process.cwd();
  const originalEnvironment = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  process.chdir(cwd);
  try {
    for (const [key, value] of Object.entries(environment)) {
      process.env[key] = value;
    }
    return action();
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.chdir(originalCwd);
  }
}

function makeDraft(summary = 'Exercise the policy-aware engine') {
  return {
    source: 'engine-test',
    summary,
    operations: [
      {
        id: 'op_engine_file',
        type: 'file',
        action: 'create',
        path: 'engine-output.txt',
        after: 'created by the engine test\n'
      }
    ],
    preconditions: []
  };
}

test('GatefileEngine pins repository context and enforces its signer policy', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(t, 'gatefile-engine-context-');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:engine-test',
    stateHome,
    config: { signers: { trustedKeyIds: ['trusted-key'] } }
  });
  const otherEngine = new GatefileEngine({
    repoRoot: otherRepoRoot,
    repositoryId: 'repo:other-engine-test',
    stateHome
  });
  const draft = makeDraft();
  const plan = engine.createPlan(draft);
  const planFromOtherRepo = otherEngine.createPlan(draft);

  assert.equal(engine.context.repoRoot, fs.realpathSync(repoRoot));
  assert.equal(engine.context.repositoryId, 'repo:engine-test');
  assert.equal(engine.context.stateHome, stateHome);
  assert.equal(plan.context.repositoryId, 'repo:engine-test');
  assert.throws(
    () => engine.approvePlan(planFromOtherRepo, 'reviewer'),
    /repository context.*engine/i
  );

  const unsignedPlan = engine.approvePlan(plan, 'reviewer');
  assert.equal(engine.verifyPlan(unsignedPlan).signerTrust.policyConfigured, true);
  assert.throws(
    () => engine.applyPlan(unsignedPlan),
    /signer|unsigned|verification/i
  );
});

test('GatefileEngine context binding cannot be replaced to redirect authority', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(t, 'gatefile-engine-context-binding-');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:engine-test',
    stateHome
  });
  const originalContext = engine.context;

  try {
    engine.context = {
      repoRoot: fs.realpathSync(otherRepoRoot),
      repositoryId: 'repo:redirected-engine',
      stateHome: path.join(path.dirname(stateHome), 'redirected-state')
    };
  } catch {
    // Strict-mode assignment to a non-writable binding may throw.
  }

  assert.equal(engine.context, originalContext);
  assert.equal(engine.createPlan(makeDraft('Preserve authority')).context.repositoryId, 'repo:engine-test');
});

test('GatefileEngine keeps explicit policy in runtime-private pinned state', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-private-policy-');
  const suppliedConfig = { signers: { trustedKeyIds: ['trusted-key'] } };
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:private-policy-test',
    stateHome,
    config: suppliedConfig
  });
  const unsignedPlan = engine.approvePlan(
    engine.createPlan(makeDraft('Preserve explicit policy')),
    'reviewer'
  );

  assert.equal(Object.getOwnPropertyDescriptor(engine, 'explicitConfig'), undefined);
  assert.equal(engine.verifyPlan(unsignedPlan).status, 'not-ready');

  suppliedConfig.signers.trustedKeyIds.length = 0;
  engine.explicitConfig = {};

  const report = engine.verifyPlan(unsignedPlan);
  assert.equal(report.signerTrust.policyConfigured, true);
  assert.equal(report.status, 'not-ready');
});

test('GatefileEngine pins branch preconditions despite ambient cwd and Git routing', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(
    t,
    'gatefile-engine-branch-precondition-'
  );
  commitOnBranch(repoRoot, 'engine-branch');
  commitOnBranch(otherRepoRoot, 'other-branch');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:engine-branch-test',
    stateHome
  });
  const plan = engine.approvePlan(
    engine.createPlan({
      ...makeDraft('Check the pinned branch'),
      preconditions: [{ kind: 'branch_is', value: 'engine-branch' }]
    }),
    'reviewer'
  );

  const report = runWithProcessContext(
    otherRepoRoot,
    {
      GIT_DIR: path.join(otherRepoRoot, '.git'),
      GIT_WORK_TREE: otherRepoRoot
    },
    () => engine.applyPlan(plan)
  );

  assert.equal(report.success, true);
  assert.equal(
    fs.readFileSync(path.join(repoRoot, 'engine-output.txt'), 'utf8'),
    'created by the engine test\n'
  );
  assert.equal(fs.existsSync(path.join(otherRepoRoot, 'engine-output.txt')), false);
});

test('GatefileEngine pins clean-tree preconditions despite ambient cwd and Git routing', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(
    t,
    'gatefile-engine-clean-precondition-'
  );
  commitOnBranch(repoRoot, 'engine-branch');
  commitOnBranch(otherRepoRoot, 'other-branch');
  fs.writeFileSync(path.join(otherRepoRoot, 'dirty.txt'), 'ambient repository is dirty\n', 'utf8');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:engine-clean-test',
    stateHome
  });
  const plan = engine.approvePlan(
    engine.createPlan({
      ...makeDraft('Check the pinned working tree'),
      preconditions: [{ kind: 'git_clean' }]
    }),
    'reviewer'
  );

  const report = runWithProcessContext(
    otherRepoRoot,
    {
      GIT_DIR: path.join(otherRepoRoot, '.git'),
      GIT_WORK_TREE: otherRepoRoot
    },
    () => engine.applyPlan(plan)
  );

  assert.equal(report.success, true);
  assert.equal(
    fs.readFileSync(path.join(repoRoot, 'engine-output.txt'), 'utf8'),
    'created by the engine test\n'
  );
  assert.equal(fs.existsSync(path.join(otherRepoRoot, 'engine-output.txt')), false);
});

test('GatefileEngine reloads the default repository config for each operation', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-config-reload-');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:config-reload-test',
    stateHome
  });
  const unsignedPlan = engine.approvePlan(engine.createPlan(makeDraft('Reload policy')), 'reviewer');

  const beforePolicy = engine.verifyPlan(unsignedPlan);
  assert.equal(beforePolicy.signerTrust.policyConfigured, false);
  assert.equal(beforePolicy.status, 'ready');

  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    JSON.stringify({ signers: { trustedKeyIds: ['trusted-key'] } }, null, 2),
    'utf8'
  );

  const afterPolicy = engine.verifyPlan(unsignedPlan);
  assert.equal(afterPolicy.signerTrust.policyConfigured, true);
  assert.equal(afterPolicy.status, 'not-ready');
});
