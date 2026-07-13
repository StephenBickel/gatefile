const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  GatefileEngine,
  generateApprovalAttestationKeyPair
} = require('../dist');
const {
  readConfinedUtf8,
  writeConfinedUtf8Atomic
} = require('../dist/confined-io');

const MCP_MODULE_PATH = path.join(__dirname, '..', 'dist', 'mcp.js');

function fixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  const ambient = path.join(base, 'ambient');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(outside);
  fs.mkdirSync(ambient);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot, outside, ambient, stateHome };
}

function spawnServer({ cwd, startup, requests, env = process.env }) {
  const script = [
    'const { startMcpServer } = require(process.argv[1]);',
    'startMcpServer(JSON.parse(process.argv[2]));'
  ].join(' ');
  return spawnSync(
    process.execPath,
    ['-e', script, MCP_MODULE_PATH, JSON.stringify(startup)],
    {
      cwd,
      env,
      encoding: 'utf8',
      input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
    }
  );
}

function runServer(options) {
  const result = spawnServer(options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function call(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  };
}

function draft(pathname = 'target.txt') {
  return {
    source: 'mcp-authority-test',
    summary: 'Exercise pinned MCP authority',
    operations: [
      {
        id: 'op_mcp_authority',
        type: 'file',
        action: 'create',
        path: pathname,
        after: 'created through pinned MCP authority\n'
      }
    ],
    preconditions: []
  };
}

function writePlan(repoRoot, relativePath, plan) {
  fs.writeFileSync(
    path.join(repoRoot, relativePath),
    `${JSON.stringify(plan, null, 2)}\n`,
    'utf8'
  );
}

test('one startup-pinned engine owns plan creation even from an unrelated process cwd', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-pinned-');
  fs.mkdirSync(path.join(f.repoRoot, 'plans'));
  const repositoryId = 'repo:mcp-startup-pinned';
  const [response] = runServer({
    cwd: f.ambient,
    startup: {
      repoRoot: f.repoRoot,
      repositoryId,
      stateHome: f.stateHome
    },
    requests: [call(1, 'create_plan', { draft: draft(), out: 'plans/created.json' })]
  });

  assert.equal(response.result.isError, false, response.result.content[0].text);
  const createdPath = path.join(f.repoRoot, 'plans', 'created.json');
  assert.equal(fs.existsSync(createdPath), true);
  assert.equal(fs.existsSync(path.join(f.ambient, 'plans', 'created.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(createdPath, 'utf8')).context.repositoryId, repositoryId);
});

test('plan creation is create-only and cannot clobber an existing repository file', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-no-clobber-');
  const existingPath = path.join(f.repoRoot, 'README.md');
  const original = '# Existing repository content\n';
  fs.writeFileSync(existingPath, original, 'utf8');

  const [response] = runServer({
    cwd: f.ambient,
    startup: { repoRoot: f.repoRoot, stateHome: f.stateHome },
    requests: [call(1, 'create_plan', { draft: draft(), out: 'README.md' })]
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /already exists|create-only/i);
  assert.equal(fs.readFileSync(existingPath, 'utf8'), original);
});

test('absolute, traversal, and symlink output paths cannot escape the pinned repository', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-output-');
  const absoluteVictim = path.join(f.outside, 'absolute.json');
  const traversalVictim = path.join(f.outside, 'traversal.json');
  const symlinkVictim = path.join(f.outside, 'symlink.json');
  fs.symlinkSync(f.outside, path.join(f.repoRoot, 'escape'));
  const responses = runServer({
    cwd: f.ambient,
    startup: { repoRoot: f.repoRoot, stateHome: f.stateHome },
    requests: [
      call(1, 'create_plan', { draft: draft(), out: absoluteVictim }),
      call(2, 'create_plan', { draft: draft(), out: '../outside/traversal.json' }),
      call(3, 'create_plan', { draft: draft(), out: 'escape/symlink.json' })
    ]
  });

  for (const response of responses) {
    assert.equal(response.result?.isError ?? true, true);
  }
  assert.equal(fs.existsSync(absoluteVictim), false);
  assert.equal(fs.existsSync(traversalVictim), false);
  assert.equal(fs.existsSync(symlinkVictim), false);
});

test('plan reads reject final and ancestor symlinks', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-read-');
  const engine = new GatefileEngine({ repoRoot: f.repoRoot, stateHome: f.stateHome });
  const plan = engine.createPlan(draft());
  const outsidePlan = path.join(f.outside, 'outside-plan.json');
  fs.writeFileSync(outsidePlan, `${JSON.stringify(plan)}\n`, 'utf8');
  fs.symlinkSync(outsidePlan, path.join(f.repoRoot, 'linked-plan.json'));
  fs.symlinkSync(f.outside, path.join(f.repoRoot, 'linked-dir'));
  const responses = runServer({
    cwd: f.ambient,
    startup: { repoRoot: f.repoRoot, stateHome: f.stateHome },
    requests: [
      call(1, 'inspect_plan', { path: 'linked-plan.json', json: true }),
      call(2, 'inspect_plan', { path: 'linked-dir/outside-plan.json', json: true })
    ]
  });

  for (const response of responses) {
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /symbolic link|symlink|no-follow/i);
  }
});

test('atomic confined replacement rejects a file changed since its no-follow read', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-revision-');
  const planPath = path.join(f.repoRoot, 'plan.json');
  const displacedPath = path.join(f.repoRoot, 'displaced.json');
  fs.writeFileSync(planPath, 'original\n', 'utf8');
  const read = readConfinedUtf8(f.repoRoot, 'plan.json');
  fs.renameSync(planPath, displacedPath);
  fs.writeFileSync(planPath, 'replacement\n', 'utf8');

  assert.throws(
    () => writeConfinedUtf8Atomic(
      f.repoRoot,
      'plan.json',
      'approved stale bytes\n',
      { expectedRevision: read.revision }
    ),
    /changed since it was read/i
  );
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'replacement\n');
});

test('confined plan reads reject oversized files before loading their contents', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-read-size-');
  const oversizedPath = path.join(f.repoRoot, 'oversized.json');
  fs.writeFileSync(oversizedPath, '');
  fs.truncateSync(oversizedPath, (16 * 1024 * 1024) + 1);

  assert.throws(
    () => readConfinedUtf8(f.repoRoot, 'oversized.json'),
    /exceeds.*16777216-byte/i
  );
});

test('approval identity and signing material come only from explicit startup configuration', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-approval-');
  const engine = new GatefileEngine({ repoRoot: f.repoRoot, stateHome: f.stateHome });
  const keys = generateApprovalAttestationKeyPair();
  writePlan(f.repoRoot, 'pending.json', engine.createPlan(draft()));

  const [defaultResponse] = runServer({
    cwd: f.ambient,
    startup: { repoRoot: f.repoRoot, stateHome: f.stateHome },
    requests: [call(1, 'approve_plan', { path: 'pending.json', by: 'model' })]
  });
  assert.equal(defaultResponse.error.code, -32601);

  const [requestAuthorityResponse, approvedResponse] = runServer({
    cwd: f.ambient,
    startup: {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { approve: true },
      approval: {
        approvedBy: 'trusted-startup-reviewer',
        signingPrivateKeyPem: keys.privateKeyPem,
        signingKeyId: keys.keyId
      }
    },
    requests: [
      call(2, 'approve_plan', {
        path: 'pending.json',
        by: 'model',
        signing_key: '/tmp/model-key.pem',
        key_id: 'model-key'
      }),
      call(3, 'approve_plan', { path: 'pending.json' })
    ]
  });

  assert.equal(requestAuthorityResponse.error.code, -32602);
  assert.equal(approvedResponse.result.isError, false, approvedResponse.result.content[0].text);
  const approved = JSON.parse(fs.readFileSync(path.join(f.repoRoot, 'pending.json'), 'utf8'));
  assert.equal(approved.approval.approvedBy, 'trusted-startup-reviewer');
  assert.equal(approved.approval.attestation.keyId, keys.keyId);
});

test('apply and rollback are disabled by default and use only pinned startup state when enabled', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-apply-');
  const engine = new GatefileEngine({ repoRoot: f.repoRoot, stateHome: f.stateHome });
  const plan = engine.approvePlan(engine.createPlan(draft()), 'fixture-reviewer');
  writePlan(f.repoRoot, 'approved.json', plan);

  const [disabled] = runServer({
    cwd: f.ambient,
    startup: { repoRoot: f.repoRoot, stateHome: f.stateHome },
    requests: [call(1, 'apply_plan', { path: 'approved.json' })]
  });
  assert.equal(disabled.error.code, -32601);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'target.txt')), false);

  const startup = {
    repoRoot: f.repoRoot,
    stateHome: f.stateHome,
    capabilities: { apply: true, rollback: true }
  };
  const [appliedResponse] = runServer({
    cwd: f.ambient,
    startup,
    requests: [call(2, 'apply_plan', { path: 'approved.json' })]
  });
  assert.equal(appliedResponse.result.isError, false, appliedResponse.result.content[0].text);
  const applied = JSON.parse(appliedResponse.result.content[0].text);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'target.txt')), true);
  assert.equal(applied.rollbackContext.repoRoot, fs.realpathSync(f.repoRoot));
  assert.equal(applied.rollbackContext.stateHome, fs.realpathSync(f.stateHome));

  const [rollbackResponse] = runServer({
    cwd: f.ambient,
    startup,
    requests: [call(3, 'rollback_apply', { receipt_id: applied.receipt.id })]
  });
  assert.equal(rollbackResponse.result.isError, false, rollbackResponse.result.content[0].text);
  assert.equal(JSON.parse(rollbackResponse.result.content[0].text).success, true);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'target.txt')), false);
});

test('request-selected repository and state fields are rejected even for enabled tools', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-override-');
  const [response] = runServer({
    cwd: f.ambient,
    startup: {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { apply: true }
    },
    requests: [call(1, 'apply_plan', {
      path: 'missing.json',
      repo_root: f.outside,
      repository_id: 'repo:model-selected',
      state_home: f.outside
    })]
  });

  assert.equal(response.error.code, -32602);
  assert.equal(fs.readdirSync(f.outside).length, 0);
});

test('command apply captures bounded child output without corrupting protocol stdout', (t) => {
  const f = fixture(t, 'gatefile-mcp-authority-command-');
  const engine = new GatefileEngine({ repoRoot: f.repoRoot, stateHome: f.stateHome });
  const plan = engine.approvePlan(
    engine.createPlan({
      source: 'mcp-command-output-test',
      summary: 'Child output must not reach protocol stdout',
      operations: [
        {
          id: 'op_command_output',
          type: 'command',
          executable: process.execPath,
          args: [
            '-e',
            "process.stdout.write('MCP_CHILD_STDOUT' + 'A'.repeat(10000)); process.stderr.write('MCP_CHILD_STDERR' + 'B'.repeat(10000))"
          ]
        }
      ],
      preconditions: []
    }),
    'fixture-reviewer'
  );
  writePlan(f.repoRoot, 'command.json', plan);
  const result = spawnServer({
    cwd: f.ambient,
    startup: {
      repoRoot: f.repoRoot,
      stateHome: f.stateHome,
      capabilities: { apply: true }
    },
    requests: [call(1, 'apply_plan', { path: 'command.json' })]
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes('MCP_CHILD_STDERR'), false, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, result.stdout);
  const response = JSON.parse(lines[0]);
  assert.equal(response.result.isError, false, response.result.content[0].text);
  const report = JSON.parse(response.result.content[0].text);
  assert.equal(report.success, true);
  assert.match(report.results[0].message, /stdout="MCP_CHILD_STDOUT/);
  assert.match(report.results[0].message, /stderr="MCP_CHILD_STDERR/);
  assert.match(report.results[0].message, /truncated at 8192 bytes/);
  assert.ok(result.stdout.length < 20_000, `captured response was ${result.stdout.length} bytes`);
});
