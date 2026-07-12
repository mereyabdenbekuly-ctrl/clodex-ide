import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateAgenticAppRuntimeReadiness,
  parseAgenticAppRuntimeEvaluationEvidence,
} from '../src/shared/agentic-app-runtime-evaluation';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultEvidencePath = path.resolve(
  scriptDirectory,
  '../test-results/agentic-app-runtime-evaluation.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    checkEvidence(options);
  }
} catch (error) {
  console.error(
    'AGENTIC_APP_RUNTIME_RELEASE_GATE ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

function checkEvidence(options: CheckOptions): void {
  const evidencePath = path.resolve(
    options.evidencePath ?? defaultEvidencePath,
  );
  if (!fs.existsSync(evidencePath)) {
    throw new Error(
      `evaluation evidence is missing at ${evidencePath}; run pnpm eval:agentic-app-runtime first`,
    );
  }
  const evidence = parseAgenticAppRuntimeEvaluationEvidence(
    JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
  );
  const readiness = evaluateAgenticAppRuntimeReadiness(evidence);

  if (options.json) {
    console.log(
      JSON.stringify({ ...readiness, evidencePath, evidence }, null, 2),
    );
  } else {
    for (const item of readiness.checks) {
      console.log(
        `${item.passed ? 'PASS' : 'FAIL'} ${item.id} actual=${formatValue(item.actual)} required=${formatValue(item.required)}`,
      );
    }
    console.log(
      `AGENTIC_APP_RUNTIME_RELEASE_GATE ready=${readiness.ready} evidence=${evidencePath} exit=${readiness.ready ? 0 : 1}`,
    );
  }
  if (!readiness.ready) process.exitCode = 1;
}

type CheckOptions = {
  evidencePath?: string;
  json: boolean;
  help: boolean;
};

function parseArguments(args: string[]): CheckOptions {
  const options: CheckOptions = { json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--evidence': {
        const value = args[index + 1];
        if (!value) throw new Error('--evidence requires a file path');
        options.evidencePath = value;
        index += 1;
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  return JSON.stringify(value);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm check:agentic-app-runtime-evaluation
  pnpm check:agentic-app-runtime-evaluation -- --evidence <file>
  pnpm check:agentic-app-runtime-evaluation -- --json

Strictly parses fresh evaluation evidence and fails the release gate when any
scenario, zero-tolerance security rate, content-free audit, package revocation,
or grant-revoke latency threshold fails.`);
}
