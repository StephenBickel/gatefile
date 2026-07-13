#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseNamedArguments,
  readJsonFile,
  resolveRepoFile,
  sha256,
  writeRepoJson
} = require('./evidence-io.js');

const allowed = new Set([
  '--package-json',
  '--plan',
  '--plan-source-path',
  '--inspect',
  '--verify',
  '--dry-run',
  '--manifest',
  '--head',
  '--policy-mode',
  '--policy-ref',
  '--policy-path',
  '--policy-sha256'
]);
const required = [
  '--package-json',
  '--plan',
  '--plan-source-path',
  '--inspect',
  '--verify',
  '--dry-run',
  '--manifest',
  '--head',
  '--policy-mode'
];

function main() {
  const args = parseNamedArguments(process.argv.slice(2), allowed, required);
  const repoRoot = fs.realpathSync(process.cwd());
  const loadRepoJson = (argument, label) => {
    const location = resolveRepoFile(repoRoot, args[argument], label).target;
    return { location, ...readJsonFile(location, label) };
  };

  const packageDocument = readJsonFile(
    path.resolve(args['--package-json']),
    'Action package.json',
    1024 * 1024
  ).value;
  const plan = loadRepoJson('--plan', 'plan');
  const inspect = loadRepoJson('--inspect', 'inspect report');
  const verify = loadRepoJson('--verify', 'verify report');
  const dryRun = loadRepoJson('--dry-run', 'dry-run report');

  const planId = plan.value.id;
  const inspectPlanId = inspect.value.id ?? inspect.value.planId;
  if (
    typeof planId !== 'string' ||
    inspectPlanId !== planId ||
    verify.value.planId !== planId ||
    dryRun.value.planId !== planId
  ) {
    throw new Error('Cannot manifest evidence that is not bound to one plan ID');
  }
  const semanticHash = verify.value.hashes?.currentPlanHash;
  if (typeof semanticHash !== 'string' || !/^[a-f0-9]{64}$/u.test(semanticHash)) {
    throw new Error('Verify report lacks a valid semantic plan hash');
  }
  if (inspect.value.verification?.hashes?.currentPlanHash !== semanticHash) {
    throw new Error('Inspect and verify reports disagree on the semantic plan hash');
  }
  if (!/^[a-f0-9]{40}$/u.test(args['--head'])) {
    throw new Error('Git head must be a full lowercase 40-character commit SHA');
  }

  let policy;
  if (args['--policy-mode'] === 'trusted-snapshot') {
    for (const name of ['--policy-ref', '--policy-path', '--policy-sha256']) {
      if (!args[name]) throw new Error(`${name} is required for trusted-snapshot policy mode`);
    }
    if (!/^[a-f0-9]{40}$/u.test(args['--policy-ref'])) {
      throw new Error('Trusted policy ref must be a full lowercase commit SHA');
    }
    if (!/^[a-f0-9]{64}$/u.test(args['--policy-sha256'])) {
      throw new Error('Trusted policy SHA-256 must be lowercase hexadecimal');
    }
    policy = {
      mode: 'trusted-snapshot',
      ref: args['--policy-ref'],
      path: args['--policy-path'],
      sha256: args['--policy-sha256']
    };
  } else if (args['--policy-mode'] === 'unsigned-no-policy') {
    policy = { mode: 'unsigned-no-policy' };
  } else {
    throw new Error(`Unsupported policy mode: ${args['--policy-mode']}`);
  }

  const manifest = {
    schemaVersion: 1,
    gatefileVersion: packageDocument.version,
    generatedAt: new Date().toISOString(),
    plan: {
      id: planId,
      semanticHash,
      rawSha256: sha256(plan.bytes),
      path: args['--plan-source-path']
    },
    git: { head: args['--head'] },
    policy,
    evidence: {
      inspect: { path: args['--inspect'], sha256: sha256(inspect.bytes) },
      verify: { path: args['--verify'], sha256: sha256(verify.bytes) },
      dryRun: { path: args['--dry-run'], sha256: sha256(dryRun.bytes) }
    },
    decision: {
      verificationStatus: verify.value.status,
      staticGatePassed: dryRun.value.staticGate?.passed === true
    }
  };
  writeRepoJson(repoRoot, args['--manifest'], manifest, 'evidence manifest');
}

try {
  main();
} catch (error) {
  console.error(`Gatefile Action manifest error: ${error.message}`);
  process.exitCode = 1;
}
