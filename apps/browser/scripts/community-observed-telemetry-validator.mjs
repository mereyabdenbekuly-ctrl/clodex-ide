import { extractFile, listPackage, statFile } from '@electron/asar';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export const COMMUNITY_OBSERVED_TELEMETRY_CONTRACT =
  'clodex-community-observed-backend-anonymous-v1';
export const COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION =
  'clodex-community-observed-contract:{"allowedTelemetryLevel":"anonymous","contentPolicy":"event-field-allowlist-v1","disableGeoip":true,"exceptions":"disabled","modelTracing":"disabled","optIn":"explicit","privacyMode":true,"renderer":"noop"}';
export const COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP =
  'clodex-community-observed-renderer-posthog-noop-v1';

const PROJECT_KEY_PATTERN = /phc_[A-Za-z0-9_-]{20,}/gu;
const JAVASCRIPT_OR_HTML_PATTERN = /\.(?:c?js|mjs|html)$/u;

export function normalizeCommunityObservedArchivePath(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function readArchiveText(asarPath, archivePath) {
  return extractFile(
    asarPath,
    normalizeCommunityObservedArchivePath(archivePath),
  ).toString('utf8');
}

function importedRelativePaths(source) {
  const imports = new Set();
  // Resolution against actual archive entries below keeps this deliberately
  // broad parser safe while covering side-effect, static and dynamic imports.
  const pattern = /["'](\.\.?\/[^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) imports.add(match[1]);
  return imports;
}

function resolveBackendClosure(entries, sources) {
  const mainEntry = '.vite/build/main.js';
  if (!entries.has(mainEntry)) {
    throw new Error(
      'community-observed package has no .vite/build/main.js backend entry',
    );
  }
  const closure = new Set();
  const queue = [mainEntry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || closure.has(current)) continue;
    closure.add(current);
    const source = sources.get(current);
    if (source === undefined) continue;
    for (const imported of importedRelativePaths(source)) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(current), imported),
      );
      if (entries.has(resolved) && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function projectKeys(source) {
  return new Set(source.match(PROJECT_KEY_PATTERN) ?? []);
}

function regularArchiveEntries(asarPath) {
  return listPackage(asarPath)
    .map(normalizeCommunityObservedArchivePath)
    .filter(
      (entry) =>
        entry.startsWith('.vite/build/') || entry.startsWith('.vite/renderer/'),
    )
    .filter((entry) => {
      const metadata = statFile(asarPath, entry, false);
      return Number.isSafeInteger(metadata.size) && metadata.unpacked !== true;
    });
}

function assertNoProjectKeyInUnpackedResources(asarPath) {
  const unpackedRoot = `${asarPath}.unpacked`;
  if (!existsSync(unpackedRoot)) return;

  const queue = [unpackedRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `community-observed unpacked resource must not be a symlink: ${current}`,
      );
    }
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(current)) {
        queue.push(path.join(current, entry));
      }
      continue;
    }
    if (
      metadata.isFile() &&
      projectKeys(readFileSync(current).toString('latin1')).size > 0
    ) {
      throw new Error(
        `community-observed PostHog project key escaped into app.asar.unpacked: ${current}`,
      );
    }
  }
}

function containsJavaScriptString(source, value) {
  return (
    source.includes(value) ||
    source.includes(JSON.stringify(value).slice(1, -1))
  );
}

export function inspectCommunityObservedTelemetryAsar(asarPath) {
  if (!existsSync(asarPath) || !statSync(asarPath).isFile()) {
    throw new Error(`community-observed app.asar is missing: ${asarPath}`);
  }

  const regularEntries = regularArchiveEntries(asarPath);
  const archiveEntries = regularEntries.filter((entry) =>
    JAVASCRIPT_OR_HTML_PATTERN.test(entry),
  );
  const entries = new Set(archiveEntries);
  const sources = new Map(
    archiveEntries.map((entry) => [entry, readArchiveText(asarPath, entry)]),
  );
  const backendClosure = resolveBackendClosure(entries, sources);
  const backendSource = [...backendClosure]
    .map((entry) => sources.get(entry) ?? '')
    .join('\n');
  const backendProjectKeys = projectKeys(backendSource);
  if (backendProjectKeys.size !== 1) {
    throw new Error(
      `community-observed backend must embed exactly one PostHog project key; found ${backendProjectKeys.size}`,
    );
  }

  const rendererEntries = archiveEntries.filter((entry) =>
    entry.startsWith('.vite/renderer/'),
  );
  const rendererSource = rendererEntries
    .map((entry) => sources.get(entry) ?? '')
    .join('\n');
  for (const entry of regularEntries) {
    if (backendClosure.has(entry)) continue;
    const source = sources.get(entry) ?? readArchiveText(asarPath, entry);
    if (projectKeys(source).size > 0) {
      throw new Error(
        `community-observed PostHog project key escaped the backend entry graph: ${entry}`,
      );
    }
  }
  assertNoProjectKeyInUnpackedResources(asarPath);

  if (
    !containsJavaScriptString(
      backendSource,
      COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
    )
  ) {
    throw new Error(
      'community-observed backend is missing the canonical telemetry contract assertion',
    );
  }
  if (!rendererSource.includes(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)) {
    throw new Error(
      'community-observed renderer is missing the compile-time PostHog no-op assertion',
    );
  }
  for (const [label, pattern] of [
    ['posthog.init', /\bposthog\s*\.\s*init\s*\(/iu],
    ['autocapture enabled', /autocapture\s*:\s*(?:true|!0)\b/iu],
    ['session recording start', /\.\s*startSessionRecording\s*\(/iu],
  ]) {
    if (pattern.test(rendererSource)) {
      throw new Error(
        `community-observed renderer contains active ${label} code`,
      );
    }
  }

  return {
    schemaVersion: 1,
    status: 'validated',
    transport: 'posthog-node-backend',
    optIn: 'explicit',
    allowedTelemetryLevel: 'anonymous',
    privacyMode: true,
    disableGeoip: true,
    renderer: {
      enabled: false,
      projectKeyEmbedded: false,
      autocapture: 'disabled',
      sessionRecording: 'disabled',
    },
    exceptions: 'disabled',
    modelTracing: 'disabled',
    contentPolicy: 'event-field-allowlist-v1',
    backendProjectKeyCount: backendProjectKeys.size,
    backendEntryCount: backendClosure.size,
    rendererEntryCount: rendererEntries.length,
    contract: COMMUNITY_OBSERVED_TELEMETRY_CONTRACT,
    artifactAssertion: COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
  };
}
