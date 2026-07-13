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
