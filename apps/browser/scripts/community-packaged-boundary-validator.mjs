import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const COMMUNITY_US_POSTHOG_INGESTION_ORIGIN = 'https://us.i.posthog.com';

const COMMUNITY_DISTRIBUTIONS = Object.freeze({
  'community-observed': Object.freeze({
    baseName: 'clodex-community-observed',
    telemetryCompiledIn: true,
  }),
  'community-unsigned': Object.freeze({
    baseName: 'clodex-community-unsigned',
    telemetryCompiledIn: false,
  }),
});

const MANAGED_CONFIGURATION_KEYS = Object.freeze([
  'CLODEX_CLOUD_TASKS_URL',
  'CLODEX_MCP_GATEWAY_URL',
  'CLODEX_SESSION_SHARING_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_URL',
]);

const TEXT_MARKERS = Object.freeze(
  [
    'http',
    'CLODEX_',
    'SUPABASE_',
    'sb_',
    'eyJ',
    'PRIVATE KEY',
    'posthog.com',
  ].map((marker) => Buffer.from(marker, 'ascii')),
);

const MANAGED_ENDPOINT_RULES = Object.freeze([
  Object.freeze({
    id: 'managed-mcp-endpoint',
    pattern:
      /https?:\/\/[^\s"'`\\<>]{1,2048}\/tools-gateway\/mcp(?=[/?#]|[^A-Za-z0-9._~-]|$)/giu,
  }),
  Object.freeze({
    id: 'managed-cloud-tasks-endpoint',
    pattern:
      /https?:\/\/[^\s"'`\\<>]{1,2048}\/(?:v\d+\/)?cloud-tasks(?=[/?#]|[^A-Za-z0-9._~-]|$)/giu,
  }),
  Object.freeze({
    id: 'managed-session-sharing-endpoint',
    pattern:
      /https?:\/\/[^\s"'`\\<>]{1,2048}\/(?:v\d+\/)?(?:session-shares?|session-sharing)(?=[/?#]|[^A-Za-z0-9._~-]|$)/giu,
  }),
]);

const SUPABASE_PROJECT_URL_PATTERN =
  /https:\/\/[a-z0-9-]+\.supabase\.co(?=[/?#]|[^A-Za-z0-9._~-]|$)/giu;
const SUPABASE_KEY_PATTERN = /sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}/gu;
const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu;
const POSTHOG_INGESTION_ORIGIN_PATTERN =
  /https:\/\/([a-z0-9.-]+\.i\.posthog\.com)(?=[/:?#]|[^A-Za-z0-9._~-]|$)/giu;

function assertCommunityDistribution(distributionMode) {
  const distribution = COMMUNITY_DISTRIBUTIONS[distributionMode];
  if (!distribution) {
    throw new Error(
      `Unsupported Community distribution mode: ${String(distributionMode)}`,
    );
  }
  return distribution;
}

function normalizePlatform(platform) {
  if (!['linux', 'macos', 'windows'].includes(platform)) {
    throw new Error(`Unsupported Community package platform: ${platform}`);
  }
  return platform;
}

function normalizeArch(arch) {
  if (!['arm64', 'x64'].includes(arch)) {
    throw new Error(`Unsupported Community package architecture: ${arch}`);
  }
  return arch;
}

export function resolveCommunityPackagedAsarPath({
  arch,
  browserDirectory,
  distributionMode,
  platform,
}) {
  const distribution = assertCommunityDistribution(distributionMode);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  const outputRoot = path.join(browserDirectory, 'out', distributionMode);

  if (normalizedPlatform === 'macos') {
    return path.join(
      outputRoot,
      `${distribution.baseName}-darwin-${normalizedArch}`,
      `${distribution.baseName}.app`,
      'Contents',
      'Resources',
      'app.asar',
    );
  }

  const packagedPlatform = normalizedPlatform === 'windows' ? 'win32' : 'linux';
  return path.join(
    outputRoot,
    `${distribution.baseName}-${packagedPlatform}-${normalizedArch}`,
    'resources',
    'app.asar',
  );
}

function normalizeArchiveEntryPath(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Community app.asar contains an invalid entry path');
  }
  const comparisonPath = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = comparisonPath.split('/');
  if (
    !comparisonPath ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        [...part].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
          );
        }),
    )
  ) {
    throw new Error(
      `Community app.asar contains a non-canonical entry path: ${value}`,
    );
  }
  const lookupPath = path.normalize(parts.join(path.sep));
  if (
    !lookupPath ||
    path.isAbsolute(lookupPath) ||
    path.win32.parse(comparisonPath).root !== ''
  ) {
    throw new Error(
      `Community app.asar contains a non-canonical native path: ${value}`,
    );
  }
  return { comparisonPath, lookupPath };
}

function isApplicationOwnedPath(comparisonPath) {
  return (
    comparisonPath === '.vite' ||
    comparisonPath.startsWith('.vite/') ||
    comparisonPath === 'package.json'
  );
}

function isBackendBundlePath(comparisonPath) {
  return (
    comparisonPath === '.vite/build' ||
    comparisonPath.startsWith('.vite/build/')
  );
}

function bufferCouldContainPolicyText(contents) {
  return TEXT_MARKERS.some((marker) => contents.indexOf(marker) >= 0);
}

function countOccurrences(source, needle) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + needle.length;
  }
}

function addFinding(state, ruleId, location) {
  const key = `${ruleId}\0${location}`;
  if (!state.findingKeys.has(key)) {
    state.findingKeys.add(key);
    state.findings.push({ location, ruleId });
  }
}

function isEmbeddedSupabaseJwt(candidate) {
  const [, payload] = candidate.split('.');
  if (!payload) return false;
  try {
    const value = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const issuer = typeof value.iss === 'string' ? value.iss.toLowerCase() : '';
    const role = typeof value.role === 'string' ? value.role.toLowerCase() : '';
    return (
      issuer.includes('supabase') ||
      (typeof value.ref === 'string' &&
        ['anon', 'authenticated', 'service_role'].includes(role))
    );
  } catch {
    return false;
  }
}

function inspectManagedConfigurationAssignments(source, location, state) {
  for (const key of MANAGED_CONFIGURATION_KEYS) {
    const pattern = new RegExp(
      `${key}["']?\\s*:\\s*(["'\\x60])([^\\r\\n]{0,4096}?)\\1`,
      'gu',
    );
    for (const match of source.matchAll(pattern)) {
      if ((match[2] ?? '').trim()) {
        addFinding(state, `embedded-managed-config:${key}`, location);
        break;
      }
    }
  }
}

function inspectBuffer(contents, location, comparisonPath, state) {
  state.bytesScanned += contents.length;
  state.filesScanned += 1;
  if (!bufferCouldContainPolicyText(contents)) return;

  const source = contents.toString('latin1');
  const applicationOwned = isApplicationOwnedPath(comparisonPath);

  for (const rule of MANAGED_ENDPOINT_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) addFinding(state, rule.id, location);
  }

  POSTHOG_INGESTION_ORIGIN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(POSTHOG_INGESTION_ORIGIN_PATTERN)) {
    if ((match[1] ?? '').toLowerCase() !== 'us.i.posthog.com') {
      addFinding(state, 'non-us-posthog-ingestion-host', location);
      break;
    }
  }

  if (applicationOwned) {
    inspectManagedConfigurationAssignments(source, location, state);
    SUPABASE_PROJECT_URL_PATTERN.lastIndex = 0;
    if (SUPABASE_PROJECT_URL_PATTERN.test(source)) {
      addFinding(state, 'embedded-supabase-project-url', location);
    }
    SUPABASE_KEY_PATTERN.lastIndex = 0;
    if (SUPABASE_KEY_PATTERN.test(source)) {
      addFinding(state, 'embedded-supabase-api-key', location);
    }
    PRIVATE_KEY_PATTERN.lastIndex = 0;
    if (PRIVATE_KEY_PATTERN.test(source)) {
      addFinding(state, 'embedded-private-key', location);
    }
    JWT_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(JWT_PATTERN)) {
      if (isEmbeddedSupabaseJwt(match[0])) {
        addFinding(state, 'embedded-supabase-jwt', location);
        break;
      }
    }
  }

  if (isBackendBundlePath(comparisonPath)) {
    state.backendUsPostHogOriginOccurrences += countOccurrences(
      source,
      COMMUNITY_US_POSTHOG_INGESTION_ORIGIN,
    );
  }
}

function inspectPackedArchive(asarPath, asarApi, state) {
  const seenPaths = new Set();
  const declaredUnpackedFiles = new Set();
  for (const listedPath of asarApi.listPackage(asarPath)) {
    const entry = normalizeArchiveEntryPath(listedPath);
    if (seenPaths.has(entry.comparisonPath)) {
      throw new Error(
        `Community app.asar has a duplicate canonical entry: ${entry.comparisonPath}`,
      );
    }
    seenPaths.add(entry.comparisonPath);
    const metadata = asarApi.statFile(asarPath, entry.lookupPath, false);
    if (!metadata || typeof metadata !== 'object') {
      throw new Error(
        `Community app.asar entry metadata is invalid: ${entry.comparisonPath}`,
      );
    }
    if ('unpacked' in metadata && typeof metadata.unpacked !== 'boolean') {
      throw new Error(
        `Community app.asar entry has invalid unpacked metadata: ${entry.comparisonPath}`,
      );
    }
    const isDirectory = 'files' in metadata;
    const isLink = 'link' in metadata;
    const isRegular = Number.isSafeInteger(metadata.size) && metadata.size >= 0;
    if (Number(isDirectory) + Number(isLink) + Number(isRegular) !== 1) {
      throw new Error(
        `Community app.asar entry metadata is ambiguous: ${entry.comparisonPath}`,
      );
    }
    if (!isRegular) continue;
    if (metadata.unpacked === true) {
      declaredUnpackedFiles.add(entry.comparisonPath);
      continue;
    }
    const contents = asarApi.extractFile(asarPath, entry.lookupPath, false);
    if (!Buffer.isBuffer(contents) || contents.length !== metadata.size) {
      throw new Error(
        `Community app.asar entry bytes do not match metadata: ${entry.comparisonPath}`,
      );
    }
    state.packedEntriesScanned += 1;
    inspectBuffer(
      contents,
      `app.asar:${entry.comparisonPath}`,
      entry.comparisonPath,
      state,
    );
  }
  return declaredUnpackedFiles;
}

function inspectUnpackedArchive(asarPath, declaredUnpackedFiles, state) {
  const unpackedRoot = `${asarPath}.unpacked`;
  if (!existsSync(unpackedRoot)) {
    if (declaredUnpackedFiles.size > 0) {
      throw new Error(
        `Community app.asar declares unpacked files but ${unpackedRoot} is missing`,
      );
    }
    return;
  }
  if (!lstatSync(unpackedRoot).isDirectory()) {
    throw new Error(
      `Community app.asar.unpacked is not a directory: ${unpackedRoot}`,
    );
  }

  const discoveredFiles = new Set();
  const queue = [unpackedRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const entryPath = path.join(current, name);
      const metadata = lstatSync(entryPath);
      const relativePath = path.relative(unpackedRoot, entryPath);
      const entry = normalizeArchiveEntryPath(relativePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Community app.asar.unpacked must not contain symlinks: ${entry.comparisonPath}`,
        );
      }
      if (metadata.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(
          `Community app.asar.unpacked contains an unsupported entry: ${entry.comparisonPath}`,
        );
      }
      discoveredFiles.add(entry.comparisonPath);
      state.unpackedFilesScanned += 1;
      inspectBuffer(
        readFileSync(entryPath),
        `app.asar.unpacked:${entry.comparisonPath}`,
        entry.comparisonPath,
        state,
      );
    }
  }

  for (const declaredPath of declaredUnpackedFiles) {
    if (!discoveredFiles.has(declaredPath)) {
      throw new Error(
        `Community app.asar.unpacked is missing a declared file: ${declaredPath}`,
      );
    }
  }
}

export function inspectCommunityPackagedBoundary({
  asarApi,
  asarPath,
  distributionMode,
}) {
  const distribution = assertCommunityDistribution(distributionMode);
  if (!asarApi || typeof asarApi !== 'object') {
    throw new Error('Community packaged-byte validation requires an ASAR API');
  }
  for (const method of ['extractFile', 'listPackage', 'statFile']) {
    if (typeof asarApi[method] !== 'function') {
      throw new Error(`Community ASAR API is missing ${method}()`);
    }
  }
  if (!existsSync(asarPath) || !statSync(asarPath).isFile()) {
    throw new Error(`Community app.asar is missing: ${asarPath}`);
  }

  const state = {
    backendUsPostHogOriginOccurrences: 0,
    bytesScanned: 0,
    findingKeys: new Set(),
    findings: [],
    filesScanned: 0,
    packedEntriesScanned: 0,
    unpackedFilesScanned: 0,
  };
  const declaredUnpackedFiles = inspectPackedArchive(asarPath, asarApi, state);
  inspectUnpackedArchive(asarPath, declaredUnpackedFiles, state);

  if (
    distribution.telemetryCompiledIn &&
    state.backendUsPostHogOriginOccurrences === 0
  ) {
    addFinding(
      state,
      'observed-backend-missing-us-posthog-ingestion-origin',
      'app.asar:.vite/build',
    );
  }
  if (state.findings.length > 0) {
    const details = state.findings
      .map((finding) => `${finding.ruleId} in ${finding.location}`)
      .join('; ');
    throw new Error(
      `Community packaged-byte boundary validation failed: ${details}`,
    );
  }

  return {
    schemaVersion: 1,
    status: 'validated',
    distributionMode,
    telemetry: {
      backendUsPostHogOriginOccurrences:
        state.backendUsPostHogOriginOccurrences,
      requiredInBackend: distribution.telemetryCompiledIn,
      requiredOrigin: distribution.telemetryCompiledIn
        ? COMMUNITY_US_POSTHOG_INGESTION_ORIGIN
        : null,
    },
    scan: {
      bytes: state.bytesScanned,
      files: state.filesScanned,
      packedEntries: state.packedEntriesScanned,
      unpackedFiles: state.unpackedFilesScanned,
    },
  };
}

export function writeCommunityPackagedBoundaryEvidence(outputPath, evidence) {
  const resolvedOutput = path.resolve(outputPath);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
  });
  return resolvedOutput;
}

export function attachCommunityPackagedBoundaryEvidence({
  architecture,
  distributionMode,
  evidence,
  manifestPath,
  platform,
}) {
  const resolvedManifest = path.resolve(manifestPath);
  if (!existsSync(resolvedManifest) || !statSync(resolvedManifest).isFile()) {
    throw new Error(
      `Community validation manifest is missing: ${resolvedManifest}`,
    );
  }
  const manifest = JSON.parse(readFileSync(resolvedManifest, 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.status !== 'passed' ||
    !manifest.build ||
    typeof manifest.build !== 'object' ||
    manifest.build.distributionMode !== distributionMode ||
    manifest.build.platform !== platform ||
    manifest.build.arch !== architecture ||
    !manifest.checks ||
    typeof manifest.checks !== 'object' ||
    Array.isArray(manifest.checks)
  ) {
    throw new Error(
      'Community validation manifest identity does not match packaged-byte evidence',
    );
  }
  if (Object.hasOwn(manifest.checks, 'communityPackagedBoundary')) {
    throw new Error(
      'Community validation manifest already contains packaged-byte evidence',
    );
  }
  manifest.checks.communityPackagedBoundary = evidence;
  const temporaryPath = `${resolvedManifest}.packaged-boundary-${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(temporaryPath, resolvedManifest);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return resolvedManifest;
}
