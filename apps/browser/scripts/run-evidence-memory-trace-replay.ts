import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEvidenceMemoryTraceReplayFixture,
  evaluateEvidenceMemoryTraceReplay,
  toEvidenceMemoryTraceReplayReceipt,
} from '../../../packages/agent-core/src/services/evidence-memory/trace-replay';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = path.resolve(
  scriptDirectory,
  '../test-results/evidence-memory-trace-replay.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    await runReplay(options);
  }
} catch (error) {
  console.error(
    'EVIDENCE_MEMORY_TRACE_REPLAY ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function runReplay(options: ReplayOptions): Promise<void> {
  const input = options.inputPath
    ? await readTraceInput(path.resolve(options.inputPath))
    : createEvidenceMemoryTraceReplayFixture();
  const report = evaluateEvidenceMemoryTraceReplay(input, {}, Date.now(), {
    requireObservedAt: options.inputPath !== undefined,
  });
  const receipt = toEvidenceMemoryTraceReplayReceipt(report);
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);

  if (options.write) {
    await writeJsonAtomically(outputPath, {
      format: 'clodex-evidence-memory-trace-replay-report',
      version: 1,
      generatedAt: new Date().toISOString(),
      source: options.inputPath ? 'external-content-free-trace' : 'fixture',
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
        'EVIDENCE_MEMORY_TRACE_REPLAY',
        `ready=${report.promotionReady}`,
        `observations=${report.replayedObservationCount}`,
        `tasks=${report.distinctTaskCount}`,
        `guardedRecall=${formatRate(report.guardedMemoryRecall)}`,
        `recallLift=${formatRate(report.recallLift)}`,
        `staleRate=${formatRate(report.guardedMemoryStaleLeakageRate)}`,
        `tokenOverhead=${formatNullableRate(report.tokenOverheadRatio)}`,
        `invalid=${report.invalidObservationCount}`,
        `duplicates=${report.duplicateObservationCount}`,
        `missingTimestamps=${report.missingObservedAtCount}`,
        `blockers=${report.promotionBlockers.join(',') || 'none'}`,
        `output=${options.write ? outputPath : 'not-written'}`,
        `exit=${report.promotionReady ? 0 : 1}`,
      ].join(' '),
    );
  }
  if (!report.promotionReady) process.exitCode = 1;
}

type ReplayOptions = {
  inputPath?: string;
  outputPath?: string;
  json: boolean;
  write: boolean;
  help: boolean;
};

function parseArguments(args: string[]): ReplayOptions {
  const options: ReplayOptions = {
    json: false,
    write: true,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--input': {
        const value = args[index + 1];
        if (!value) throw new Error('--input requires a file path');
        options.inputPath = value;
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

async function readTraceInput(inputPath: string): Promise<unknown> {
  const raw = await fs.readFile(inputPath, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const observations: unknown[] = [];
    for (const [index, line] of raw.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        observations.push(JSON.parse(line) as unknown);
      } catch {
        throw new Error(`invalid JSONL at line ${index + 1}`);
      }
    }
    return observations;
  }
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
  pnpm eval:evidence-memory-trace-replay
  pnpm eval:evidence-memory-trace-replay -- --input observations.jsonl
  pnpm eval:evidence-memory-trace-replay -- --json --no-write

Replays content-free paired compressed-history/Evidence Memory observations.
JSON bundles and one-observation-per-line JSONL are accepted. Duplicate or
invalid observations fail the promotion gate.`);
}
