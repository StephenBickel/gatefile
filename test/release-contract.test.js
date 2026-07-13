const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const APPROVED_ACTION_SHAS = new Map([
  ['actions/checkout', '93cb6efe18208431cddfb8368fd83d5badbf9bfd'],
  ['actions/setup-node', 'a0853c24544627f65ddf259abe73b1d18a591444']
]);

function read(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1]);
}

function assertPinnedActions(workflow, label) {
  const references = actionReferences(workflow);
  assert.ok(references.length > 0, `${label} must use reviewed Actions`);
  for (const reference of references) {
    const separator = reference.lastIndexOf('@');
    assert.notEqual(separator, -1, `${label}: invalid Action reference ${reference}`);
    const action = reference.slice(0, separator);
    const actualSha = reference.slice(separator + 1);
    assert.match(actualSha, /^[0-9a-f]{40}$/, `${label}: ${action} must use a full commit SHA`);
    assert.equal(
      actualSha,
      APPROVED_ACTION_SHAS.get(action),
      `${label}: ${action} must use its reviewed commit`
    );
  }
}

function assertPackageReleaseContract(manifest) {
  assert.equal(manifest.engines?.node, '>=22');
  assert.match(manifest.devDependencies?.['@types/node'] ?? '', /^\^22\./);
  assert.deepEqual(manifest.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
    tag: 'next',
    provenance: true
  });
  assert.equal(
    manifest.scripts?.prepublishOnly,
    'node scripts/run-release-verification.cjs'
  );
  const verification = manifest.scripts?.['verify:release'] ?? '';
  for (const command of [
    'npm run typecheck',
    'npm test',
    'npm run demo:e2e',
    'npm pack --dry-run'
  ]) {
    assert.match(verification, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

function assertCiContract(workflow) {
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]\s*\n\s*pull_request:/);
  assert.match(workflow, /^permissions:\s*\n\s*contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.match(workflow, /^concurrency:\s*$/m);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/);

  for (const row of [
    ['ubuntu-latest', '22', 'false'],
    ['ubuntu-latest', '24', 'true'],
    ['macos-latest', '24', 'false']
  ]) {
    assert.match(
      workflow,
      new RegExp(`- os: ${row[0]}\\s+node-version: "${row[1]}"\\s+release-checks: ${row[2]}`)
    );
  }
  assert.doesNotMatch(workflow, /node-version:\s*["']?(?:18|20)["']?/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /run:\s*npm ci --ignore-scripts(?:\s|$)/);
  assert.doesNotMatch(workflow, /npm install/);

  for (const command of [
    'npm audit',
    'npm run typecheck',
    'npm pack --dry-run',
    'npm publish --access public --tag next --provenance --dry-run'
  ]) {
    const occurrences = workflow.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [];
    assert.equal(occurrences.length, 1, `${command} must appear exactly once`);
  }
  assert.match(workflow, /if:\s*\$\{\{ matrix\.release-checks \}\}/);
  assert.ok(
    workflow.indexOf('npm publish --access public --tag next --provenance --dry-run') >
      workflow.indexOf('npm pack --dry-run'),
    'publication lifecycle dry-run must follow the package contents check'
  );
  assertPinnedActions(workflow, 'CI');
}

function assertReleaseWorkflowContract(workflow) {
  assert.match(workflow, /on:\s*\n\s*release:\s*\n\s*types:\s*\[published\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|push:\s*\n\s*tags:/);
  assert.match(workflow, /^permissions:\s*\n\s*contents:\s*read\s*\n\s*id-token:\s*write\s*$/m);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /environment:\s*npm/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /node-version:\s*["']24["']/);
  assert.match(workflow, /registry-url:\s*["']https:\/\/registry\.npmjs\.org["']/);
  assert.match(workflow, /package-manager-cache:\s*false/);

  assert.match(workflow, /v\$\{version\}/);
  assert.match(workflow, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git merge-base --is-ancestor .*refs\/remotes\/origin\/main/);
  assert.match(workflow, /RELEASE_PRERELEASE:\s*\$\{\{ github\.event\.release\.prerelease \}\}/);
  assert.match(workflow, /11\.5\.1/);

  const installIndex = workflow.indexOf('npm ci --ignore-scripts');
  const auditIndex = workflow.indexOf('npm audit');
  const publishIndex = workflow.indexOf('npm publish');
  assert.ok(installIndex >= 0, 'release must install from the lockfile without lifecycle scripts');
  assert.ok(auditIndex > installIndex, 'release audit must run after installation');
  assert.ok(publishIndex > auditIndex, 'publish must run only after the audit');
  assert.match(workflow, /npm publish --access public --tag next --provenance/);

  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|\$\{\{\s*secrets\./i);
  assertPinnedActions(workflow, 'release workflow');
}

test('package metadata pins the supported runtime and fail-closed npm publication policy', () => {
  const manifest = JSON.parse(read('package.json'));
  assertPackageReleaseContract(manifest);

  const latestDrift = {
    ...manifest,
    publishConfig: { ...manifest.publishConfig, tag: 'latest' }
  };
  assert.throws(
    () => assertPackageReleaseContract(latestDrift),
    /actual.*latest|expected.*next|deepStrictEqual/is
  );
});

test('prepublish verification clears the outer npm dry-run flag for nested fixtures', () => {
  const wrapper = read('scripts/run-release-verification.cjs');
  assert.match(wrapper, /delete env\.npm_config_dry_run/);
  assert.match(wrapper, /delete env\.NPM_CONFIG_DRY_RUN/);
  assert.match(wrapper, /spawnSync\(npmCommand, \['run', 'verify:release'\]/);
  assert.match(wrapper, /shell:\s*false/);
});

test('package allowlist contains the public release docs and runnable examples', () => {
  const manifest = JSON.parse(read('package.json'));
  const packedFiles = new Set(manifest.files);
  for (const relativePath of [
    'CHANGELOG.md',
    'SECURITY.md',
    'docs/migrating-to-0.3.md',
    'examples/public-launch-safe-draft.json',
    'examples/public-launch-unsafe-draft.json',
    'examples/coding-agent-plan.json',
    'examples/agent-adapter-input.json',
    'examples/dependent-plan.json',
    'examples/ops-plan.json'
  ]) {
    assert.equal(packedFiles.has(relativePath), true, `package must include ${relativePath}`);
    assert.equal(fs.existsSync(path.join(projectRoot, relativePath)), true, `${relativePath} must exist`);
  }
  assert.equal(packedFiles.has('demo.gif'), false, 'the remote README demo must not bloat the package');
  assert.equal(
    packedFiles.has('docs/examples/github-pr-review-comment.yml'),
    false,
    'the unsafe PR-comment workflow must not ship'
  );
});

test('packaged release guidance remains accurate before and after publication', () => {
  const manifest = JSON.parse(read('package.json'));
  const packedMarkdown = ['README.md', 'CHANGELOG.md', 'SECURITY.md', ...manifest.files]
    .filter((relativePath, index, entries) =>
      relativePath.endsWith('.md') && entries.indexOf(relativePath) === index
    )
    .map((relativePath) => read(relativePath))
    .join('\n');

  for (const staleClaim of [
    /not yet published/i,
    /currently being prepared/i,
    /forthcoming `0\.3\.0-alpha\.0`/i,
    /unpublished `0\.3\.0-alpha\.0`/i,
    /after (?:the prerelease|it) is published/i
  ]) {
    assert.doesNotMatch(packedMarkdown, staleClaim);
  }
  const readme = read('README.md');
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/[^\s)]+\/main\/demo\.gif/);
  assert.match(
    readme,
    /raw\.githubusercontent\.com\/StephenBickel\/gatefile\/[0-9a-f]{40}\/demo\.gif/
  );
  assert.match(read('LICENSE'), /Copyright \(c\) 2026 Stephen Bickel/);
});

test('CI covers supported Linux and macOS runtimes once with locked, least-privilege inputs', () => {
  assertCiContract(read('.github/workflows/ci.yml'));
});

test('published releases use provenance-bearing trusted publication from reviewed main history', () => {
  const workflow = read('.github/workflows/release.yml');
  assertReleaseWorkflowContract(workflow);

  const tokenDrift = `${workflow}\nNODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n`;
  assert.throws(
    () => assertReleaseWorkflowContract(tokenDrift),
    /NPM_TOKEN|NODE_AUTH_TOKEN|secrets/i
  );
});

test('Dependabot checks npm and GitHub Actions every week', () => {
  const config = read('.github/dependabot.yml');
  assert.match(config, /^version:\s*2$/m);
  for (const ecosystem of ['npm', 'github-actions']) {
    assert.match(
      config,
      new RegExp(`package-ecosystem: "${ecosystem}"[\\s\\S]*?directory: "/"[\\s\\S]*?interval: "weekly"`)
    );
  }
});
