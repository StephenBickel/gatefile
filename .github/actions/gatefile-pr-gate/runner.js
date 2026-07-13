#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseNamedArguments,
  readJsonFile,
  resolveRepoFile,
  writeRepoJson
} = require('./evidence-io.js');

const allowed = new Set([
  '--package-root',
  '--repo-root',
  '--state-home',
  '--plan',
  '--config',
  '--inspect',
  '--verify',
  '--dry-run'
]);
const required = [
  '--package-root',
  '--repo-root',
  '--state-home',
  '--plan',
  '--inspect',
  '--verify',
  '--dry-run'
];

function main() {
  const args = parseNamedArguments(process.argv.slice(2), allowed, required);
  const packageRoot = fs.realpathSync(args['--package-root']);
  const repoRoot = fs.realpathSync(args['--repo-root']);
  const stateHome = path.resolve(args['--state-home']);
  if (!path.isAbsolute(packageRoot) || !path.isAbsolute(repoRoot) || !path.isAbsolute(stateHome)) {
    throw new Error('package root, repository root, and state home must be absolute paths');
  }

  const runtimePath = fs.realpathSync(path.join(packageRoot, 'dist', 'index.js'));
  if (!runtimePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error('Action-owned Gatefile runtime resolves outside its package checkout');
  }
  // Deliberately use the Action package checkout by absolute path. Never resolve
  // Gatefile or a verifier from the untrusted consumer workspace.
  const gatefile = require(runtimePath);
  if (
    typeof gatefile.GatefileEngine !== 'function' ||
    typeof gatefile.normalizeGatefileConfig !== 'function'
  ) {
    throw new Error('Action-owned Gatefile runtime does not expose the required engine API');
  }

  const planLocation = resolveRepoFile(repoRoot, args['--plan'], 'plan').target;
  const plan = readJsonFile(planLocation, 'plan', 16 * 1024 * 1024).value;
  const config = args['--config']
    ? gatefile.normalizeGatefileConfig(
        readJsonFile(path.resolve(args['--config']), 'trusted policy', 1024 * 1024).value
      )
    : gatefile.normalizeGatefileConfig({});

  const engine = new gatefile.GatefileEngine({ repoRoot, stateHome, config });
  const inspect = engine.inspectPlan(plan);
  const verify = engine.verifyPlan(plan);
  const dryRun = engine.previewPlan(plan, { planPath: planLocation });

  const inspectPlanId = inspect.id ?? inspect.planId;
  if (
    typeof plan.id !== 'string' ||
    inspectPlanId !== plan.id ||
    verify.planId !== plan.id ||
    dryRun.planId !== plan.id
  ) {
    throw new Error('Action evidence is not consistently bound to one plan ID');
  }
  if (inspect.verification?.hashes?.currentPlanHash !== verify.hashes?.currentPlanHash) {
    throw new Error('Inspect and verify evidence disagree on the semantic plan hash');
  }

  writeRepoJson(repoRoot, args['--inspect'], inspect, 'inspect report');
  writeRepoJson(repoRoot, args['--verify'], verify, 'verify report');
  writeRepoJson(repoRoot, args['--dry-run'], dryRun, 'dry-run report');
}

try {
  main();
} catch (error) {
  console.error(`Gatefile Action runner error: ${error.message}`);
  process.exitCode = 1;
}
