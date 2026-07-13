const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludesAll(value, expected, label) {
  for (const item of expected) {
    assert.ok(value.includes(item), `${label} must include: ${item}`);
  }
}

test('package metadata and lockfile identify the 0.3 alpha as experimental', () => {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(manifest.version, '0.3.0-alpha.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assertIncludesAll(manifest.description.toLowerCase(), ['experimental', 'alpha', 'not production-ready'], 'package description');
});

test('README gives an unambiguous alpha warning before usage guidance', () => {
  const readme = read('README.md');
  const status = '**Status: Experimental alpha — not production-ready.**';

  assert.ok(readme.includes(status), 'README must contain the exact alpha status warning');
  assert.ok(readme.indexOf(status) < readme.indexOf('## Quick Start'), 'alpha warning must appear before Quick Start');
});

test('README presents production use cases as future controlled-evaluation scenarios', () => {
  const readme = read('README.md');

  assertIncludesAll(
    readme,
    [
      'Engineering teams evaluating future autonomous-agent production workflows.',
      'controlled-evaluation scenario, not a production deployment recommendation',
      '### 2. Future scenario: Production Ops Automation',
      'Controlled evaluation only while Gatefile is alpha'
    ],
    'README production scenarios'
  );
  assert.ok(!readme.includes('**Engineering teams shipping autonomous agents to production.**'));
  assert.ok(!readme.includes('### 2. Production Ops Automation'));
});

test('roadmap freezes feature expansion during stabilization', () => {
  const roadmap = read('docs/product-roadmap.md');

  assertIncludesAll(
    roadmap,
    [
      '## Alpha stabilization freeze',
      'Security fixes',
      'Correctness fixes',
      'Compatibility work',
      'Tests',
      'Documentation',
      'Release stabilization',
      'New product surface and feature work are deferred'
    ],
    'stabilization freeze'
  );
});

test('root roadmap does not advertise deferred features as near-term work', () => {
  const readme = read('README.md');
  const todo = read('TODO.md');

  assert.ok(!readme.includes('See [TODO.md](TODO.md) for near-term plans.'));
  assert.ok(!readme.includes('pick from TODO.md'));
  assert.ok(readme.includes('deferred feature roadmap'));
  assertIncludesAll(
    todo,
    [
      '**Status: Experimental alpha — not production-ready.**',
      'Feature expansion is frozen',
      '## 0.3 Alpha Release Boundary',
      '## Deferred Post-Alpha Work'
    ],
    'root roadmap'
  );
});

test('freeze language uses the exact release stabilization category', () => {
  for (const relativePath of ['README.md', 'TODO.md', 'docs/product-roadmap.md']) {
    const contents = read(relativePath);

    assert.match(contents, /release\s+stabilization/i, `${relativePath} must name release stabilization`);
    assert.doesNotMatch(contents, /\brelease work\b/i, `${relativePath} must not use generic release work`);
  }
});

test('alpha uses the intentional v2 plan contract without changing the MCP protocol version', () => {
  assert.match(read('src/types.ts'), /PLAN_VERSION = "2"/);
  assert.match(read('src/adapter.ts'), /version: PLAN_VERSION/);
  assert.match(read('docs/changeset-spec.md'), /"version": "2"/);
  assert.match(read('src/mcp.ts'), /protocolVersion: "2024-11-05"/);
});
