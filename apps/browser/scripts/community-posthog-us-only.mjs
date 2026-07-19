import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const COMMUNITY_US_POSTHOG_INGESTION_ORIGIN = 'https://us.i.posthog.com';
export const COMMUNITY_US_POSTHOG_ASSET_ORIGIN =
  'https://us-assets.i.posthog.com';

export const COMMUNITY_ALLOWED_POSTHOG_HOSTS = Object.freeze([
  'us.i.posthog.com',
  'us-assets.i.posthog.com',
]);

const ALLOWED_HOSTS = new Set(COMMUNITY_ALLOWED_POSTHOG_HOSTS);
const KNOWN_REGIONAL_REWRITES = new Map([
  ['eu.i.posthog.com', COMMUNITY_US_POSTHOG_INGESTION_ORIGIN],
  ['eu-assets.i.posthog.com', COMMUNITY_US_POSTHOG_ASSET_ORIGIN],
]);
const POSTHOG_INGESTION_ORIGIN_PATTERN =
  /https:\/\/([a-z0-9.-]+\.i\.posthog\.com)(?=[/:?#]|[^A-Za-z0-9._~-]|$)/giu;

function findPostHogOrigins(source) {
  POSTHOG_INGESTION_ORIGIN_PATTERN.lastIndex = 0;
  return [...source.matchAll(POSTHOG_INGESTION_ORIGIN_PATTERN)].map(
    (match) => ({
      host: (match[1] ?? '').toLowerCase(),
      origin: match[0],
    }),
  );
}

export function findDisallowedCommunityPostHogHosts(source) {
  return [
    ...new Set(
      findPostHogOrigins(source)
        .map(({ host }) => host)
        .filter((host) => !ALLOWED_HOSTS.has(host)),
    ),
  ].sort();
}

export function assertCommunityPostHogUsOnly(source, location = 'backend') {
  const disallowedHosts = findDisallowedCommunityPostHogHosts(source);
  if (disallowedHosts.length > 0) {
    throw new Error(
      `Community ${location} contains unsupported PostHog regional host(s): ` +
        disallowedHosts.join(', '),
    );
  }
}

/**
 * Canonicalize the two regional origins shipped by posthog-node.
 *
 * These replacements are deliberately explicit and byte-length preserving so
 * backend source-map offsets remain valid. Any new or unexpected PostHog
 * regional host is not guessed: it remains in the output candidate and makes
 * the build fail closed below.
 */
export function rewriteKnownCommunityPostHogOrigins(source) {
  const replacements = [];
  POSTHOG_INGESTION_ORIGIN_PATTERN.lastIndex = 0;
  const rewrittenSource = source.replace(
    POSTHOG_INGESTION_ORIGIN_PATTERN,
    (origin, capturedHost) => {
      const host = String(capturedHost).toLowerCase();
      if (ALLOWED_HOSTS.has(host)) return origin;

      const replacement = KNOWN_REGIONAL_REWRITES.get(host);
      if (!replacement) return origin;
      if (replacement.length !== origin.length) {
        throw new Error(
          `Community PostHog rewrite for ${host} must preserve byte length`,
        );
      }
      replacements.push({ from: host, to: new URL(replacement).hostname });
      return replacement;
    },
  );

  assertCommunityPostHogUsOnly(rewrittenSource);
  return { replacements, source: rewrittenSource };
}

function listBackendFiles(backendDirectory) {
  const files = [];
  const pendingDirectories = [backendDirectory];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(directory, entry.name);
      const metadata = lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          'Community backend build output must not contain symlinks: ' +
            entryPath,
        );
      }
      if (metadata.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (metadata.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(
          'Community backend build output contains an unsupported entry: ' +
            entryPath,
        );
      }
    }
  }

  return files.sort();
}

/**
 * Rewrite and then independently re-read the exact backend files that Electron
 * Packager is about to place in app.asar. The second pass makes a failed write,
 * an unexpected regional literal, or a later unsupported file fail the build
 * before packaging; the separate packaged-byte validator remains the final
 * independent gate after app.asar is produced.
 */
export function enforceCommunityPostHogUsOnlyInBackend(buildPath) {
  const backendDirectory = path.join(buildPath, '.vite', 'build');
  const metadata = lstatSync(backendDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      'Community backend build directory is not a regular directory: ' +
        backendDirectory,
    );
  }

  const files = listBackendFiles(backendDirectory);
  if (files.length === 0) {
    throw new Error('Community backend build output contains no files');
  }

  let bytesScanned = 0;
  const replacements = [];
  for (const filePath of files) {
    const contents = readFileSync(filePath);
    bytesScanned += contents.length;
    const result = rewriteKnownCommunityPostHogOrigins(
      contents.toString('latin1'),
    );
    if (result.replacements.length === 0) continue;
    writeFileSync(filePath, Buffer.from(result.source, 'latin1'));
    replacements.push(
      ...result.replacements.map((replacement) => ({
        ...replacement,
        file: path.relative(backendDirectory, filePath),
      })),
    );
  }

  // Verify the bytes from disk rather than trusting the in-memory rewrite.
  for (const filePath of files) {
    assertCommunityPostHogUsOnly(
      readFileSync(filePath).toString('latin1'),
      `backend file ${path.relative(backendDirectory, filePath)}`,
    );
  }

  return {
    backendDirectory,
    bytesScanned,
    filesScanned: files.length,
    replacements,
  };
}
