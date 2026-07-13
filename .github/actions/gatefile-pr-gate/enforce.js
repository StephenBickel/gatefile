#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readJsonFile } = require('./evidence-io.js');

function main() {
  if (process.argv.length !== 4) {
    throw new Error('Usage: enforce.js <verify-report.json> <dry-run-report.json>');
  }
  const verify = readJsonFile(path.resolve(process.argv[2]), 'verify report').value;
  const dryRun = readJsonFile(path.resolve(process.argv[3]), 'dry-run report').value;
  if (verify.planId !== dryRun.planId) {
    throw new Error('Verify and dry-run evidence are bound to different plans');
  }
  if (verify.status !== 'ready' || dryRun.staticGate?.passed !== true) {
    const blockers = Array.isArray(verify.blockers) && verify.blockers.length > 0
      ? `: ${verify.blockers.join('; ')}`
      : '';
    throw new Error(`Gatefile plan is not ready${blockers}`);
  }
  console.log(`Gatefile plan ${verify.planId} is ready`);
}

try {
  main();
} catch (error) {
  console.error(`Gatefile Action enforcement error: ${error.message}`);
  process.exitCode = 1;
}
