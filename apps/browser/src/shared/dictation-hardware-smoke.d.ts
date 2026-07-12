export const DICTATION_SMOKE_SCHEMA_VERSION: 2;
export const DICTATION_SMOKE_MIME_TYPES: readonly string[];

export type DictationSmokeMode = 'hardware' | 'capabilities';
export type DictationSmokePlatform = 'darwin' | 'linux' | 'win32';

export function normalizeSmokePlatform(
  value: unknown,
): DictationSmokePlatform | null;

export function parseDictationSmokeCli(args: string[]): {
  mode: DictationSmokeMode;
  expectedPlatform: DictationSmokePlatform | null;
  outputPath: string | null;
};

export function fixedSmokeFailureReason(
  error: {
    name?: string;
  } | null,
): string;

export function isRecorderMimePolicySatisfied(
  platform: string,
  recorderMimeTypes: Record<string, boolean>,
): boolean;

export function createDictationSmokeReport(input: Record<string, unknown>): {
  schemaVersion: 2;
  rendererPlatform: string | null;
  verdict: {
    passed: boolean;
    failureReasons: string[];
  };
  [key: string]: unknown;
};
