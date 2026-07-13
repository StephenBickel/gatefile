const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Never let tests use an operator's configured state home. Each test-runner
// process gets private disposable state, and its subprocesses inherit it.
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-test-state-'));
process.env.GATEFILE_STATE_HOME = stateHome;
process.on('exit', () => {
  fs.rmSync(stateHome, { recursive: true, force: true });
});
