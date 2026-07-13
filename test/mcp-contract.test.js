const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MCP_MODULE_PATH = path.join(__dirname, '..', 'dist', 'mcp.js');

function fixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repoRoot };
}

function runServer({ cwd, startup = {}, lines, env = process.env }) {
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
      input: `${lines.join('\n')}\n`
    }
  );
}

function responseLines(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function request(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

test('malformed and invalid JSON-RPC lines return standard errors and later requests survive', (t) => {
  const f = fixture(t, 'gatefile-mcp-contract-invalid-');
  const result = runServer({
    cwd: f.repoRoot,
    startup: { repoRoot: f.repoRoot },
    lines: [
      '{',
      'null',
      JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2.5, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: null }),
      request(4, 'unknown/method'),
      request(5, 'ping')
    ]
  });

  assert.deepEqual(responseLines(result), [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid params' } },
    { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } },
    { jsonrpc: '2.0', id: 5, result: {} }
  ]);
});

test('notifications never respond or execute tools', (t) => {
  const f = fixture(t, 'gatefile-mcp-contract-notification-');
  const outPath = path.join(f.repoRoot, 'notification-plan.json');
  const draft = {
    source: 'notification-test',
    summary: 'Must not execute',
    operations: [],
    preconditions: []
  };
  const result = runServer({
    cwd: f.repoRoot,
    startup: { repoRoot: f.repoRoot },
    lines: [
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'create_plan', arguments: { draft, out: 'notification-plan.json' } }
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'ping' }),
      request(1, 'ping')
    ]
  });

  assert.deepEqual(responseLines(result), [{ jsonrpc: '2.0', id: 1, result: {} }]);
  assert.equal(fs.existsSync(outPath), false);
});

test('default tool schemas omit privileged tools and all request-selected authority', (t) => {
  const f = fixture(t, 'gatefile-mcp-contract-tools-');
  const result = runServer({
    cwd: f.repoRoot,
    startup: { repoRoot: f.repoRoot },
    lines: [request(1, 'tools/list')]
  });
  const [response] = responseLines(result);
  const tools = response.result.tools;

  assert.deepEqual(tools.map((tool) => tool.name), [
    'inspect_plan',
    'create_plan',
    'verify_plan',
    'dry_run_plan'
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    for (const forbidden of [
      'repo_root',
      'repository_id',
      'state_home',
      'by',
      'signing_key',
      'key_id'
    ]) {
      assert.equal(tool.inputSchema.properties[forbidden], undefined, `${tool.name}.${forbidden}`);
    }
  }
});

test('disabled and unknown tools map to method-not-found while malformed tool arguments fail before I/O', (t) => {
  const f = fixture(t, 'gatefile-mcp-contract-args-');
  const draft = {
    source: 'strict-args-test',
    summary: 'Reject unknown authority',
    operations: [],
    preconditions: []
  };
  const result = runServer({
    cwd: f.repoRoot,
    startup: { repoRoot: f.repoRoot },
    lines: [
      request(1, 'tools/call', {
        name: 'approve_plan',
        arguments: { path: 'plan.json', by: 'model' }
      }),
      request(2, 'tools/call', { name: 'not_a_tool', arguments: {} }),
      request(3, 'tools/call', {
        name: 'create_plan',
        arguments: { draft, out: 'bad.json', repo_root: f.base }
      }),
      request(4, 'tools/call', {
        name: 'create_plan',
        arguments: { draft: [], out: 'bad-array.json' }
      }),
      request(5, 'tools/call', {
        name: 'inspect_plan',
        arguments: { path: 'missing.json', json: 'yes' }
      })
    ]
  });
  const responses = responseLines(result);

  assert.deepEqual(responses.map((response) => response.error?.code), [
    -32601,
    -32601,
    -32602,
    -32602,
    -32602
  ]);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'bad.json')), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'bad-array.json')), false);
});

test('oversized lines are rejected from a bounded buffer and later requests survive', (t) => {
  const f = fixture(t, 'gatefile-mcp-contract-size-');
  const oversized = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    padding: 'x'.repeat(512)
  });
  const result = runServer({
    cwd: f.repoRoot,
    startup: { repoRoot: f.repoRoot, maxMessageBytes: 128 },
    lines: [oversized, request(2, 'ping')]
  });

  assert.deepEqual(responseLines(result), [
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Request line exceeds 128 bytes' }
    },
    { jsonrpc: '2.0', id: 2, result: {} }
  ]);
});
