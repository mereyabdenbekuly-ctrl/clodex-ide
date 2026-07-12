import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateIsolatedAgentRuntimePromotionReadiness,
  isStablePromotionPolicyArmed,
  parseIsolatedAgentRuntimePromotionEvidence,
} from '../src/shared/isolated-agent-runtime-promotion';
import { getIsolatedAgentRuntimeRolloutPolicy } from '../src/shared/isolated-agent-runtime-policy';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultEvidencePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'isolated-agent-runtime.json',
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
    'ISOLATED_AGENT_RUNTIME_PROMOTION ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

function runCheck(options: {
  evidencePath?: string;
  json: boolean;
  help: boolean;
}): void {
  const releasePolicy = getIsolatedAgentRuntimeRolloutPolicy('release');
  const evidencePath = path.resolve(
    options.evidencePath ?? defaultEvidencePath,
  );
  const evidenceExists = fs.existsSync(evidencePath);

  if (releasePolicy.defaultEnabled && releasePolicy.rolloutStage !== 'canary') {
    throw new Error(
      'stable default-on requires rolloutStage="canary" during promotion',
    );
  }
  if (
    !releasePolicy.defaultEnabled &&
    releasePolicy.rolloutStage === 'canary'
  ) {
    throw new Error(
      'stable default-off cannot use rolloutStage="canary"; use "next" or "hold"',
    );
  }

  if (!evidenceExists) {
    if (releasePolicy.defaultEnabled) {
      throw new Error(
        `stable default-on requires promotion evidence at ${evidencePath}`,
      );
    }
    if (options.json) {
      const armed = isStablePromotionPolicyArmed(releasePolicy);
      console.log(
        JSON.stringify(
          {
            ready: false,
            armed,
            stableDefaultEnabled: false,
            rolloutStage: releasePolicy.rolloutStage,
            evidencePath,
            evidenceRequired: false,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `ISOLATED_AGENT_RUNTIME_PROMOTION ready=false armed=${isStablePromotionPolicyArmed(releasePolicy)} stableDefaultEnabled=false stage=${releasePolicy.rolloutStage} evidence=not-required exit=0`,
      );
    }
    return;
  }

  const evidence = parseIsolatedAgentRuntimePromotionEvidence(
    JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
  );
  const readiness = evaluateIsolatedAgentRuntimePromotionReadiness(evidence);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...readiness,
          armed: isStablePromotionPolicyArmed(releasePolicy),
          stableDefaultEnabled: releasePolicy.defaultEnabled,
          rolloutStage: releasePolicy.rolloutStage,
          evidencePath,
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
      `ISOLATED_AGENT_RUNTIME_PROMOTION ready=${readiness.ready} armed=${isStablePromotionPolicyArmed(releasePolicy)} stableDefaultEnabled=${releasePolicy.defaultEnabled} stage=${releasePolicy.rolloutStage} evidence=${evidencePath} exit=${readiness.ready ? 0 : 1}`,
    );
  }

  if (!readiness.ready) process.exitCode = 1;
}

function parseArguments(args: string[]): {
  evidencePath?: string;
  json: boolean;
  help: boolean;
} {
  let evidencePath: string | undefined;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--evidence': {
        const value = args[index + 1];
        if (!value) throw new Error('--evidence requires a file path');
        evidencePath = value;
        index += 1;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }

  return {
    evidencePath,
    json,
    help,
  };
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  return JSON.stringify(value);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm check:isolated-agent-runtime-promotion
  pnpm check:isolated-agent-runtime-promotion -- --evidence <file>
  pnpm check:isolated-agent-runtime-promotion -- --evidence <file> --json

Without an evidence file, the command passes only while stable remains
default-off ("next" while preparing promotion, or "hold" after rollback). Once
stable is switched default-on, valid aggregate prerelease evidence becomes
mandatory.`);
}
