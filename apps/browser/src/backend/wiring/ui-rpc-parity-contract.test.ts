import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXPECTED_UI_RPC_PROCEDURE_NAMES } from './ui-rpc-parity-contract';

type Registration = {
  name: string;
  location: string;
};

const wiringDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.dirname(wiringDirectory);

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listProductionTypeScriptFiles(entryPath);
      if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
      if (entry.name.endsWith('.test.ts')) return [];
      return [entryPath];
    })
    .sort();
}

function scanRegistrations(filePath: string): Registration[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const registrations: Registration[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerServerProcedureHandler'
    ) {
      const procedureName = node.arguments[0];
      if (!procedureName || !ts.isStringLiteralLike(procedureName)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `${path.relative(backendDirectory, filePath)}:${line + 1}:${character + 1} must register a static procedure name`,
        );
      }
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        procedureName.getStart(sourceFile),
      );
      registrations.push({
        name: procedureName.text,
        location: `${path.relative(backendDirectory, filePath)}:${line + 1}`,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return registrations;
}

describe('UI RPC parity contract', () => {
  it('keeps every expected procedure registered exactly once', () => {
    const expectedNames = Object.values(EXPECTED_UI_RPC_PROCEDURE_NAMES).flat();
    expect(new Set(expectedNames).size).toBe(expectedNames.length);

    const sourceFiles = [
      path.join(backendDirectory, 'main.ts'),
      ...listProductionTypeScriptFiles(wiringDirectory),
    ];
    const registrations = sourceFiles.flatMap(scanRegistrations);
    const registrationsByName = new Map<string, Registration[]>();
    for (const registration of registrations) {
      const matches = registrationsByName.get(registration.name) ?? [];
      matches.push(registration);
      registrationsByName.set(registration.name, matches);
    }
    const duplicates = [...registrationsByName]
      .filter(([, matches]) => matches.length > 1)
      .map(([name, matches]) => ({
        name,
        locations: matches.map((match) => match.location),
      }));
    expect(duplicates).toEqual([]);

    const expectedRegistrationCounts = Object.fromEntries(
      expectedNames.map((name) => [name, 1]),
    );
    const actualRegistrationCounts = Object.fromEntries(
      expectedNames.map((name) => [
        name,
        registrationsByName.get(name)?.length ?? 0,
      ]),
    );
    expect(actualRegistrationCounts).toEqual(expectedRegistrationCounts);
  });
});
