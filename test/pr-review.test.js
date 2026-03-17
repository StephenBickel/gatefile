const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
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
        command: "node -e \"console.log('ok')\"",
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
