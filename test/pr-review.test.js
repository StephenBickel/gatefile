const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  GatefileEngine,
  createPlanFromDraft,
  approvePlan,
  previewPlan,
  renderPRReviewComment
} = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function makeDraft() {
  return {
    source: 'test-agent',
    summary: 'Render GitHub PR comment',
    operations: [
      {
        id: 'op_file_1',
        type: 'file',
        action: 'create',
        path: 'tmp/review-comment.txt',
        after: 'hello review'
      },
      {
        id: 'op_cmd_1',
        type: 'command',
        executable: 'node',
        args: ['-e', "console.log('ok')"],
        allowFailure: true
      }
    ],
    preconditions: [{ kind: 'git_clean' }]
  };
}

function runCli(t, args) {
  try {
    return execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('subprocess execution is blocked in this environment');
      return null;
    }
    throw error;
  }
}

test('renderPRReviewComment includes required plan review signals', () => {
  const plan = createPlanFromDraft(makeDraft());
  const markdown = renderPRReviewComment({ plan });

  assert.match(markdown, /## gatefile PR Review/);
  assert.match(markdown, /\| Summary \|/);
  assert.match(markdown, /\| Risk \| low \(score: 2\) \|/);
  assert.match(markdown, /\| Approval \| pending \(unsigned\) \|/);
  assert.match(markdown, /\| Signer trust \| not-configured \|/);
  assert.match(markdown, /\| Integrity \| match \|/);
  assert.match(markdown, /\| Static apply gate \| failed \|/);
  assert.match(markdown, /\| Ready to attempt apply \| no \|/);
  assert.match(markdown, /### Blockers/);
  assert.match(markdown, /Plan is not approved/);
});

test('renderPRReviewComment shows signer trust details when policy is configured', () => {
  const pending = createPlanFromDraft(makeDraft());
  const plan = approvePlan(pending, 'ci-user');
  const markdown = renderPRReviewComment({
    plan,
    config: {
      signers: {
        trustedKeyIds: ['gfk1_1111111111111111']
      }
    }
  });

  assert.match(markdown, /\| Signer trust \| unsigned \|/);
  assert.match(markdown, /Signer trust policy is configured/);
});

test('renderPRReviewComment readiness matches a supplied engine signer policy', () => {
  const engine = new GatefileEngine({
    repoRoot: process.cwd(),
    config: {
      signers: {
        trustedKeyIds: ['gfk1_2222222222222222']
      }
    }
  });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const expected = engine.verifyPlan(plan);
  const expectedPreview = engine.previewPlan(plan);
  const markdown = renderPRReviewComment({ plan, engine });

  assert.equal(expected.signerTrust.status, 'unsigned');
  assert.match(markdown, new RegExp(`\\| Signer trust \\| ${expected.signerTrust.status} \\|`));
  assert.match(
    markdown,
    new RegExp(
      `\\| Ready to attempt apply \\| ${expectedPreview.staticGate.passed ? 'yes' : 'no'} \\|`
    )
  );
});

test('renderPRReviewComment constructs one engine from supplied runtime context', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pr-context-')));
  const repoRoot = path.join(base, 'repo');
  const stateHome = path.join(base, 'state');
  const repositoryId = 'repo:pr-review-context';
  fs.mkdirSync(repoRoot);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const engine = new GatefileEngine({ repoRoot, repositoryId, stateHome });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const expected = engine.verifyPlan(plan);
  const expectedPreview = engine.previewPlan(plan);
  const markdown = renderPRReviewComment({
    plan,
    repoRoot,
    repositoryId,
    stateHome
  });

  assert.equal(expected.readyToApplyFromIntegrityApproval, true);
  assert.match(
    markdown,
    new RegExp(`\\| Ready to attempt apply \\| ${expectedPreview.staticGate.passed ? 'yes' : 'no'} \\|`)
  );
});

test('renderPRReviewComment recomputes one trusted assessment before accepting reports', () => {
  const realEngine = new GatefileEngine({ repoRoot: process.cwd() });
  const plan = realEngine.approvePlan(realEngine.createPlan(makeDraft()), 'ci-user');
  const inspectReport = realEngine.inspectPlan(plan);
  const verifyReport = realEngine.verifyPlan(plan);
  let inspectCalls = 0;
  let previewCalls = 0;
  const engine = {
    inspectPlan(value) {
      inspectCalls += 1;
      return realEngine.inspectPlan(value);
    },
    previewPlan(value) {
      previewCalls += 1;
      return realEngine.previewPlan(value);
    }
  };

  renderPRReviewComment({ plan, inspectReport, engine });
  assert.equal(inspectCalls, 1);
  assert.equal(previewCalls, 1);

  renderPRReviewComment({ plan, verifyReport, engine });
  assert.equal(inspectCalls, 2);
  assert.equal(previewCalls, 2);

  renderPRReviewComment({ plan, inspectReport, verifyReport, engine });
  assert.equal(inspectCalls, 3);
  assert.equal(previewCalls, 3);
});

test('renderPRReviewComment rejects a verify report inconsistent with the inspect snapshot', () => {
  const engine = new GatefileEngine({ repoRoot: process.cwd() });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const inspectReport = engine.inspectPlan(plan);
  const verifyReport = {
    ...inspectReport.verification,
    status: 'not-ready'
  };

  assert.throws(
    () => renderPRReviewComment({ plan, inspectReport, verifyReport }),
    /verify report.*inspect.*snapshot|inconsistent supplied reports/i
  );
});

test('renderPRReviewComment includes dry-run highlights when provided', () => {
  const pending = createPlanFromDraft(makeDraft());
  const plan = approvePlan(pending, 'ci-user');
  const dryRun = previewPlan(plan);
  const markdown = renderPRReviewComment({ plan, dryRunReport: dryRun });

  assert.match(markdown, /### Dry-Run Highlights/);
  assert.match(markdown, /Previewed operations: 2/);
  assert.match(markdown, /op&#95;cmd&#95;1:/);
  assert.match(
    markdown,
    new RegExp(`\\| Ready to attempt apply \\| ${dryRun.staticGate.passed ? 'yes' : 'no'} \\|`)
  );
});

test('renderPRReviewComment surfaces static-gate facts and denied operations', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pr-denied-'));
  try {
    const plan = approvePlan(createPlanFromDraft({
      source: 'test-agent',
      summary: 'PR comment must expose policy denial',
      operations: [{
        id: 'op_denied_pr',
        type: 'file',
        action: 'create',
        path: path.join(outsideRoot, 'outside.txt'),
        after: 'denied\n'
      }],
      preconditions: []
    }), 'ci-user');
    const dryRunReport = previewPlan(plan);
    const markdown = renderPRReviewComment({ plan, dryRunReport });

    assert.match(markdown, /Static gate: failed/);
    assert.match(markdown, /Operation policy: denied/);
    assert.match(markdown, /Preconditions checked: no/);
    assert.match(markdown, /\| Ready to attempt apply \| no \|/);
    assert.match(markdown, /Dry-run static gate failed/);
    assert.match(markdown, /Denied operations:/);
    assert.match(markdown, /op&#95;denied&#95;pr/);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('renderPRReviewComment rejects dry-run evidence for a different plan', () => {
  const plan = createPlanFromDraft(makeDraft());
  const dryRunReport = previewPlan(plan);

  assert.throws(
    () => renderPRReviewComment({
      plan,
      dryRunReport: { ...dryRunReport, planId: 'plan_different' }
    }),
    /dry-run report.*plan/i
  );
});

test('renderPRReviewComment rejects stale reports after plan operation tampering', () => {
  const engine = new GatefileEngine({ repoRoot: process.cwd() });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const inspectReport = engine.inspectPlan(plan);
  const dryRunReport = engine.previewPlan(plan);
  const tampered = {
    ...plan,
    operations: plan.operations.map((operation, index) => index === 0
      ? { ...operation, path: 'tmp/tampered-review.txt', after: 'tampered' }
      : operation)
  };

  assert.throws(
    () => renderPRReviewComment({
      plan: tampered,
      inspectReport,
      dryRunReport,
      engine
    }),
    /inspect report disagrees|inconsistent supplied reports/i
  );
});

test('renderPRReviewComment escapes untrusted plan text before emitting Markdown', () => {
  const draft = makeDraft();
  draft.summary = [
    'claimed | Ready to attempt apply | yes |',
    '### Forged heading <details>',
    '![verified](https://attacker.example/fake-green.svg)',
    '@octocat [review here](https://attacker.example/phish) **APPROVED** _trusted_'
  ].join('\n');
  draft.operations[0].id = 'op_denied\n### Forged operation';
  draft.operations[0].path = '/outside/markdown-injection.txt';
  const engine = new GatefileEngine({ repoRoot: process.cwd() });
  const plan = engine.approvePlan(engine.createPlan(draft), 'ci-user');

  const markdown = renderPRReviewComment({ plan, engine });

  assert.doesNotMatch(markdown, /\n### Forged/);
  assert.doesNotMatch(markdown, /<details>/);
  assert.doesNotMatch(markdown, /!\[verified\]\(/);
  assert.doesNotMatch(markdown, /@octocat/);
  assert.doesNotMatch(markdown, /\[review here\]\(/);
  assert.doesNotMatch(markdown, /\*\*APPROVED\*\*/);
  assert.doesNotMatch(markdown, /_trusted_/);
  assert.doesNotMatch(markdown, /\| Summary \| claimed \| Ready to attempt apply \| yes \|/);
  assert.match(markdown, /claimed \\\| Ready to attempt apply \\\| yes \\\|/);
  assert.match(markdown, /&lt;details&gt;/);
});

test('render-pr-comment CLI writes markdown file with optional reports', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pr-comment-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const draft = makeDraft();
  // Keep the trusted preview independent from files created by parallel suites.
  draft.operations[0].path = path.join(dir, 'review-comment.txt');
  const pending = createPlanFromDraft(draft);
  const plan = approvePlan(pending, 'ci-user');
  const dryRun = previewPlan(plan);
  const planPath = path.join(dir, 'plan.json');
  const dryRunPath = path.join(dir, 'dry-run.json');
  const outPath = path.join(dir, 'comment.md');

  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
  fs.writeFileSync(dryRunPath, JSON.stringify(dryRun, null, 2), 'utf8');

  const output = runCli(t, ['render-pr-comment', planPath, '--dry-run', dryRunPath, '--out', outPath]);
  if (!output) return;

  assert.match(output, /PR comment markdown written:/);
  const markdown = fs.readFileSync(outPath, 'utf8');
  assert.match(markdown, /## gatefile PR Review/);
  assert.match(markdown, /### Dry-Run Highlights/);
});
