import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgenticAppRuntimeEvaluationSuite } from '../src/backend/services/artifact-bridge/evaluation-suite';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = path.resolve(
  scriptDirectory,
  '../test-results/agentic-app-runtime-evaluation.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    await runEvaluation(options);
  }
} catch (error) {
  console.error(
    'AGENTIC_APP_RUNTIME_EVALUATION ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function runEvaluation(options: EvaluationOptions): Promise<void> {
  const { evidence, readiness } = await runAgenticAppRuntimeEvaluationSuite();
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  if (options.write) await writeJsonAtomically(outputPath, evidence);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...readiness,
          evidence,
          outputPath: options.write ? outputPath : null,
        },
        null,
        2,
      ),
    );
  } else {
    printReadiness(readiness);
    console.log(
      [
        'AGENTIC_APP_RUNTIME_EVALUATION',
        `ready=${readiness.ready}`,
        `scenarios=${evidence.scenarios.length}`,
        `replayViolations=${evidence.metrics.replay.violations}`,
        `isolationViolations=${evidence.metrics.crossPrincipalIsolation.violations}`,
        `secretLeaks=${evidence.metrics.secretEgress.violations}`,
        `trustBypasses=${evidence.metrics.packageTrust.violations}`,
        `revokeP95Ms=${formatValue(evidence.metrics.grantRevokeLatency.p95Ms)}`,
        `output=${options.write ? outputPath : 'not-written'}`,
        `exit=${readiness.ready ? 0 : 1}`,
      ].join(' '),
    );
  }

  if (!readiness.ready) process.exitCode = 1;
}

type EvaluationOptions = {
  outputPath?: string;
  json: boolean;
  write: boolean;
  help: boolean;
};

function parseArguments(args: string[]): EvaluationOptions {
  const options: EvaluationOptions = {
    json: false,
    write: true,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--output': {
        const value = args[index + 1];
        if (!value) throw new Error('--output requires a file path');
        options.outputPath = value;
        index += 1;
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--no-write':
        options.write = false;
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

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, outputPath);
}

function printReadiness(
  readiness: Awaited<
    ReturnType<typeof runAgenticAppRuntimeEvaluationSuite>
  >['readiness'],
): void {
  for (const item of readiness.checks) {
    console.log(
      `${item.passed ? 'PASS' : 'FAIL'} ${item.id} actual=${formatValue(item.actual)} required=${formatValue(item.required)}`,
    );
  }
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  return JSON.stringify(value);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm eval:agentic-app-runtime
  pnpm eval:agentic-app-runtime -- --output <file>
  pnpm eval:agentic-app-runtime -- --json --no-write

Runs deterministic replay, isolation, revocation-latency, credential-egress,
package-trust and Runtime Inspector content-free scenarios. The command exits
non-zero when any release threshold fails.`);
}
