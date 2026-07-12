import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  RunnerPairedReplayProfile,
  RunnerRoutingPromotionProgress,
} from '@clodex/agent-core/runner-routing';
import type { RunnerRoutingShadowLedger } from './shadow-ledger';
import type { RunnerDogfoodDiagnosticsReport } from './shadow-ledger';

const MAX_BUNDLE_FILES = 100;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export interface RunnerDogfoodIngestionReport {
  scannedFiles: number;
  acceptedFiles: number;
  rejectedFiles: number;
  importedSamples: number;
  duplicateSamples: number;
  profileProgress: RunnerRoutingPromotionProgress[];
  diagnostics: RunnerDogfoodDiagnosticsReport;
}

export async function ingestRunnerDogfoodEvidenceDirectory(input: {
  directory: string;
  trustedCollectorPublicKeys: readonly string[];
  ledger: RunnerRoutingShadowLedger;
}): Promise<RunnerDogfoodIngestionReport> {
  if (input.trustedCollectorPublicKeys.length === 0) {
    throw new Error('At least one trusted dogfood collector key is required');
  }
  const entries = (await fs.readdir(input.directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_BUNDLE_FILES);
  let acceptedFiles = 0;
  let rejectedFiles = 0;
  let importedSamples = 0;
  let duplicateSamples = 0;
  const profiles = new Set<RunnerPairedReplayProfile>();

  for (const entry of entries) {
    try {
      const filePath = path.join(input.directory, entry.name);
      const stats = await fs.stat(filePath);
      if (stats.size <= 0 || stats.size > MAX_BUNDLE_BYTES) {
        throw new Error('Dogfood evidence bundle size is invalid');
      }
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const result = await input.ledger.ingestDogfoodEvidence(
        parsed,
        input.trustedCollectorPublicKeys,
      );
      acceptedFiles += 1;
      importedSamples += result.importedSamples;
      duplicateSamples += result.duplicateSamples;
      for (const profile of result.profiles) profiles.add(profile);
    } catch {
      rejectedFiles += 1;
    }
  }

  const profileProgress = await Promise.all(
    [...profiles]
      .sort()
      .map((replayProfile) =>
        input.ledger.evaluatePromotionProgress({ replayProfile }),
      ),
  );
  const diagnostics = await input.ledger.evaluateDogfoodDiagnostics();
  return {
    scannedFiles: entries.length,
    acceptedFiles,
    rejectedFiles,
    importedSamples,
    duplicateSamples,
    profileProgress,
    diagnostics,
  };
}

export function parseTrustedRunnerDogfoodCollectorKeys(
  value: string | undefined,
): string[] {
  if (!value?.trim()) return [];
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (
    keys.some(
      (key) =>
        key.length < 16 || key.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(key),
    )
  ) {
    throw new Error('Trusted dogfood collector keys must be base64url values');
  }
  return [...new Set(keys)];
}
