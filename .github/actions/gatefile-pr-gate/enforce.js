#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { readJsonFile, sha256 } = require('./evidence-io.js');

const FILES = Object.freeze({
  plan: 'plan.json',
  inspect: 'inspect-report.json',
  verify: 'verify-report.json',
  dryRun: 'dry-run-report.json',
  manifest: 'gatefile-manifest.json'
});

function loadEvidence(root, filename, label) {
  return readJsonFile(path.join(root, filename), label, 32 * 1024 * 1024);
}

function assertDigest(bytes, expected, label) {
  if (typeof expected !== 'string' || sha256(bytes) !== expected) {
    throw new Error(`${label} digest does not match the evidence manifest`);
  }
}

function main() {
  if (process.argv.length !== 3) {
    throw new Error('Usage: enforce.js <trusted-evidence-directory>');
  }
  const requestedRoot = path.resolve(process.argv[2]);
  const rootStats = fs.lstatSync(requestedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Evidence root must be a non-symlink directory');
  }
  const root = fs.realpathSync(requestedRoot);
  const plan = loadEvidence(root, FILES.plan, 'plan snapshot');
  const inspect = loadEvidence(root, FILES.inspect, 'inspect report');
  const verify = loadEvidence(root, FILES.verify, 'verify report');
  const dryRun = loadEvidence(root, FILES.dryRun, 'dry-run report');
  const manifest = loadEvidence(root, FILES.manifest, 'evidence manifest').value;

  const expectedPaths = {
    inspect: FILES.inspect,
    verify: FILES.verify,
    dryRun: FILES.dryRun
  };
  for (const [name, filename] of Object.entries(expectedPaths)) {
    if (manifest.evidence?.[name]?.path !== filename) {
      throw new Error(`Manifest ${name} path is not the fixed staged evidence path`);
    }
  }
  assertDigest(plan.bytes, manifest.plan?.rawSha256, 'Plan snapshot');
  assertDigest(inspect.bytes, manifest.evidence.inspect.sha256, 'Inspect report');
  assertDigest(verify.bytes, manifest.evidence.verify.sha256, 'Verify report');
  assertDigest(dryRun.bytes, manifest.evidence.dryRun.sha256, 'Dry-run report');

  const inspectPlanId = inspect.value.id ?? inspect.value.planId;
  if (
    typeof plan.value.id !== 'string' ||
    inspectPlanId !== plan.value.id ||
    verify.value.planId !== plan.value.id ||
    dryRun.value.planId !== plan.value.id ||
    manifest.plan.id !== plan.value.id
  ) {
    throw new Error('Staged Action evidence is not bound to one plan ID');
  }
  const semanticHash = verify.value.hashes?.currentPlanHash;
  if (
    typeof semanticHash !== 'string' ||
    inspect.value.verification?.hashes?.currentPlanHash !== semanticHash ||
    manifest.plan.semanticHash !== semanticHash
  ) {
    throw new Error('Staged Action evidence disagrees on the semantic plan hash');
  }
  if (
    manifest.decision?.verificationStatus !== verify.value.status ||
    manifest.decision?.staticGatePassed !== (dryRun.value.staticGate?.passed === true)
  ) {
    throw new Error('Manifest decision disagrees with its digest-bound reports');
  }
  if (verify.value.status !== 'ready' || dryRun.value.staticGate?.passed !== true) {
    const blockers = Array.isArray(verify.value.blockers) && verify.value.blockers.length > 0
      ? `: ${verify.value.blockers.join('; ')}`
      : '';
    throw new Error(`Gatefile plan is not ready${blockers}`);
  }
  console.log(`Gatefile plan ${verify.value.planId} is ready`);
}

try {
  main();
} catch (error) {
  console.error(`Gatefile Action enforcement error: ${error.message}`);
  process.exitCode = 1;
}
