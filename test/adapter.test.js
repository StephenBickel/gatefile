const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { adaptAgentInputToDraft, createPlanFromDraft, verifyPlan } = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

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

test('adaptAgentInputToDraft converts concise proposal input into a plan draft', () => {
  const draft = adaptAgentInputToDraft({
    source: 'my-agent',
    summary: 'Update docs and run tests',
    fileChanges: [
      {
        action: 'update',
        path: 'README.md',
        before: 'old\n',
        after: 'new\n'
      }
    ],
    commands: [
      {
        command: 'npm test'
      }
    ],
    preconditions: [{ kind: 'git_clean' }]
  });

  assert.equal(draft.source, 'my-agent');
  assert.equal(draft.summary, 'Update docs and run tests');
  assert.equal(draft.operations.length, 2);
  assert.deepEqual(
    draft.operations.map((op) => op.id),
    ['op_file_1', 'op_command_1']
  );
  assert.deepEqual(draft.preconditions, [{ kind: 'git_clean' }]);
});

test('adaptAgentInputToDraft supports generic envelope input with agent source fallback', () => {
  const draft = adaptAgentInputToDraft({
    agent: { name: 'builder' },
    proposal: {
      summary: 'Create helper file',
      fileChanges: [
        {
          action: 'create',
          path: 'tmp/helper.txt',
          after: 'ok\n'
        }
      ]
    }
  });

  assert.equal(draft.source, 'agent:builder');
  assert.equal(draft.operations.length, 1);
  assert.equal(draft.operations[0].type, 'file');
});

test('adapt-agent CLI produces a draft that create-plan and verify-plan accept', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-adapter-cli-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const inputPath = path.join(root, 'agent-input.json');
  const draftPath = path.join(root, 'draft.json');
  const planPath = path.join(root, 'plan.json');

  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        agent: { name: 'workflow-bot' },
        proposal: {
          summary: 'Adapter CLI workflow test',
          fileChanges: [
            {
              action: 'create',
              path: path.join(root, 'created.txt'),
              after: 'hello\n'
            }
          ],
          commands: [{ command: `${process.execPath} -v` }]
        }
      },
      null,
      2
    ),
    'utf8'
  );

  const adaptOut = runCli(t, ['adapt-agent', '--from', inputPath, '--out', draftPath]);
  if (!adaptOut) return;

  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  assert.equal(draft.summary, 'Adapter CLI workflow test');
  assert.equal(draft.operations.length, 2);

  runCli(t, ['create-plan', '--from', draftPath, '--out', planPath]);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const verify = verifyPlan(plan);
  assert.equal(verify.status, 'not-ready');
  assert.equal(verify.approvalStatus, 'pending');
});

test('adaptAgentInputToDraft rejects adapter input with no operations', () => {
  assert.throws(
    () =>
      adaptAgentInputToDraft({
        summary: 'Missing operation test'
      }),
    /at least one file change or command/
  );
});

test('adapted draft can be passed directly to createPlanFromDraft', () => {
  const draft = adaptAgentInputToDraft({
    summary: 'Direct handoff into createPlanFromDraft',
    fileChanges: [
      {
        action: 'create',
        path: 'tmp/test.txt',
        after: 'value\n'
      }
    ]
  });

  const plan = createPlanFromDraft(draft);
  assert.equal(plan.summary, draft.summary);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.approval.status, 'pending');
});
