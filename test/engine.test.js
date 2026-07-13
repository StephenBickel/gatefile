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

test('GatefileEngine keeps a selected non-Git root pinned after repository topology changes', (t) => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-engine-pinned-root-'))
  );
  const stateHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-engine-pinned-state-'))
  );
  const repoRoot = path.join(base, 'selected');
  fs.mkdirSync(repoRoot);
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  });
  const hookScript = "require('node:fs').writeFileSync('hook-marker', 'ran')";
  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    JSON.stringify({
      hooks: {
        beforeApply: {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(hookScript)}`
        }
      }
    }),
    'utf8'
  );
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:pinned-selected-root',
    stateHome
  });
  const approved = engine.approvePlan(
    engine.createPlan({
      source: 'pinned-root-test',
      summary: 'Stay inside the originally selected directory',
      operations: [{
        id: 'op_pinned_root',
        type: 'file',
        action: 'create',
        path: 'target.txt',
        after: 'selected root only\n'
      }],
      preconditions: []
    }),
    'reviewer'
  );

  execFileSync('git', ['init', '-q', base]);
  const report = engine.applyPlan(approved);

  assert.equal(report.success, true);
  assert.equal(report.rollbackContext.repoRoot, repoRoot);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'target.txt'), 'utf8'), 'selected root only\n');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'hook-marker'), 'utf8'), 'ran');
  assert.equal(fs.existsSync(path.join(base, 'target.txt')), false);
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

test('GatefileEngine policy resolution cannot be shadowed through JavaScript properties', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-private-resolver-');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:private-resolver-test',
    stateHome,
    config: { signers: { trustedKeyIds: ['trusted-key'] } }
  });
  const unsignedPlan = engine.approvePlan(
    engine.createPlan(makeDraft('Preserve private policy resolution')),
    'reviewer'
  );
  const originalPrototypeDescriptor = Object.getOwnPropertyDescriptor(
    GatefileEngine.prototype,
    'policyConfig'
  );
  t.after(() => {
    if (originalPrototypeDescriptor === undefined) {
      delete GatefileEngine.prototype.policyConfig;
    } else {
      Object.defineProperty(
        GatefileEngine.prototype,
        'policyConfig',
        originalPrototypeDescriptor
      );
    }
  });

  engine.policyConfig = () => ({});
  GatefileEngine.prototype.policyConfig = () => ({});

  const report = engine.verifyPlan(unsignedPlan);
  assert.equal(report.signerTrust.policyConfigured, true);
  assert.equal(report.status, 'not-ready');
});

test('GatefileEngine validates approval input before running policy hooks', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-approval-order-');
  const markerPath = path.join(repoRoot, 'malformed-hook-ran');
  const hookScript = "require('node:fs').writeFileSync('malformed-hook-ran', 'yes')";
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:approval-order-test',
    stateHome,
    config: {
      hooks: {
        beforeApprove: {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(hookScript)}`
        }
      }
    }
  });
  const malformedPlan = engine.createPlan(makeDraft('Reject before hook'));
  malformedPlan.version = '1';

  assert.throws(
    () => engine.approvePlan(malformedPlan, 'reviewer'),
    /unsupported plan version; expected v2/i
  );
  assert.equal(fs.existsSync(markerPath), false);

  const riskTamperedPlan = engine.createPlan(makeDraft('Reject risk drift before hook'));
  riskTamperedPlan.risk = {
    score: 999,
    level: 'high',
    reasons: ['tampered']
  };
  assert.throws(
    () => engine.approvePlan(riskTamperedPlan, 'reviewer'),
    /stored risk does not match risk recomputed/i
  );
  assert.equal(fs.existsSync(markerPath), false);
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

test('beforeApprove hooks use the pinned repository despite ambient Git routing', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(
    t,
    'gatefile-engine-before-approve-git-env-'
  );
  commitOnBranch(repoRoot, 'engine-branch');
  commitOnBranch(otherRepoRoot, 'other-branch');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:before-approve-git-env',
    stateHome,
    config: {
      hooks: {
        beforeApprove: {
          command: 'test "$(git rev-parse --abbrev-ref HEAD)" = engine-branch'
        }
      }
    }
  });
  const plan = engine.createPlan(makeDraft('Pin approval hook repository'));

  const approved = runWithProcessContext(
    otherRepoRoot,
    {
      GIT_DIR: path.join(otherRepoRoot, '.git'),
      GIT_WORK_TREE: otherRepoRoot
    },
    () => engine.approvePlan(plan, 'reviewer')
  );

  assert.equal(approved.approval.status, 'approved');
});

test('beforeApply hooks use the pinned repository despite ambient Git routing', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(
    t,
    'gatefile-engine-before-apply-git-env-'
  );
  commitOnBranch(repoRoot, 'engine-branch');
  commitOnBranch(otherRepoRoot, 'other-branch');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:before-apply-git-env',
    stateHome,
    config: {
      hooks: {
        beforeApply: {
          command: 'test "$(git rev-parse --abbrev-ref HEAD)" = engine-branch'
        }
      }
    }
  });
  const approved = engine.approvePlan(
    engine.createPlan(makeDraft('Pin apply hook repository')),
    'reviewer'
  );

  const report = runWithProcessContext(
    otherRepoRoot,
    {
      GIT_DIR: path.join(otherRepoRoot, '.git'),
      GIT_WORK_TREE: otherRepoRoot
    },
    () => engine.applyPlan(approved)
  );

  assert.equal(report.success, true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'engine-output.txt')), true);
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

test('planning and verification remain available when Windows execution is fail-closed', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-windows-planning-');
  const packageRoot = path.join(__dirname, '..', 'dist');
  const script = `
    const assert = require('node:assert/strict');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { GatefileEngine, createPlanFromDraft } = require(${JSON.stringify(packageRoot)});
    const repoRoot = ${JSON.stringify(repoRoot)};
    const stateHome = ${JSON.stringify(stateHome)};
    const draft = {
      source: 'windows-planning-test',
      summary: 'Keep non-mutating lifecycle available',
      operations: [{
        id: 'op_windows_planning',
        type: 'file',
        action: 'create',
        path: 'windows-preview.txt',
        after: 'preview only\\n'
      }],
      preconditions: []
    };
    const rootPlan = createPlanFromDraft(draft, {
      repoRoot,
      context: { repositoryId: 'repo:windows-root-wrapper' }
    });
    assert.equal(rootPlan.context.repositoryId, 'repo:windows-root-wrapper');
    const engine = new GatefileEngine({
      repoRoot,
      repositoryId: 'repo:windows-engine',
      stateHome
    });
    const approved = engine.approvePlan(engine.createPlan(draft), 'reviewer');
    assert.equal(engine.verifyPlan(approved).status, 'ready');
  `;

  assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' }));
});

test('GatefileEngine rollback remains available when repository config becomes invalid', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-rollback-config-');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:rollback-config-test',
    stateHome
  });
  const approvedPlan = engine.approvePlan(
    engine.createPlan(makeDraft('Recover despite broken config')),
    'reviewer'
  );
  const applied = engine.applyPlan(approvedPlan);
  assert.equal(applied.success, true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'engine-output.txt')), true);

  fs.writeFileSync(path.join(repoRoot, 'gatefile.config.json'), '{', 'utf8');

  const rolledBack = engine.rollbackApply(applied.receipt.id);
  assert.equal(rolledBack.success, true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'engine-output.txt')), false);
});
