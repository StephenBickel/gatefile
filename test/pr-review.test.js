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
  assert.match(markdown, /\| Apply ready \| no \|/);
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
        trustedKeyIds: ['trusted-signer-1']
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
        trustedKeyIds: ['required-pr-review-signer']
      }
    }
  });
  const plan = engine.approvePlan(engine.createPlan(makeDraft()), 'ci-user');
  const expected = engine.verifyPlan(plan);
  const markdown = renderPRReviewComment({ plan, engine });

  assert.equal(expected.signerTrust.status, 'unsigned');
  assert.match(markdown, new RegExp(`\\| Signer trust \\| ${expected.signerTrust.status} \\|`));
  assert.match(
    markdown,
    new RegExp(
      `\\| Apply ready \\| ${expected.readyToApplyFromIntegrityApproval ? 'yes' : 'no'} \\|`
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
  const markdown = renderPRReviewComment({
    plan,
    repoRoot,
    repositoryId,
    stateHome
  });

  assert.equal(expected.readyToApplyFromIntegrityApproval, true);
  assert.match(markdown, /\| Apply ready \| yes \|/);
});

test('renderPRReviewComment asks the supplied engine only for missing assessments', () => {
  const realEngine = new GatefileEngine({ repoRoot: process.cwd() });
  const plan = realEngine.approvePlan(realEngine.createPlan(makeDraft()), 'ci-user');
  const inspectReport = realEngine.inspectPlan(plan);
  const verifyReport = realEngine.verifyPlan(plan);
  let inspectCalls = 0;
  let verifyCalls = 0;
  const engine = {
    inspectPlan(value) {
      inspectCalls += 1;
      return realEngine.inspectPlan(value);
    },
    verifyPlan(value) {
      verifyCalls += 1;
      return realEngine.verifyPlan(value);
    }
  };

  renderPRReviewComment({ plan, inspectReport, engine });
  assert.equal(inspectCalls, 0);
  assert.equal(verifyCalls, 1);

  renderPRReviewComment({ plan, verifyReport, engine });
  assert.equal(inspectCalls, 1);
  assert.equal(verifyCalls, 1);

  renderPRReviewComment({ plan, inspectReport, verifyReport, engine });
  assert.equal(inspectCalls, 1);
  assert.equal(verifyCalls, 1);
});

test('renderPRReviewComment includes dry-run highlights when provided', () => {
  const pending = createPlanFromDraft(makeDraft());
  const plan = approvePlan(pending, 'ci-user');
  const dryRun = previewPlan(plan);
  const markdown = renderPRReviewComment({ plan, dryRunReport: dryRun });

  assert.match(markdown, /### Dry-Run Highlights/);
  assert.match(markdown, /Previewed operations: 2/);
  assert.match(markdown, /op_cmd_1:/);
  assert.match(markdown, /\| Apply ready \| yes \|/);
});

test('render-pr-comment CLI writes markdown file with optional reports', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-pr-comment-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pending = createPlanFromDraft(makeDraft());
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
