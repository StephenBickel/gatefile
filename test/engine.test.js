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
  const approvedBranchGuard = engine.approvePlan(
    engine.createPlan({
      source: 'pinned-root-test',
      summary: 'Do not inherit a later parent branch',
      operations: [{
        id: 'op_pinned_branch_guard',
        type: 'file',
        action: 'create',
        path: 'branch-guard.txt',
        after: 'must not apply\n'
      }],
      preconditions: [{ kind: 'branch_is', value: 'policy-branch' }]
    }),
    'reviewer'
  );
  const approvedCleanGuard = engine.approvePlan(
    engine.createPlan({
      source: 'pinned-root-test',
      summary: 'Do not inherit a later parent clean tree',
      operations: [{
        id: 'op_pinned_clean_guard',
        type: 'file',
        action: 'create',
        path: 'clean-guard.txt',
        after: 'must not apply\n'
      }],
      preconditions: [{ kind: 'git_clean' }]
    }),
    'reviewer'
  );

  execFileSync('git', ['init', '-q', '-b', 'policy-branch', base]);
  fs.writeFileSync(path.join(base, '.gitignore'), 'selected/\n', 'utf8');
  execFileSync('git', [
    '-C',
    base,
    '-c',
    'user.name=Gatefile Tests',
    '-c',
    'user.email=gatefile-tests@example.invalid',
    'add',
    '.gitignore'
  ]);
  execFileSync('git', [
    '-C',
    base,
    '-c',
    'user.name=Gatefile Tests',
    '-c',
    'user.email=gatefile-tests@example.invalid',
    'commit',
    '-q',
    '-m',
    'initialize parent repository'
  ]);

  for (const guardedPlan of [approvedBranchGuard, approvedCleanGuard]) {
    assert.throws(
      () => engine.applyPlan(guardedPlan),
      /Preconditions failed:.*not a Git repository/i
    );
  }
  assert.equal(fs.existsSync(path.join(repoRoot, 'branch-guard.txt')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'clean-guard.txt')), false);

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

  const validPlan = engine.createPlan(makeDraft('Reject invalid reviewer before hook'));
  assert.throws(
    () => engine.approvePlan(validPlan, ''),
    /approvedBy.*non-empty/i
  );
  assert.equal(fs.existsSync(markerPath), false);

  assert.throws(
    () => engine.approvePlan(validPlan, 'reviewer', {
      signingPrivateKeyPem: 'not a private key'
    }),
    /valid Ed25519 private key/i
  );
  assert.equal(fs.existsSync(markerPath), false);

  assert.throws(
    () => engine.approvePlan(validPlan, 'reviewer', {
      signingKeyId: 'key-without-private-material'
    }),
    /signingKeyId requires signingPrivateKeyPem/i
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

test('Git preconditions use the executable pinned at engine construction', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX executable substitution fixture');
    return;
  }
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-git-path-');
  commitOnBranch(repoRoot, 'denied');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:git-path-test',
    stateHome
  });
  const approved = engine.approvePlan(
    engine.createPlan({
      ...makeDraft('Reject substituted Git executable'),
      preconditions: [{ kind: 'branch_is', value: 'approved' }]
    }),
    'reviewer'
  );
  const fakeBin = path.join(path.dirname(repoRoot), 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nprintf "approved\\n"\n', {
    encoding: 'utf8',
    mode: 0o755
  });

  assert.throws(
    () => runWithProcessContext(
      repoRoot,
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
      () => engine.applyPlan(approved)
    ),
    /Branch mismatch.*Expected approved, got denied/i
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'engine-output.txt')), false);
});

test('Git cleanliness ignores later HOME and XDG global-config changes', (t) => {
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-git-home-');
  commitOnBranch(repoRoot, 'engine-branch');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:git-home-test',
    stateHome
  });
  const approved = engine.approvePlan(
    engine.createPlan({
      ...makeDraft('Reject global ignore injection'),
      preconditions: [{ kind: 'git_clean' }]
    }),
    'reviewer'
  );
  fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'must remain visible\n', 'utf8');
  const fakeHome = path.join(path.dirname(repoRoot), 'fake-home');
  const xdgHome = path.join(fakeHome, 'xdg');
  const excludesFile = path.join(fakeHome, 'ignore-all');
  fs.mkdirSync(xdgHome, { recursive: true });
  fs.writeFileSync(excludesFile, '*\n', 'utf8');
  fs.writeFileSync(
    path.join(fakeHome, '.gitconfig'),
    `[core]\n\texcludesFile = ${excludesFile}\n`,
    'utf8'
  );

  assert.throws(
    () => runWithProcessContext(
      repoRoot,
      { HOME: fakeHome, XDG_CONFIG_HOME: xdgHome },
      () => engine.applyPlan(approved)
    ),
    /Git working tree is not clean/i
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'engine-output.txt')), false);
});

test('policy hooks use the Git executable pinned at engine construction', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX executable substitution fixture');
    return;
  }
  const { repoRoot, stateHome } = makeFixture(t, 'gatefile-engine-hook-path-');
  commitOnBranch(repoRoot, 'denied');
  const engine = new GatefileEngine({
    repoRoot,
    repositoryId: 'repo:hook-path-test',
    stateHome,
    config: {
      hooks: {
        beforeApprove: {
          command: 'test "$(git rev-parse --abbrev-ref HEAD)" = approved'
        }
      }
    }
  });
  const plan = engine.createPlan(makeDraft('Reject hook Git substitution'));
  const fakeBin = path.join(path.dirname(repoRoot), 'hook-fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nprintf "approved\\n"\n', {
    encoding: 'utf8',
    mode: 0o755
  });

  assert.throws(
    () => runWithProcessContext(
      repoRoot,
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
      () => engine.approvePlan(plan, 'reviewer')
    ),
    /Policy hook beforeApprove blocked execution/i
  );
});

test('repository identity ignores ambient global remote configuration', (t) => {
  const { repoRoot, otherRepoRoot, stateHome } = makeFixture(
    t,
    'gatefile-engine-global-remote-'
  );
  const fakeHome = path.join(path.dirname(repoRoot), 'remote-home');
  const xdgHome = path.join(fakeHome, 'xdg');
  fs.mkdirSync(xdgHome, { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.gitconfig'),
    '[remote "origin"]\n\turl = https://attacker.invalid/shared.git\n',
    'utf8'
  );

  const [engine, otherEngine] = runWithProcessContext(
    repoRoot,
    { HOME: fakeHome, XDG_CONFIG_HOME: xdgHome },
    () => [
      new GatefileEngine({ repoRoot, stateHome }),
      new GatefileEngine({ repoRoot: otherRepoRoot, stateHome })
    ]
  );

  assert.notEqual(engine.context.repositoryId, otherEngine.context.repositoryId);
  assert.match(engine.context.repositoryId, /^file:/);
  assert.match(otherEngine.context.repositoryId, /^file:/);
  assert.throws(
    () => otherEngine.approvePlan(engine.createPlan(makeDraft('Bind local identity')), 'reviewer'),
    /repository context.*does not match engine/i
  );
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
