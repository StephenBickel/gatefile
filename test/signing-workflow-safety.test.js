const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const unsafeExample = path.join(root, 'docs/examples/github-native-signed-approval.yml');
const signingGuide = path.join(root, 'docs/signed-approvals.md');
const forkSigningWorkflow = path.join(
  root,
  'docs/examples/github-native-signed-approval-fork-sign.yml'
);

function documentationFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return documentationFiles(entryPath);
    return /\.(?:md|ya?ml)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('unsafe same-repository signing example is removed', () => {
  assert.equal(
    fs.existsSync(unsafeExample),
    false,
    'docs/examples/github-native-signed-approval.yml must be deleted'
  );
});

test('README and docs no longer reference the unsafe signing example', () => {
  const reference = 'docs/examples/github-native-signed-approval.yml';
  const files = [path.join(root, 'README.md'), ...documentationFiles(path.join(root, 'docs'))]
    .filter((file) => file !== unsafeExample);
  const references = files
    .filter((file) => fs.readFileSync(file, 'utf8').includes(reference))
    .map((file) => path.relative(root, file));

  assert.deepEqual(references, [], `unsafe example is still referenced by: ${references.join(', ')}`);
});

test('signed approval guide contains a complete rotation runbook and honest inventory status', () => {
  const guide = fs.readFileSync(signingGuide, 'utf8');
  const requiredGuidance = [
    'Replace the GitHub Actions secret',
    '`signers.trustedPublicKeys`',
    '`signers.trustedKeyIds`',
    'Revoke the old key',
    'Verify the replacement',
    'The repository scan found no tracked private key',
    'the GitHub Actions repository-secret inventory returned no repository secrets',
    'no in-scope live key existed to rotate',
    'does not establish that copies outside this repository were rotated'
  ];

  for (const guidance of requiredGuidance) {
    assert.ok(guide.includes(guidance), `missing rotation guidance: ${guidance}`);
  }
});

test('fork-safe guide treats PR artifacts as inert data under trusted code', () => {
  const guide = fs.readFileSync(signingGuide, 'utf8');
  const requiredGuidance = [
    'inert artifacts',
    'trusted default-branch or immutable release code',
    'never executes code or hooks from the PR'
  ];

  for (const guidance of requiredGuidance) {
    assert.ok(guide.includes(guidance), `missing fork-safe boundary: ${guidance}`);
  }
});

test('fork-safe signing workflow explicitly checks out the trusted default branch', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');

  assert.match(
    workflow,
    /uses: actions\/checkout@v5\n\s+with:\n\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
    'workflow_dispatch must not be allowed to select the code used for signing'
  );
});
