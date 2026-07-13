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
  'src/pr-review.ts',
  'src/mcp.ts'
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

function kernelModuleFor(file, moduleName) {
  if (!moduleName.startsWith('.')) return undefined;
  const withoutRuntimeExtension = moduleName.replace(/\.(?:[cm]?js|[cm]?ts)$/, '');
  const normalizedDirect = path.posix.normalize(withoutRuntimeExtension);
  const directCandidate = normalizedDirect.startsWith('.')
    ? normalizedDirect
    : `./${normalizedDirect}`;
  if (KERNEL_MODULES.has(directCandidate)) return directCandidate;

  const resolvedCandidate = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), withoutRuntimeExtension)
  );
  for (const kernelModule of KERNEL_MODULES) {
    if (resolvedCandidate === `src/${kernelModule.slice(2)}`) return kernelModule;
  }
  return undefined;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringValue(node, bindings = new Map()) {
  node = unwrapExpression(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isIdentifier(node)) {
    return bindings.get(node.text);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left, bindings);
    const right = staticStringValue(node.right, bindings);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

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
  const staticStrings = new Map();
  const requireAliases = new Set(['require']);

  let bindingsChanged;
  do {
    bindingsChanged = false;
    function collectBindings(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const value = staticStringValue(node.initializer, staticStrings);
        if (value !== undefined && !staticStrings.has(node.name.text)) {
          staticStrings.set(node.name.text, value);
          bindingsChanged = true;
        }
        const initializer = unwrapExpression(node.initializer);
        if (
          ts.isIdentifier(initializer) &&
          requireAliases.has(initializer.text) &&
          !requireAliases.has(node.name.text)
        ) {
          requireAliases.add(node.name.text);
          bindingsChanged = true;
        }
      }
      ts.forEachChild(node, collectBindings);
    }
    collectBindings(parsed);
  } while (bindingsChanged);

  for (const statement of parsed.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined
    ) {
      const moduleName = staticStringValue(
        statement.moduleReference.expression,
        staticStrings
      );
      if (moduleName !== undefined && kernelModuleFor(file, moduleName) !== undefined) {
        violations.push(`${file}: import-equals load from ${moduleName}`);
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const moduleName = statement.moduleSpecifier.text;
      const kernelModule = kernelModuleFor(file, moduleName);
      if (kernelModule === undefined || statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause === undefined) {
        violations.push(`${file}: value star re-export from ${moduleName}`);
      } else if (ts.isNamespaceExport(clause)) {
        violations.push(`${file}: value namespace re-export from ${moduleName}`);
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const importedName = (element.propertyName ?? element.name).text;
          if (PURE_VALUE_IMPORTS.get(kernelModule)?.has(importedName)) continue;
          violations.push(`${file}: value re-export ${importedName} from ${moduleName}`);
        }
      }
      continue;
    }

    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleName = statement.moduleSpecifier.text;
    const kernelModule = kernelModuleFor(file, moduleName);
    if (kernelModule === undefined) continue;

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
      if (PURE_VALUE_IMPORTS.get(kernelModule)?.has(importedName)) continue;
      violations.push(`${file}: value import ${importedName} from ${moduleName}`);
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const [specifier] = node.arguments;
      const moduleName = specifier === undefined
        ? undefined
        : staticStringValue(specifier, staticStrings);
      if (
        moduleName !== undefined &&
        kernelModuleFor(file, moduleName) !== undefined
      ) {
        if (ts.isIdentifier(callee) && requireAliases.has(callee.text)) {
          violations.push(`${file}: CommonJS load from ${moduleName}`);
        }
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          violations.push(`${file}: dynamic import from ${moduleName}`);
        }
      }
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

test('boundary reports CommonJS and dynamic lifecycle-kernel loads', () => {
  const source = `
    const verifier = require("./verify");
    const apply = require("./applier").applyPlan;
    async function loadPlanner() {
      return import("./planner");
    }
  `;

  assert.deepEqual(boundaryViolations('fixture.ts', source), [
    'fixture.ts: CommonJS load from ./verify',
    'fixture.ts: CommonJS load from ./applier',
    'fixture.ts: dynamic import from ./planner'
  ]);
});

test('boundary rejects explicit JavaScript kernel paths with aliased lifecycle symbols', () => {
  const source = `
    import { applyPlan as rawApply } from "./applier.js";
    const { verifyPlan: rawVerify } = require("./verify.js");
    rawApply(plan);
    rawVerify(plan);
  `;

  assert.deepEqual(boundaryViolations('src/fixture.ts', source), [
    'src/fixture.ts: value import applyPlan from ./applier.js',
    'src/fixture.ts: CommonJS load from ./verify.js'
  ]);
});

test('boundary rejects normalized and statically composed kernel specifiers', () => {
  const source = `
    import { approvePlan as rawApprove } from "./planner/../planner.js";
    const rawApply = require("./" + "applier.js").applyPlan;
    async function rawVerify() {
      return import(\`./verify.js\`);
    }
  `;

  assert.deepEqual(boundaryViolations('src/fixture.ts', source), [
    'src/fixture.ts: value import approvePlan from ./planner/../planner.js',
    'src/fixture.ts: CommonJS load from ./applier.js',
    'src/fixture.ts: dynamic import from ./verify.js'
  ]);
});

test('boundary follows static module and CommonJS loader aliases', () => {
  const source = `
    const applyKernel = "./applier";
    const { applyPlan: rawApply } = require(applyKernel);
    const load = require;
    const { verifyPlan: rawVerify } = load("./verify");
    const plannerKernel = "./planner";
    import(plannerKernel).then((planner) => planner.approvePlan(plan));
  `;

  assert.deepEqual(boundaryViolations('src/fixture.ts', source), [
    'src/fixture.ts: CommonJS load from ./applier',
    'src/fixture.ts: CommonJS load from ./verify',
    'src/fixture.ts: dynamic import from ./planner'
  ]);
});

test('boundary rejects TypeScript import-equals, assertions, and kernel re-exports', () => {
  const source = `
    import raw = require("./applier.js");
    raw.applyPlan(plan);
    const verifier = require("./verify" as string);
    export { approvePlan as rawApprove } from "./planner.js";
  `;

  assert.deepEqual(boundaryViolations('src/fixture.ts', source), [
    'src/fixture.ts: import-equals load from ./applier.js',
    'src/fixture.ts: value re-export approvePlan from ./planner.js',
    'src/fixture.ts: CommonJS load from ./verify'
  ]);
});
