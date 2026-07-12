import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEvidenceMemoryQualityFixture,
  evaluateEvidenceMemoryQuality,
  toEvidenceMemoryQualityReceipt,
} from '../../../packages/agent-core/src/services/evidence-memory/evaluation';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = path.resolve(
  scriptDirectory,
  '../test-results/evidence-memory-quality.json',
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
    'EVIDENCE_MEMORY_QUALITY ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function runEvaluation(options: EvaluationOptions): Promise<void> {
  const observations = createEvidenceMemoryQualityFixture(options.size);
  const report = evaluateEvidenceMemoryQuality(observations);
  const receipt = toEvidenceMemoryQualityReceipt(report);
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  if (options.write) {
    await writeJsonAtomically(outputPath, {
      format: 'clodex-evidence-memory-quality',
      version: 1,
      generatedAt: new Date().toISOString(),
      fixtureSize: options.size,
      report: receipt,
    });
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...receipt,
          outputPath: options.write ? outputPath : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      [
        'EVIDENCE_MEMORY_QUALITY',
        `ready=${report.promotionReady}`,
        `observations=${report.observationCount}`,
        `recall=${formatRate(report.factRecall)}`,
        `staleRate=${formatRate(report.staleMemoryRate)}`,
        `convergence=${formatRate(report.convergenceRate)}`,
        `falseAutoMerge=${formatRate(report.falseAutoMergeRate)}`,
        `tokenSavings=${formatNullableRate(report.tokenSavingsRatio)}`,
        `blockers=${report.promotionBlockers.join(',') || 'none'}`,
        `output=${options.write ? outputPath : 'not-written'}`,
        `exit=${report.promotionReady ? 0 : 1}`,
      ].join(' '),
    );
  }
  if (!report.promotionReady) process.exitCode = 1;
}

type EvaluationOptions = {
  size: 100 | 500 | 1_000;
  outputPath?: string;
  json: boolean;
  write: boolean;
  help: boolean;
};

function parseArguments(args: string[]): EvaluationOptions {
  const options: EvaluationOptions = {
    size: 1_000,
    json: false,
    write: true,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--size': {
        const value = Number(args[index + 1]);
        if (value !== 100 && value !== 500 && value !== 1_000) {
          throw new Error('--size must be 100, 500, or 1000');
        }
        options.size = value;
        index += 1;
        break;
      }
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

function formatRate(value: number): string {
  return value.toFixed(6);
}

function formatNullableRate(value: number | null): string {
  return value === null ? 'unmeasurable' : formatRate(value);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm eval:evidence-memory-quality
  pnpm eval:evidence-memory-quality -- --size 100
  pnpm eval:evidence-memory-quality -- --json --no-write

Runs deterministic recall, stale-memory, convergence, false-auto-merge, and
token-savings promotion checks. The command exits non-zero when any threshold
fails.`);
}
