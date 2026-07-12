import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgenticAppRuntimeEvaluationEvidence } from '../src/shared/agentic-app-runtime-evaluation';
import {
  evaluateAgenticAppRuntimePromotionReadiness,
  parseAgenticAppRuntimePromotionEvidence,
} from '../src/shared/agentic-app-runtime-promotion';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultEvidencePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'agentic-app-runtime.json',
);
const defaultEvaluationPath = path.resolve(
  repositoryRoot,
  '.release-evidence/agentic-app-runtime-evaluation.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    runCheck(options);
  }
} catch (error) {
  console.error(
    'AGENTIC_APP_RUNTIME_PROMOTION ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

function runCheck(options: CheckOptions): void {
  const evidencePath = path.resolve(
    options.evidencePath ?? defaultEvidencePath,
  );
  const evidenceExists = fs.existsSync(evidencePath);
  if (!evidenceExists) {
    if (options.requireEvidence) {
      throw new Error(`promotion evidence is missing at ${evidencePath}`);
    }
    printAbsentEvidence(options, evidencePath);
    return;
  }

  const evaluationPath = path.resolve(
    options.evaluationPath ?? defaultEvaluationPath,
  );
  if (!fs.existsSync(evaluationPath)) {
    throw new Error(
      `linked deterministic evaluation evidence is missing at ${evaluationPath}`,
    );
  }

  const evidence = parseAgenticAppRuntimePromotionEvidence(
    JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
  );
  const evaluationBytes = fs.readFileSync(evaluationPath);
  const evaluationEvidence = parseAgenticAppRuntimeEvaluationEvidence(
    JSON.parse(evaluationBytes.toString('utf8')),
  );
  const evaluationSha256 = createHash('sha256')
    .update(evaluationBytes)
    .digest('hex');
  const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
    evaluationEvidence,
    evaluationSha256,
    buildCommitSha: resolveBuildCommitSha(options),
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...readiness,
          evidencePath,
          evaluationPath,
          evidence,
        },
        null,
        2,
      ),
    );
  } else {
    for (const item of readiness.checks) {
      console.log(
        `${item.passed ? 'PASS' : 'FAIL'} ${item.id} actual=${formatValue(item.actual)} required=${formatValue(item.required)}`,
      );
    }
    console.log(
      `AGENTIC_APP_RUNTIME_PROMOTION ready=${readiness.ready} evidence=${evidencePath} evaluation=${evaluationPath} exit=${readiness.ready ? 0 : 1}`,
    );
  }
  if (!readiness.ready) process.exitCode = 1;
}

type CheckOptions = {
  evidencePath?: string;
  evaluationPath?: string;
  buildCommitSha?: string;
  requireEvidence: boolean;
  json: boolean;
  help: boolean;
};

function parseArguments(args: string[]): CheckOptions {
  const options: CheckOptions = {
    requireEvidence: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--evidence':
        options.evidencePath = readArgumentValue(args, ++index, '--evidence');
        break;
      case '--evaluation-evidence':
        options.evaluationPath = readArgumentValue(
          args,
          ++index,
          '--evaluation-evidence',
        );
        break;
      case '--build-commit':
      case '--commit':
        options.buildCommitSha = readArgumentValue(args, ++index, argument);
        break;
      case '--require-evidence':
        options.requireEvidence = true;
        break;
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

function resolveBuildCommitSha(options: CheckOptions): string {
  const commitSha =
    options.buildCommitSha ??
    process.env.CLODEX_BUILD_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    tryGitCommit();
  if (!commitSha || !/^[a-f0-9]{40,64}$/u.test(commitSha)) {
    throw new Error('promotion evidence requires a valid build commit SHA');
  }
  return commitSha;
}

function tryGitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function readArgumentValue(
  args: string[],
  index: number,
  argument: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${argument} requires a value`);
  return value;
}

function printAbsentEvidence(
  options: CheckOptions,
  evidencePath: string,
): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ready: false,
          evidenceRequired: false,
          evidencePath,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `AGENTIC_APP_RUNTIME_PROMOTION ready=false evidence=not-required path=${evidencePath} exit=0`,
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
  pnpm check:agentic-app-runtime-promotion
  pnpm check:agentic-app-runtime-promotion -- --require-evidence
  pnpm check:agentic-app-runtime-promotion -- \\
    --evidence <promotion.json> \\
    --evaluation-evidence <evaluation.json> \\
    --build-commit <exact-build-sha> \\
    --json

Without promotion evidence the default CI/release check reports "not ready" but
passes while rollout remains gated. Promotion operators must use
--require-evidence. Existing evidence always fails closed when stale,
insufficient, malformed, or no longer linked to the exact deterministic run.`);
}
