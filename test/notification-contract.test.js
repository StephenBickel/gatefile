const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  GatefileEngine,
  fireOnApprovalNeeded,
  fireOnPlanApproved
} = require('../dist');

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');
const README_PATH = path.join(__dirname, '..', 'README.md');

function shellCommand(scriptPath) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function planSummary() {
  return {
    id: 'plan_notification_contract',
    summary: 'Notification compatibility contract',
    source: 'notification-contract-test',
    operations: [],
    risk: { score: 0, level: 'low', reasons: [] },
    approval: { status: 'approved', approvedBy: 'reviewer' }
  };
}

test('approve-plan CLI dispatches notifications from the same config snapshot as approval policy', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-notification-snapshot-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const marker = path.join(repoRoot, 'notification.txt');
  const originalScript = path.join(repoRoot, 'original.cjs');
  const replacementScript = path.join(repoRoot, 'replacement.cjs');
  const mutateScript = path.join(repoRoot, 'mutate-config.cjs');
  fs.writeFileSync(originalScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'original');\n`);
  fs.writeFileSync(replacementScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'replacement');\n`);

  const replacementConfig = {
    notifications: {
      onPlanApproved: { shell: shellCommand(replacementScript) }
    }
  };
  fs.writeFileSync(
    mutateScript,
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(repoRoot, 'gatefile.config.json'))}, ${JSON.stringify(`${JSON.stringify(replacementConfig, null, 2)}\n`)});\n`
  );
  const initialConfig = {
    hooks: { beforeApprove: { command: shellCommand(mutateScript) } },
    notifications: {
      onPlanApproved: { shell: shellCommand(originalScript) }
    }
  };
  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    `${JSON.stringify(initialConfig, null, 2)}\n`
  );

  const engine = new GatefileEngine({ repoRoot, config: initialConfig });
  const pending = engine.createPlan({
    source: 'notification-contract-test',
    summary: 'Pin notification config to approval config',
    operations: [{
      id: 'op_notification_snapshot',
      type: 'file',
      action: 'create',
      path: path.join(repoRoot, 'unused.txt'),
      after: 'not applied\n'
    }],
    preconditions: []
  });
  const planPath = path.join(repoRoot, 'plan.json');
  fs.writeFileSync(planPath, `${JSON.stringify(pending, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'approve-plan', planPath, '--by', 'snapshot-reviewer'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'original');
});

test('deprecated fireOnApprovalNeeded preserves its legacy webhook event name', async (t) => {
  const payloads = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      payloads.push(JSON.parse(body));
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const context = {
    repoRoot: fs.realpathSync(os.tmpdir()),
    config: {
      notifications: {
        onPlanApproved: { webhook: `http://127.0.0.1:${address.port}/event` }
      }
    }
  };

  await fireOnPlanApproved(planSummary(), context);
  await fireOnApprovalNeeded(planSummary(), context);

  assert.deepEqual(payloads.map((payload) => payload.event), [
    'plan_approved',
    'approval_needed'
  ]);
});

test('approve-plan CLI preserves the legacy webhook event for legacy config', async (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-legacy-event-cli-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const payloads = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      payloads.push(JSON.parse(body));
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  fs.writeFileSync(
    path.join(repoRoot, 'gatefile.config.json'),
    `${JSON.stringify({
      hooks: {
        onApprovalNeeded: {
          webhook: `http://127.0.0.1:${address.port}/legacy-event`
        }
      }
    }, null, 2)}\n`
  );
  const engine = new GatefileEngine({ repoRoot });
  const plan = engine.createPlan({
    source: 'notification-contract-test',
    summary: 'Preserve the legacy CLI webhook event',
    operations: [{
      id: 'op_legacy_event',
      type: 'file',
      action: 'create',
      path: path.join(repoRoot, 'unused.txt'),
      after: 'not applied\n'
    }],
    preconditions: []
  });
  const planPath = path.join(repoRoot, 'plan.json');
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const result = await runCli(
    ['approve-plan', planPath, '--by', 'legacy-reviewer'],
    repoRoot
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].event, 'approval_needed');
});

test('README matches packaged MCP capabilities and canonical notification config', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const defaultTools = readme
    .split('### Default packaged tools')[1]
    .split('### Privileged programmatic embedding')[0];
  assert.match(defaultTools, /`inspect_plan`/);
  assert.match(defaultTools, /`create_plan`/);
  assert.match(defaultTools, /`verify_plan`/);
  assert.match(defaultTools, /`dry_run_plan`/);
  assert.doesNotMatch(defaultTools, /`approve_plan`|`apply_plan`|`rollback_apply`/);
  assert.match(readme, /capabilities: \{ approve: true, apply: true, rollback: true \}/);

  const notifications = readme.split('## Notifications')[1].split('## Core Concepts')[0];
  assert.match(notifications, /"notifications": \{/);
  assert.match(notifications, /"onPlanCreated": \{/);
  assert.match(notifications, /"onPlanApproved": \{/);
  assert.doesNotMatch(notifications, /"hooks": \{|"onApprovalNeeded": \{/);
});
