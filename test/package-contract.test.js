const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');

const PACKED_DOCUMENTATION_FILES = [
  'docs/agent-adapter.md',
  'docs/architecture.md',
  'docs/changeset-spec.md',
  'docs/coding-agent-demo.md',
  'docs/examples/github-native-signed-approval-fork-request.yml',
  'docs/examples/github-native-signed-approval-fork-sign.yml',
  'docs/examples/github-pr-gate.inlined.yml',
  'docs/examples/github-pr-gate.yml',
  'docs/examples/github-pr-review-comment.yml',
  'docs/github-pr-gate-example.md',
  'docs/product-roadmap.md',
  'docs/signed-approvals.md',
  'docs/use-cases.md'
];

const PUBLIC_RUNTIME_EXPORTS = [
  'APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES',
  'AUTHENTICATED_STATE_FILE_MAX_BYTES',
  'GatefileEngine',
  'GatefileValidationError',
  'HASH_CANONICALIZER',
  'HASH_ENVELOPE_VERSION',
  'MAX_COMMAND_ARGUMENTS',
  'MAX_PLAN_DEPENDENCIES',
  'MAX_PLAN_OPERATIONS',
  'MAX_WORST_CASE_APPLY_RECEIPT_BYTES',
  'PLAN_RECEIPT_TEXT_MAX_LENGTH',
  'PLAN_VERSION',
  'STATE_RECORD_BOUND_ID_MAX_LENGTH',
  'STATE_RECORD_TEXT_MAX_LENGTH',
  'adaptAgentInputToDraft',
  'applyPlan',
  'applyPlanFile',
  'approvePlan',
  'approvePlanFile',
  'audit',
  'buildInspectReport',
  'computePlanHash',
  'createApprovalAttestation',
  'createPlan',
  'createPlanFromDraft',
  'fireOnApprovalNeeded',
  'fireOnPlanApproved',
  'fireOnPlanCreated',
  'formatApplySummary',
  'formatAuditTable',
  'formatDryRunSummary',
  'formatInspectSummary',
  'formatPipelineSummary',
  'formatRollbackSummary',
  'generateApprovalAttestationKeyPair',
  'inspectPlan',
  'loadHooksConfig',
  'normalizeGatefileConfig',
  'normalizePlanForHash',
  'previewPlan',
  'renderPRReviewComment',
  'repositoryIdForRoot',
  'reviewPlan',
  'rollbackApply',
  'rollbackApplyFile',
  'runPipeline',
  'scoreRisk',
  'startMcpServer',
  'validatePlanDraft',
  'validatePlanFile',
  'verifyApprovalAttestation',
  'verifyPlan',
  'verifyPlanFile',
  'withComputedIntegrity'
].sort();

const EXPECTED_EXPORTS = {
  '.': {
    types: './dist/index.d.ts',
    require: './dist/index.js',
    default: './dist/index.js'
  },
  './schema/gatefile.schema.json': './schema/gatefile.schema.json',
  './schema/gatefile.config.schema.json': './schema/gatefile.config.schema.json',
  './package.json': './package.json'
};

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options
  });
}

function createPackedConsumer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-package-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cleanPackageRoot = path.join(root, 'package-source');
  fs.mkdirSync(cleanPackageRoot);
  for (const entry of [
    'LICENSE',
    'README.md',
    'demo.gif',
    'docs',
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
  assert.equal(fs.existsSync(path.join(cleanPackageRoot, 'dist')), false);

  const packed = run('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: cleanPackageRoot
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const [metadata] = JSON.parse(packed.stdout);
  const tarball = path.join(root, metadata.filename);

  const generatedDist = fs.readdirSync(path.join(cleanPackageRoot, 'dist')).sort();
  const expectedPackedFiles = [
    'LICENSE',
    'README.md',
    'demo.gif',
    ...PACKED_DOCUMENTATION_FILES,
    'package.json',
    'schema/gatefile.config.schema.json',
    'schema/gatefile.schema.json',
    ...generatedDist.map((name) => `dist/${name}`)
  ].sort();
  assert.deepEqual(
    metadata.files.map((file) => file.path).sort(),
    expectedPackedFiles,
    'the tarball must contain only reviewed runtime artifacts'
  );

  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'gatefile-contract-consumer', private: true }, null, 2)}\n`,
    'utf8'
  );
  const installed = run(
    'npm',
    ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumer }
  );
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  return { root, consumer, metadata };
}

test('the installed tarball enforces the reviewed package-specifier contract', (t) => {
  const { consumer } = createPackedConsumer(t);
  const installedPackageRoot = path.join(consumer, 'node_modules', 'gatefile');
  const manifest = JSON.parse(fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8'));

  assert.deepEqual(manifest.exports, EXPECTED_EXPORTS);

  const cjs = run(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(Object.keys(require("gatefile")).sort()))'],
    { cwd: consumer }
  );
  assert.equal(cjs.status, 0, cjs.stderr);
  assert.deepEqual(JSON.parse(cjs.stdout), PUBLIC_RUNTIME_EXPORTS);

  const esm = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import { GatefileEngine, PLAN_VERSION } from "gatefile"; process.stdout.write(`${typeof GatefileEngine}:${PLAN_VERSION}`)'
    ],
    { cwd: consumer }
  );
  assert.equal(esm.status, 0, esm.stderr);
  assert.equal(esm.stdout, 'function:2');

  for (const deepImport of [
    'gatefile/dist/applier',
    'gatefile/dist/planner',
    'gatefile/dist/approval-validation',
    'gatefile/dist/pinned-runtime'
  ]) {
    const rejected = run(
      process.execPath,
      [
        '-e',
        `try { require(${JSON.stringify(deepImport)}); process.exit(9); } catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }`
      ],
      { cwd: consumer }
    );
    assert.equal(rejected.status, 0, `${deepImport}: ${rejected.stderr}`);
  }

  const schemas = run(
    process.execPath,
    [
      '-e',
      'const plan=require("gatefile/schema/gatefile.schema.json");const config=require("gatefile/schema/gatefile.config.schema.json");const pkg=require("gatefile/package.json");process.stdout.write(JSON.stringify([plan.title,config.title,pkg.name]))'
    ],
    { cwd: consumer }
  );
  assert.equal(schemas.status, 0, schemas.stderr);
  assert.deepEqual(JSON.parse(schemas.stdout), [
    'Gatefile v2 plan artifact',
    'Gatefile configuration',
    'gatefile'
  ]);

  fs.writeFileSync(
    path.join(consumer, 'consumer.ts'),
    `import { GatefileEngine, PLAN_VERSION } from "gatefile";\n` +
      `import type { ApplyReceipt, DryRunReport, InspectReport, PlanFile } from "gatefile";\n` +
      `declare const plan: PlanFile; declare const receipt: ApplyReceipt; declare const preview: DryRunReport; declare const inspect: InspectReport;\n` +
      `const engine = new GatefileEngine({ repoRoot: "/tmp/repo", repositoryId: "repo:consumer", config: {} });\n` +
      `const values: unknown[] = [PLAN_VERSION, engine.context.repositoryId, plan.id, receipt.id, preview.planId, inspect.id]; void values;\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(consumer, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
        lib: ['ES2020'],
        module: 'Node16',
        moduleResolution: 'Node16'
      },
      files: ['consumer.ts']
    }, null, 2)}\n`,
    'utf8'
  );
  const typescript = run(
    path.join(packageRoot, 'node_modules', '.bin', 'tsc'),
    ['-p', path.join(consumer, 'tsconfig.json')],
    { cwd: consumer }
  );
  assert.equal(typescript.status, 0, `${typescript.stdout}\n${typescript.stderr}`);

  const cli = run(path.join(consumer, 'node_modules', '.bin', 'gatefile'), [], { cwd: consumer });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /gatefile commands:/);

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'package-contract-test', version: '1' }
    }
  };
  const mcp = run(path.join(consumer, 'node_modules', '.bin', 'gatefile-mcp'), [], {
    cwd: consumer,
    input: `${JSON.stringify(initialize)}\n`
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).result.serverInfo.name, 'gatefile');

  const installedReadme = fs.readFileSync(path.join(installedPackageRoot, 'README.md'), 'utf8');
  const localTargets = [...installedReadme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#')[0])
    .filter((target) => target.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(target));
  assert.ok(localTargets.length > 0, 'README did not expose any local documentation links');
  for (const target of localTargets) {
    assert.equal(
      fs.existsSync(path.join(installedPackageRoot, target)),
      true,
      `packed README target is missing: ${target}`
    );
  }
});
