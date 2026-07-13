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

function workflowRunScripts(workflow) {
  const lines = workflow.split('\n');
  const scripts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const run = lines[index].match(/^([ ]*)run:[ \t]*(.*)$/);
    if (!run) continue;

    if (!/^[|>][-+]?\s*$/.test(run[2])) {
      scripts.push(run[2]);
      continue;
    }

    const indentation = run[1].length;
    const block = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      const nextIndentation = nextLine.match(/^[ ]*/)[0].length;
      if (nextLine.trim() !== '' && nextIndentation <= indentation) break;
      block.push(nextLine.slice(Math.min(nextLine.length, indentation + 2)));
      index += 1;
    }
    scripts.push(block.join('\n'));
  }

  return scripts.join('\n');
}

function assertForkSigningWorkflowSafe(workflow) {
  const runScripts = workflowRunScripts(workflow);
  const checkoutUses = workflow.match(
    /^[ \t]*uses:[ \t]*actions\/checkout@[^\s#]+[ \t]*$/gm
  ) ?? [];

  assert.equal(
    checkoutUses.length,
    1,
    `signing workflow must contain exactly one checkout; found ${checkoutUses.length}`
  );
  assert.match(
    workflow,
    /^[ \t]*uses:[ \t]*actions\/checkout@v5[ \t]*\n[ \t]*with:[ \t]*\n[ \t]*ref:[ \t]*\$\{\{ github\.event\.repository\.default_branch \}\}[ \t]*$/m,
    'workflow_dispatch must not be allowed to select the code used for signing'
  );
  assert.doesNotMatch(
    workflow,
    /^[ \t]*ref:[ \t]*.*(?:pull_request|head_ref|head\.sha|refs\/pull|steps\.[^\s]+\.outputs\.head)/im,
    'signing workflow must not checkout PR or head refs'
  );
  assert.doesNotMatch(
    runScripts,
    /(?:^|\n)[ \t]*(?:run:[ \t]*)?(?:git[ \t]+(?:checkout|switch|worktree)|gh[ \t]+pr[ \t]+checkout)\b/im,
    'signing workflow must not checkout PR or head refs with shell commands'
  );

  const artifactPath = String.raw`(?:\.\/)?\.gatefile-artifacts\/input\/`;
  const artifactExecutionChecks = [
    [runScripts, new RegExp(
      String.raw`(?:^|\n)[ \t]*(?:run:[ \t]*)?(?:bash|sh|zsh|node|deno|bun|python(?:\d+(?:\.\d+)*)?|ruby|perl)[ \t]+(?:--?[^\s]+[ \t]+)*["']?${artifactPath}`,
      'im'
    )],
    [runScripts, new RegExp(
      String.raw`(?:^|\n)[ \t]*(?:run:[ \t]*)?(?:source|\.)[ \t]+["']?${artifactPath}`,
      'im'
    )],
    [workflow, new RegExp(String.raw`^[ \t]*uses:[ \t]*["']?${artifactPath}`, 'im')],
    [runScripts, new RegExp(String.raw`(?:require|import)[ \t]*\([ \t]*["']${artifactPath}`, 'im')],
    [runScripts, new RegExp(
      String.raw`(?:^|\n)[ \t]*(?:run:[ \t]*)?["']?${artifactPath}[^\s"']*["']?(?:[ \t]|$)`,
      'im'
    )],
    [workflow, new RegExp(
      String.raw`(?:working-directory:|(?:cd|pushd)[ \t]+)[ \t]*["']?(?:\.\/)?\.gatefile-artifacts\/input(?:\/|\b)`,
      'im'
    )]
  ];

  for (const [text, pattern] of artifactExecutionChecks) {
    assert.doesNotMatch(
      text,
      pattern,
      'signing workflow must not execute files from the PR artifact'
    );
  }

  const artifactConfigOrHookPatterns = [
    new RegExp(
      String.raw`(?:--config(?:=|[ \t]+)|GATEFILE_[A-Z_]*(?:CONFIG|HOOK)[A-Z_]*(?:=|:[ \t]*))["']?(?:\.\/)?\.gatefile-artifacts\/input(?:\/|\b)`,
      'im'
    ),
    new RegExp(
      String.raw`(?:\.\/)?\.gatefile-artifacts\/input\/[^\s"']*(?:gatefile\.config\.(?:json|ya?ml)|hooks?[^\s"']*)`,
      'im'
    )
  ];

  for (const pattern of artifactConfigOrHookPatterns) {
    assert.doesNotMatch(
      workflow,
      pattern,
      'signing workflow must not load config or hooks from the PR artifact'
    );
  }
}

function appendWorkflowSteps(workflow, steps) {
  return `${workflow.trimEnd()}\n${steps.join('\n')}\n`;
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

  assert.doesNotThrow(() => assertForkSigningWorkflowSafe(workflow));
});

test('workflow safety assertion rejects a later checkout of PR code', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Checkout attacker PR after trusted checkout',
    '        uses: actions/checkout@v5',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSafe(maliciousWorkflow),
    /exactly one checkout/,
    'the safety assertion accepted a later PR checkout'
  );
});

test('workflow safety assertion rejects a shell checkout of a PR ref', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Switch to attacker PR',
    '        run: git checkout refs/pull/123/head'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSafe(maliciousWorkflow),
    /checkout PR or head refs/,
    'the safety assertion accepted a shell checkout of a PR ref'
  );
});

test('workflow safety assertion rejects executing a script from the PR artifact', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Execute attacker artifact',
    '        run: node .gatefile-artifacts/input/attacker.js'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSafe(maliciousWorkflow),
    /execute files from the PR artifact/,
    'the safety assertion accepted executable PR artifact content'
  );
});

test('workflow safety assertion rejects PR-supplied config or hooks', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Load attacker hooks',
    '        run: node dist/cli.js approve-plan .gatefile-artifacts/input/plan.json --config .gatefile-artifacts/input/gatefile.config.json'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSafe(maliciousWorkflow),
    /load config or hooks from the PR artifact/,
    'the safety assertion accepted PR-supplied config and hooks'
  );
});
