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
      'Release work',
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
      '## Deferred: Public Launch (MVP)',
      '## Deferred post-alpha backlog'
    ],
    'root roadmap'
  );
});

test('package prerelease does not change schema or protocol versions', () => {
  assert.match(read('src/planner.ts'), /draft\.version \?\? "0\.1"/);
  assert.match(read('src/adapter.ts'), /version: "0\.1"/);
  assert.match(read('docs/changeset-spec.md'), /"version": "0\.1"/);
  assert.match(read('src/mcp.ts'), /protocolVersion: "2024-11-05"/);
});
