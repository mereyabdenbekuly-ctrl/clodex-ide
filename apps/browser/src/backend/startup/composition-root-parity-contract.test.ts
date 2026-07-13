import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_ROOT_PARITY_CONTRACT,
  type CompositionInvocationExecution,
  type CompositionRootContractEntry,
  type CompositionRootContractGroup,
} from './composition-root-parity-contract';

type ImportBindings = {
  named: Map<string, string>;
  namespaces: Set<string>;
};

type LocalOrigins = {
  factories: Map<string, string>;
  instances: Map<string, string>;
};

type InvocationOccurrence = {
  execution: CompositionInvocationExecution;
  identity: string;
  location: string;
  via?: Extract<CompositionRootContractEntry, { kind: 'construction' }>['via'];
};

const startupDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.dirname(startupDirectory);
const wiringDirectory = path.join(backendDirectory, 'wiring');

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listProductionTypeScriptFiles(entryPath);
      if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
        return [];
      }
      return [entryPath];
    })
    .sort();
}

const compositionSourceFiles = [
  path.join(backendDirectory, 'main.ts'),
  ...listProductionTypeScriptFiles(startupDirectory),
  ...listProductionTypeScriptFiles(wiringDirectory),
];

function collectImportBindings(sourceFile: ts.SourceFile): ImportBindings {
  const bindings: ImportBindings = {
    named: new Map(),
    namespaces: new Set(),
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings) continue;

    if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.named.set(
          element.name.text,
          element.propertyName?.text ?? element.name.text,
        );
      }
      continue;
    }

    bindings.namespaces.add(namedBindings.name.text);
  }

  return bindings;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function canonicalEntityName(
  expression: ts.Expression,
  bindings: ImportBindings,
): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return bindings.named.get(current.text) ?? current.text;
  }
  if (!ts.isPropertyAccessExpression(current)) return undefined;

  const receiver = unwrapExpression(current.expression);
  if (ts.isIdentifier(receiver) && bindings.namespaces.has(receiver.text)) {
    return current.name.text;
  }
  const receiverName = canonicalEntityName(receiver, bindings);
  return receiverName ? `${receiverName}.${current.name.text}` : undefined;
}

function canonicalCallableName(
  expression: ts.LeftHandSideExpression,
  bindings: ImportBindings,
): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return bindings.named.get(current.text) ?? current.text;
  }
  if (!ts.isPropertyAccessExpression(current)) return undefined;

  const receiver = unwrapExpression(current.expression);
  if (ts.isIdentifier(receiver) && bindings.namespaces.has(receiver.text)) {
    return current.name.text;
  }
  return undefined;
}

function canonicalTypeName(
  typeNode: ts.TypeNode | undefined,
  bindings: ImportBindings,
): string | undefined {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
  if (ts.isIdentifier(typeNode.typeName)) {
    return bindings.named.get(typeNode.typeName.text) ?? typeNode.typeName.text;
  }
  const left = typeNode.typeName.left;
  if (ts.isIdentifier(left) && bindings.namespaces.has(left.text)) {
    return typeNode.typeName.right.text;
  }
  return undefined;
}

function staticCreateOwner(
  expression: ts.Expression,
  bindings: ImportBindings,
): string | undefined {
  const current = unwrapExpression(expression);
  if (
    !ts.isCallExpression(current) ||
    !ts.isPropertyAccessExpression(current.expression) ||
    current.expression.name.text !== 'create'
  ) {
    return undefined;
  }
  return canonicalEntityName(current.expression.expression, bindings);
}

function factoryCallTarget(
  expression: ts.Expression,
  bindings: ImportBindings,
): string | undefined {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return undefined;
  return canonicalCallableName(current.expression, bindings);
}

function collectLocalOrigins(
  sourceFile: ts.SourceFile,
  bindings: ImportBindings,
): LocalOrigins {
  const origins: LocalOrigins = {
    factories: new Map(),
    instances: new Map(),
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const typeName = canonicalTypeName(node.type, bindings);
      if (typeName) origins.instances.set(node.name.text, typeName);

      if (node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isNewExpression(initializer)) {
          const owner = canonicalEntityName(initializer.expression, bindings);
          if (owner) origins.instances.set(node.name.text, owner);
        } else {
          const owner = staticCreateOwner(initializer, bindings);
          if (owner) origins.instances.set(node.name.text, owner);

          const factoryTarget = factoryCallTarget(initializer, bindings);
          if (factoryTarget) {
            origins.factories.set(node.name.text, factoryTarget);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return origins;
}

function resolveInstanceOwner(
  expression: ts.Expression,
  bindings: ImportBindings,
  origins: LocalOrigins,
): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return origins.instances.get(current.text);
  if (ts.isNewExpression(current)) {
    return canonicalEntityName(current.expression, bindings);
  }
  return undefined;
}

function resolveRegisteredFactory(
  expression: ts.Expression | undefined,
  bindings: ImportBindings,
  origins: LocalOrigins,
): string | undefined {
  if (!expression) return undefined;
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return origins.factories.get(current.text);
  return factoryCallTarget(current, bindings);
}

function isTransparentInvocationParent(
  parent: ts.Node,
  child: ts.Node,
): boolean {
  return (
    ((ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
      parent.expression === child) ||
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
      parent.expression === child) ||
    (ts.isCallExpression(parent) && parent.expression === child)
  );
}

function getInvocationExecution(node: ts.CallExpression | ts.NewExpression) {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isAwaitExpression(parent)) return 'awaited' as const;
    if (ts.isVoidExpression(parent)) return 'void' as const;
    if (!isTransparentInvocationParent(parent, current)) break;
    current = parent;
  }
  return 'sync' as const;
}

function contractIdentity(entry: CompositionRootContractEntry): string {
  switch (entry.kind) {
    case 'construction':
      return `construction:${entry.target}`;
    case 'factory':
      return `factory:${entry.target}`;
    case 'registered-factory':
      return `registered-factory:${entry.registration}:${entry.target}`;
    case 'method-registration':
      return `method-registration:${entry.method}`;
    case 'instance-method':
      return `instance-method:${entry.owner}:${entry.method}`;
    case 'procedure-registration':
      return `procedure-registration:${entry.method}:${entry.procedure}`;
  }
}

function scanCompositionFile(filePath: string): InvocationOccurrence[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = collectImportBindings(sourceFile);
  const origins = collectLocalOrigins(sourceFile, bindings);
  const occurrences: InvocationOccurrence[] = [];

  const record = (
    identity: string,
    node: ts.CallExpression | ts.NewExpression,
    via?: Extract<
      CompositionRootContractEntry,
      { kind: 'construction' }
    >['via'],
  ): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    occurrences.push({
      identity,
      execution: getInvocationExecution(node),
      location: `${path.relative(backendDirectory, filePath)}:${line + 1}`,
      via,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const owner = canonicalEntityName(node.expression, bindings);
      if (owner) record(`construction:${owner}`, node, 'constructor');
    }

    if (ts.isCallExpression(node)) {
      const callable = canonicalCallableName(node.expression, bindings);
      if (callable) record(`factory:${callable}`, node);

      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;

        if (method === 'create') {
          const owner = canonicalEntityName(receiver, bindings);
          if (owner) record(`construction:${owner}`, node, 'static-create');
        }

        if (method === 'registerEnvAdapter') {
          const factoryTarget = resolveRegisteredFactory(
            node.arguments[0],
            bindings,
            origins,
          );
          if (factoryTarget) {
            record(
              `registered-factory:registerEnvAdapter:${factoryTarget}`,
              node,
            );
          }
        }

        if (method === 'setSwarmSubmitHandler') {
          record('method-registration:setSwarmSubmitHandler', node);
        }

        if (method === 'registerServerProcedureHandler') {
          const procedure = node.arguments[0];
          if (procedure && ts.isStringLiteralLike(procedure)) {
            record(
              `procedure-registration:registerServerProcedureHandler:${procedure.text}`,
              node,
            );
          }
        }

        const owner = resolveInstanceOwner(receiver, bindings, origins);
        if (owner) record(`instance-method:${owner}:${method}`, node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return occurrences;
}

const occurrences = compositionSourceFiles.flatMap(scanCompositionFile);
const contractGroups = Object.keys(
  COMPOSITION_ROOT_PARITY_CONTRACT,
) as CompositionRootContractGroup[];

describe('Composition Root Phase 2 parity contract', () => {
  it('keeps every normalized contract target unique', () => {
    const identities = contractGroups.flatMap((group) =>
      COMPOSITION_ROOT_PARITY_CONTRACT[group].map(contractIdentity),
    );
    const duplicateIdentities = identities.filter(
      (identity, index) => identities.indexOf(identity) !== index,
    );

    expect(duplicateIdentities).toEqual([]);
  });

  for (const group of contractGroups) {
    it(`keeps ${group} composition invocations exactly once`, () => {
      const mismatches = COMPOSITION_ROOT_PARITY_CONTRACT[group]
        .map((entry) => {
          const identity = contractIdentity(entry);
          const matches = occurrences.filter(
            (occurrence) => occurrence.identity === identity,
          );
          const hasExpectedExecution = matches.every(
            (match) => match.execution === entry.execution,
          );
          const expectedVia =
            entry.kind === 'construction' ? entry.via : undefined;
          const hasExpectedVia = matches.every(
            (match) => match.via === expectedVia,
          );
          if (
            matches.length === entry.expectedCount &&
            hasExpectedExecution &&
            hasExpectedVia
          ) {
            return null;
          }
          return {
            identity,
            expected: {
              count: entry.expectedCount,
              execution: entry.execution,
              via: expectedVia,
            },
            actual: matches.map(({ execution, location, via }) => ({
              execution,
              location,
              via,
            })),
          };
        })
        .filter((mismatch) => mismatch !== null);

      expect(mismatches).toEqual([]);
    });
  }
});
