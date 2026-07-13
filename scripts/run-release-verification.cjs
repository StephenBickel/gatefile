#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

// `npm publish --dry-run` exports npm_config_dry_run=true to lifecycle scripts.
// Verification intentionally runs real nested npm pack/install fixtures, while
// the parent npm process retains responsibility for suppressing publication.
const env = { ...process.env };
delete env.npm_config_dry_run;
delete env.NPM_CONFIG_DRY_RUN;

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'verify:release'], {
  env,
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error(`Release verification failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
