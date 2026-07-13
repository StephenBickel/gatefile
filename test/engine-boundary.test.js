const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ADAPTERS = [
  'src/cli.ts',
  'src/sdk.ts',
  'src/pipeline.ts',
  'src/review.ts',
  'src/pr-review.ts'
];

const KERNEL_MODULES = new Set(['./planner', './applier', './verify', './inspect']);
const LIFECYCLE_SYMBOLS = new Set([
  'createPlanFromDraft',
  'approvePlan',
  'verifyPlan',
  'buildInspectReport',
  'previewPlan',
  'applyPlan',
  'rollbackApply'
]);
const PURE_VALUE_IMPORTS = new Map([
  ['./inspect', new Set(['formatInspectSummary'])]
]);

function stripComments(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source
  );
  let output = '';
  let previousEnd = 0;

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }

    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    output += source.slice(previousEnd, start);
    output += source.slice(start, end).replace(/[^\r\n]/g, ' ');
    previousEnd = end;
  }

  return output + source.slice(previousEnd);
}

function boundaryViolations(file, source) {
  const stripped = stripComments(source);
  const parsed = ts.createSourceFile(
    file,
    stripped,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations = [];
  const namespaceImports = new Map();

  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleName = statement.moduleSpecifier.text;
    if (!KERNEL_MODULES.has(moduleName)) continue;

    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;

    if (clause.name) {
      violations.push(`${file}: value default import from ${moduleName}`);
    }

    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaceImports.set(bindings.name.text, moduleName);
      violations.push(`${file}: value namespace import from ${moduleName}`);
      continue;
    }

    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = (element.propertyName ?? element.name).text;
      if (PURE_VALUE_IMPORTS.get(moduleName)?.has(importedName)) continue;
      violations.push(`${file}: value import ${importedName} from ${moduleName}`);
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && LIFECYCLE_SYMBOLS.has(callee.text)) {
        violations.push(`${file}: direct lifecycle call ${callee.text}()`);
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaceImports.has(callee.expression.text) &&
        LIFECYCLE_SYMBOLS.has(callee.name.text)
      ) {
        violations.push(
          `${file}: namespace lifecycle call ${callee.expression.text}.${callee.name.text}()`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  return [...new Set(violations)];
}

test('first-party adapters do not import or call lifecycle kernels directly', () => {
  const root = path.join(__dirname, '..');
  const violations = ADAPTERS.flatMap((file) =>
    boundaryViolations(file, fs.readFileSync(path.join(root, file), 'utf8'))
  );

  assert.deepEqual(
    violations,
    [],
    `Lifecycle boundary violations:\n${violations.map((entry) => `- ${entry}`).join('\n')}`
  );
});

test('boundary permits pure formatters, type-only imports, and commented examples', () => {
  const source = `
    // import { verifyPlan } from "./verify";
    /* applyPlan(plan); */
    import { formatInspectSummary, type InspectReport } from "./inspect";
    import type { PlanDraft } from "./planner";
  `;

  assert.deepEqual(boundaryViolations('fixture.ts', source), []);
});
