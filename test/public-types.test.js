const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the packed package root compiles and runs the in-memory engine lifecycle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-public-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const packageRoot = path.join(__dirname, '..');
  const cleanPackageRoot = path.join(root, 'clean-package');
  fs.mkdirSync(cleanPackageRoot);
  for (const entry of [
    'LICENSE',
    'README.md',
    'package.json',
    'schema',
    'src',
    'tsconfig.json'
  ]) {
    fs.cpSync(path.join(packageRoot, entry), path.join(cleanPackageRoot, entry), {
      recursive: true
    });
  }
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(cleanPackageRoot, 'node_modules'));
  assert.equal(
    fs.existsSync(path.join(cleanPackageRoot, 'dist')),
    false,
    'the packaging regression must start from a checkout with no prior build output'
  );

  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: cleanPackageRoot,
    encoding: 'utf8',
    shell: false
  });
  assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
  const [{ filename, files }] = JSON.parse(pack.stdout);
  const packedPaths = new Set(files.map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/engine.js',
    'dist/engine.d.ts',
    'dist/cli.js',
    'dist/mcp-server.js'
  ]) {
    assert.equal(packedPaths.has(required), true, `packed artifact is missing ${required}`);
  }
  const installedPackage = path.join(root, 'node_modules', 'gatefile');
  fs.mkdirSync(installedPackage, { recursive: true });
  const extract = spawnSync(
    'tar',
    ['-xzf', path.join(root, filename), '-C', installedPackage, '--strip-components=1'],
    { encoding: 'utf8', shell: false }
  );
  assert.equal(extract.status, 0, `${extract.stdout}\n${extract.stderr}`);

  fs.writeFileSync(path.join(root, 'consumer.ts'), `
import { GatefileEngine, PLAN_VERSION } from 'gatefile';
import type { ApplyReceipt, SnapshotFile, RollbackEntry } from 'gatefile';
declare const receipt: ApplyReceipt;
declare const snapshot: SnapshotFile;
declare const rollback: RollbackEntry;
const engine = new GatefileEngine({
  repoRoot: '/consumer/repo',
  repositoryId: 'repo:packed-types',
  stateHome: '/consumer/state',
  config: {}
});
// @ts-expect-error GatefileEngineContext is an immutable authority snapshot.
engine.context.repoRoot = '/redirected';
const pending = engine.createPlan({
  source: 'packed-types',
  summary: 'Compile the public engine lifecycle',
  operations: [{
    id: 'op_packed_types',
    type: 'file',
    action: 'create',
    path: 'preview-only.txt',
    after: 'preview only\\n'
  }],
  preconditions: []
});
const inspected = engine.inspectPlan(pending);
const approved = engine.approvePlan(pending, 'packed-types');
const verified = engine.verifyPlan(approved);
const previewed = engine.previewPlan(approved);
const values: string[] = [
  PLAN_VERSION,
  engine.context.repositoryId,
  inspected.id,
  verified.status,
  previewed.planId,
  receipt.authentication.tag,
  snapshot.entries[0]?.before.kind ?? 'absent',
  rollback.after.kind
];
void values;
`, 'utf8');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      lib: ['ES2020'],
      module: 'commonjs',
      moduleResolution: 'node'
    },
    files: ['consumer.ts']
  }, null, 2)}\n`, 'utf8');

  const tsc = path.join(__dirname, '..', 'node_modules', '.bin', 'tsc');
  const result = spawnSync(tsc, ['-p', path.join(root, 'tsconfig.json')], {
    encoding: 'utf8',
    shell: false
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const repoRoot = path.join(root, 'repo');
  const stateHome = path.join(root, 'state');
  const runtimeConsumer = path.join(root, 'consumer.cjs');
  fs.mkdirSync(repoRoot);
  fs.writeFileSync(runtimeConsumer, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GatefileEngine } = require('gatefile');

const [repoRoot, stateHome] = process.argv.slice(2);
const target = path.join(repoRoot, 'preview-only.txt');
const engine = new GatefileEngine({
  repoRoot,
  repositoryId: 'repo:packed-runtime',
  stateHome,
  config: {}
});
const pending = engine.createPlan({
  source: 'packed-runtime',
  summary: 'Run the public engine lifecycle without mutation',
  operations: [{
    id: 'op_packed_runtime',
    type: 'file',
    action: 'create',
    path: 'preview-only.txt',
    after: 'preview only\\n'
  }],
  preconditions: []
});
const inspected = engine.inspectPlan(pending);
const approved = engine.approvePlan(pending, 'packed-runtime');
const verified = engine.verifyPlan(approved);
const previewed = engine.previewPlan(approved);

assert.equal(Object.isFrozen(engine.context), true);
assert.equal(inspected.id, pending.id);
assert.equal(verified.status, 'ready');
assert.equal(previewed.success, true);
assert.equal(previewed.verification.status, 'ready');
assert.equal(fs.existsSync(target), false);
assert.equal(fs.existsSync(stateHome), false);
`, 'utf8');

  const runtime = spawnSync(process.execPath, [runtimeConsumer, repoRoot, stateHome], {
    cwd: root,
    encoding: 'utf8',
    shell: false
  });
  assert.equal(runtime.status, 0, `${runtime.stdout}\n${runtime.stderr}`);
  assert.deepEqual(fs.readdirSync(repoRoot), []);
  assert.equal(fs.existsSync(stateHome), false);
});
