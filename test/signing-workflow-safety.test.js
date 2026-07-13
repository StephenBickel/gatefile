const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const unsafeExample = path.join(root, 'docs/examples/github-native-signed-approval.yml');
const signingGuide = path.join(root, 'docs/signed-approvals.md');
const forkSigningWorkflow = path.join(
  root,
  'docs/examples/github-native-signed-approval-fork-sign.yml'
);
const failClosedWorkflowError = /reviewed workflow contract/;
// This workflow runs with the signing secret, so every content change must fail closed.
// After a conscious security re-review, recompute and deliberately repin this digest;
// never derive or update the expected value automatically from the workflow under test.
const reviewedForkSigningWorkflowSha256 =
  '8813762b8dd160565947ac0b48c940938a56558aa325dd44125c687b99302951';

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

function workflowStep(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);

  const indentation = lines[start].match(/^[ ]*/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    if (lines[end].match(/^[ ]*/)[0].length === indentation && lines[end].trimStart().startsWith('- name:')) {
      break;
    }
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function workflowStepScript(step) {
  const lines = step.split('\n');
  const start = lines.findIndex((line) => /^([ ]*)script:[ \t]*\|[-+]?[ \t]*$/.test(line));
  assert.notEqual(start, -1, 'github-script script block not found');

  const indentation = lines[start].match(/^[ ]*/)[0].length;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const lineIndentation = line.match(/^[ ]*/)[0].length;
    if (line.trim() !== '' && lineIndentation <= indentation) break;
    block.push(line.slice(Math.min(line.length, indentation + 2)));
  }
  return block.join('\n');
}

function runArtifactMetadataValidation(context) {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const script = workflowRunScripts(workflowStep(workflow, 'Validate artifact metadata'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefile-artifact-metadata-'));
  const artifactDirectory = path.join(directory, '.gatefile-artifacts/input');
  const outputPath = path.join(directory, 'github-output.txt');

  try {
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDirectory, 'context.json'),
      `${JSON.stringify(context)}\n`,
      'utf8'
    );
    fs.writeFileSync(outputPath, '', 'utf8');
    const result = childProcess.spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'trusted-owner/trusted-repo'
      }
    });

    return {
      status: result.status,
      stderr: result.stderr,
      output: fs.readFileSync(outputPath, 'utf8')
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function normalizedWorkflowSha256(workflow) {
  const normalized = `${workflow.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function assertReviewedForkSigningWorkflow(workflow) {
  assert.equal(
    normalizedWorkflowSha256(workflow),
    reviewedForkSigningWorkflowSha256,
    'privileged signing workflow no longer matches the reviewed workflow contract; security re-review and conscious digest repin are required'
  );
}

function assertForkSigningWorkflowSemantics(workflow) {
  const runScripts = workflowRunScripts(workflow);
  const checkoutUses = workflow.match(
    /^[ \t]*uses:[ \t]*["']?actions\/checkout@[^\s#"']+["']?(?:[ \t]+#[^\n]*)?[ \t]*$/gm
  ) ?? [];

  assert.equal(
    checkoutUses.length,
    1,
    `signing workflow must contain exactly one checkout; found ${checkoutUses.length}`
  );
  assert.match(
    workflow,
    /^[ \t]*uses:[ \t]*actions\/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd(?:[ \t]+# v5)?[ \t]*\n[ \t]*with:[ \t]*\n[ \t]*ref:[ \t]*\$\{\{ github\.event\.repository\.default_branch \}\}[ \t]*$/m,
    'workflow_dispatch must not be allowed to select the code used for signing'
  );
  assert.doesNotMatch(
    workflow,
    /^[ \t]*ref:[ \t]*.*(?:pull_request|head_ref|head\.sha|refs\/pull|steps\.[^\s]+\.outputs\.head)/im,
    'signing workflow must not checkout PR or head refs'
  );
  assert.doesNotMatch(
    runScripts,
    /(?:^|\n)[ \t]*(?:run:[ \t]*)?(?:git\b[^\n]*(?:checkout|switch|worktree)|gh[ \t]+pr[ \t]+checkout)\b/im,
    'signing workflow must not checkout PR or head refs with shell commands'
  );

  const artifactPath = String.raw`(?:\.\/)?\.gatefile-artifacts\/input\/`;
  const artifactExecutionChecks = [
    [runScripts, new RegExp(
      String.raw`(?:^|\n)[ \t]*(?:run:[ \t]*)?(?:env[ \t]+(?:(?:--?[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*)?(?:bash|sh|zsh|node|deno|bun|python(?:\d+(?:\.\d+)*)?|ruby|perl)[ \t]+(?:--?[^\s]+[ \t]+)*["']?${artifactPath}`,
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
    ),
    new RegExp(
      String.raw`\b(?:cp|install|mv)\b[^\n]*${artifactPath}[^\n]*\bgatefile\.config\.(?:json|ya?ml)\b`,
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

function assertForkSigningWorkflowSafe(workflow) {
  assertReviewedForkSigningWorkflow(workflow);
  assertForkSigningWorkflowSemantics(workflow);
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

test('artifact metadata validation accepts a GitHub SHA and normalizes it to lowercase', () => {
  const result = runArtifactMetadataValidation({
    baseRepo: 'trusted-owner/trusted-repo',
    prNumber: 17,
    headSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.output,
    'pr_number=17\nhead_sha=abcdef0123456789abcdef0123456789abcdef01\n'
  );
});

const maliciousShaCases = [
  ['short SHA', 'abcdef0'],
  [
    'JavaScript template payload',
    '${globalThis.process.mainModule.constructor._load("node:fs").writeFileSync("/tmp/gatefile-pwned","1")}'
  ],
  ['newline output injection', `${'a'.repeat(40)}\nforged_output=attacker-controlled`]
];

for (const [name, headSha] of maliciousShaCases) {
  test(`artifact metadata validation rejects ${name}`, () => {
    const result = runArtifactMetadataValidation({
      baseRepo: 'trusted-owner/trusted-repo',
      prNumber: 17,
      headSha
    });
    assert.notEqual(result.status, 0, `accepted malicious headSha: ${JSON.stringify(headSha)}`);
    assert.equal(result.output, '', `wrote GITHUB_OUTPUT for: ${JSON.stringify(headSha)}`);
  });
}

test('github-script receives artifact metadata only through environment variables', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const commentStep = workflowStep(workflow, 'Comment PR with signed artifact details');
  const script = workflowStepScript(commentStep);

  assert.doesNotMatch(script, /\$\{\{\s*steps\.context\.outputs\./);
  assert.match(commentStep, /env:\n\s+PR_NUMBER: \$\{\{ steps\.context\.outputs\.pr_number \}\}/);
  assert.match(commentStep, /HEAD_SHA: \$\{\{ steps\.context\.outputs\.head_sha \}\}/);
  assert.match(script, /process\.env\.PR_NUMBER/);
  assert.match(script, /process\.env\.HEAD_SHA/);
});

test('signing key is always deleted before upload and comment actions', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const stepNames = [...workflow.matchAll(/^\s*- name: (.+)$/gm)].map((match) => match[1]);
  const verifyIndex = stepNames.indexOf('Verify trust + readiness');
  const cleanupIndex = stepNames.indexOf('Cleanup signing key');
  const uploadIndex = stepNames.indexOf('Upload signed plan artifact');
  const commentIndex = stepNames.indexOf('Comment PR with signed artifact details');

  assert.equal(cleanupIndex, verifyIndex + 1, 'cleanup must immediately follow sign/verify');
  assert.ok(cleanupIndex < uploadIndex, 'cleanup must precede artifact upload');
  assert.ok(cleanupIndex < commentIndex, 'cleanup must precede the comment action');
  assert.match(workflowStep(workflow, 'Cleanup signing key'), /if: always\(\)/);
});

test('reviewed workflow contract rejects every unreviewed content mutation', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');

  assert.throws(
    () => assertReviewedForkSigningWorkflow(`${workflow}# unreviewed mutation\n`),
    failClosedWorkflowError
  );
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
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
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
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
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
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
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
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
    /load config or hooks from the PR artifact/,
    'the safety assertion accepted PR-supplied config and hooks'
  );
});

test('workflow safety assertion rejects a quoted checkout with an input-controlled ref', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Quoted attacker checkout',
    '        uses: "actions/checkout@v5"',
    '        with:',
    '          ref: ${{ inputs.checkout_ref }}'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
    /exactly one checkout/,
    'the safety assertion accepted a quoted checkout with an input-controlled ref'
  );
});

test('workflow safety assertion rejects git checkout with global options', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Checkout attacker PR through git global options',
    '        run: git -C . checkout refs/pull/123/head'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
    /checkout PR or head refs/,
    'the safety assertion accepted git -C checkout of a PR ref'
  );
});

test('workflow safety assertion rejects artifact execution through env', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Execute attacker artifact through env',
    '        run: env node .gatefile-artifacts/input/attacker.js'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
    /execute files from the PR artifact/,
    'the safety assertion accepted env-wrapped artifact execution'
  );
});

test('workflow safety assertion rejects copying artifact config into the trusted checkout', () => {
  const workflow = fs.readFileSync(forkSigningWorkflow, 'utf8');
  const maliciousWorkflow = appendWorkflowSteps(workflow, [
    '      - name: Install attacker config before signing',
    '        run: cp .gatefile-artifacts/input/config.json gatefile.config.json && node dist/cli.js approve-plan .gatefile-artifacts/input/plan.json'
  ]);

  assert.throws(
    () => assertForkSigningWorkflowSemantics(maliciousWorkflow),
    /load config or hooks from the PR artifact/,
    'the safety assertion accepted artifact config copied into the trusted checkout'
  );
});
