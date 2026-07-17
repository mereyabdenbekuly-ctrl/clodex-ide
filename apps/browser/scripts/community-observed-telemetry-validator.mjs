import { extractFile, listPackage, statFile } from '@electron/asar';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';
import ts from 'typescript';

export const COMMUNITY_OBSERVED_TELEMETRY_CONTRACT =
  'clodex-community-observed-backend-anonymous-v1';
export const COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION =
  'clodex-community-observed-contract:{"allowedTelemetryLevel":"anonymous","contentPolicy":"event-field-allowlist-v1","disableGeoip":true,"exceptions":"disabled","modelTracing":"disabled","optIn":"explicit","privacyMode":true,"renderer":"noop"}';
export const COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP =
  'clodex-community-observed-renderer-posthog-noop-v1';

const PROJECT_KEY_PREFIX_TEXT = 'phc_';
const PROJECT_KEY_PREFIX = Buffer.from(PROJECT_KEY_PREFIX_TEXT, 'ascii');
const JAVASCRIPT_PATTERN = /\.(?:c?js|mjs)$/iu;
const HTML_PATTERN = /\.html$/iu;
const JAVASCRIPT_OR_HTML_PATTERN = /\.(?:c?js|mjs|html)$/iu;
const DEFAULT_ASAR_API = Object.freeze({ extractFile, listPackage, statFile });

export function normalizeCommunityObservedArchivePath(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function resolveCommunityObservedArchiveEntryPaths(
  value,
  archivePathApi = path,
) {
  if (typeof value !== 'string' || !value) {
    throw new Error('community-observed ASAR entry has an invalid path');
  }
  const relativePath = value.replace(/^[/\\]+/u, '');
  const comparisonPath = normalizeCommunityObservedArchivePath(relativePath);
  const parts = comparisonPath.split('/');
  if (
    !relativePath ||
    !comparisonPath ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        containsControlCharacter(part),
    )
  ) {
    throw new Error(
      `community-observed ASAR entry has a non-canonical comparison path: ${value}`,
    );
  }
  const lookupPath = archivePathApi.normalize(parts.join(archivePathApi.sep));
  if (
    !lookupPath ||
    archivePathApi.isAbsolute(lookupPath) ||
    path.win32.parse(relativePath).root !== ''
  ) {
    throw new Error(
      `community-observed ASAR entry has a non-canonical native path: ${value}`,
    );
  }
  return { comparisonPath, lookupPath };
}

function isVitePath(comparisonPath) {
  return comparisonPath === '.vite' || comparisonPath.startsWith('.vite/');
}

function pathTouchesViteNamespace(comparisonPath) {
  return comparisonPath.split('/').includes('.vite');
}

function isDependencyBinLink(comparisonPath) {
  const parts = comparisonPath.split('/');
  const binIndex = parts.lastIndexOf('.bin');
  return (
    binIndex > 0 &&
    binIndex === parts.length - 2 &&
    parts.slice(0, binIndex).includes('node_modules')
  );
}

function isExecutableVitePath(comparisonPath) {
  return (
    comparisonPath === '.vite/build' ||
    comparisonPath.startsWith('.vite/build/') ||
    comparisonPath === '.vite/renderer' ||
    comparisonPath.startsWith('.vite/renderer/')
  );
}

function readArchiveBuffer(asarPath, entry, asarApi) {
  const contents = asarApi.extractFile(asarPath, entry.lookupPath, false);
  if (!Buffer.isBuffer(contents) || contents.length !== entry.size) {
    throw new Error(
      `community-observed ASAR entry bytes do not match metadata: ${entry.comparisonPath}`,
    );
  }
  return contents;
}

function addRelativeSpecifier(
  imports,
  specifier,
  {
    absoluteNamespace,
    requireRelative = false,
    sourcePath = 'protected source',
  } = {},
) {
  if (
    /^[\t\n\f\r ]|[\t\n\f\r ]$/u.test(specifier) ||
    containsControlCharacter(specifier)
  ) {
    throw new Error(
      `community-observed module specifier has unsafe whitespace or controls: ${sourcePath}`,
    );
  }
  if (/%[0-9a-f]{2}/iu.test(specifier)) {
    throw new Error(
      `community-observed module specifier must not use percent encoding: ${sourcePath}`,
    );
  }
  const normalized = specifier.replaceAll('\\', '/');
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    imports.add(normalized);
    return;
  }
  if (
    absoluteNamespace &&
    normalized.startsWith('/') &&
    !normalized.startsWith('//')
  ) {
    const pathPart = moduleSpecifierPath(normalized);
    const namespaceRelativePath = pathPart.replace(/^\/+/, '');
    if (path.win32.parse(namespaceRelativePath).root !== '') {
      throw new Error(
        `community-observed protected HTML root path is drive-qualified: ${sourcePath}`,
      );
    }
    const target = path.posix.normalize(
      path.posix.join(absoluteNamespace, namespaceRelativePath),
    );
    if (
      target !== absoluteNamespace &&
      !target.startsWith(`${absoluteNamespace}/`)
    ) {
      throw new Error(
        `community-observed protected HTML root path escapes ${absoluteNamespace}: ${sourcePath}`,
      );
    }
    let relative = path.posix.relative(path.posix.dirname(sourcePath), target);
    if (!relative.startsWith('.')) relative = `./${relative}`;
    imports.add(`${relative}${normalized.slice(pathPart.length)}`);
    return;
  }
  if (requireRelative) {
    throw new Error(
      `community-observed protected HTML script source must be relative: ${sourcePath}`,
    );
  }
}

function moduleSpecifierPath(specifier) {
  return specifier.split(/[?#]/u, 1)[0];
}

function staticStringValue(expression) {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) {
    return staticStringValue(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticStringValue(span.expression);
      if (substitution === undefined) return undefined;
      value += substitution + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function javascriptRelativeModuleSpecifiers(source, sourcePath) {
  const imports = new Set();
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(
      `community-observed protected JavaScript is not parseable: ${sourcePath}`,
    );
  }
  const addExpression = (expression, dynamic) => {
    const specifier = staticStringValue(expression);
    if (specifier === undefined) {
      if (dynamic && sourcePath.startsWith('.vite/renderer/')) {
        throw new Error(
          `community-observed protected JavaScript has a non-static module specifier: ${sourcePath}`,
        );
      }
      return;
    }
    addRelativeSpecifier(imports, specifier, { sourcePath });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      addExpression(node.moduleSpecifier, false);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isBareRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isModulePropertyRequire =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'module' &&
        node.expression.name.text === 'require';
      const isModuleElementRequire =
        ts.isElementAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'module' &&
        node.expression.argumentExpression !== undefined &&
        staticStringValue(node.expression.argumentExpression) === 'require';
      const isRequire =
        isBareRequire || isModulePropertyRequire || isModuleElementRequire;
      if (isDynamicImport || isRequire) {
        if (!node.arguments[0]) {
          throw new Error(
            `community-observed protected JavaScript has an empty dynamic module specifier: ${sourcePath}`,
          );
        }
        addExpression(node.arguments[0], true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function isExecutableHtmlScriptType(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'module') return true;
  const essence = normalized.split(';', 1)[0].trim();
  return new Set([
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript',
    'text/javascript1.0',
    'text/javascript1.1',
    'text/javascript1.2',
    'text/javascript1.3',
    'text/javascript1.4',
    'text/javascript1.5',
    'text/jscript',
    'text/livescript',
    'text/x-ecmascript',
    'text/x-javascript',
  ]).has(essence);
}

function htmlRelativeModuleSpecifiers(source, sourcePath) {
  const imports = new Set();
  const document = parse(source);
  const pagesNamespace = '.vite/renderer/pages';
  const absoluteNamespace =
    sourcePath === pagesNamespace || sourcePath.startsWith(`${pagesNamespace}/`)
      ? pagesNamespace
      : undefined;
  let index = 0;
  const visit = (node) => {
    if (node.tagName === 'base') {
      throw new Error(
        `community-observed protected HTML must not override its base URL: ${sourcePath}`,
      );
    }
    if (node.tagName === 'script') {
      index += 1;
      const attributes = new Map(
        (node.attrs ?? []).map((attribute) => [
          attribute.name,
          attribute.value,
        ]),
      );
      const scriptType = attributes.get('type') ?? '';
      if (isExecutableHtmlScriptType(scriptType)) {
        if (attributes.has('src')) {
          addRelativeSpecifier(imports, attributes.get('src') ?? '', {
            absoluteNamespace,
            requireRelative: true,
            sourcePath: `${sourcePath} script ${index}`,
          });
        } else {
          const inlineSource = (node.childNodes ?? [])
            .filter((child) => child.nodeName === '#text')
            .map((child) => child.value ?? '')
            .join('');
          const inline = javascriptRelativeModuleSpecifiers(
            inlineSource,
            `${sourcePath}.inline-${index}.js`,
          );
          for (const imported of inline) imports.add(imported);
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(document);
  return imports;
}

function importedRelativePaths(source, sourcePath) {
  if (JAVASCRIPT_PATTERN.test(sourcePath)) {
    return javascriptRelativeModuleSpecifiers(source, sourcePath);
  }
  if (HTML_PATTERN.test(sourcePath)) {
    return htmlRelativeModuleSpecifiers(source, sourcePath);
  }
  return new Set();
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
    for (const imported of importedRelativePaths(source, current)) {
      const resolved = path.posix.normalize(
        path.posix.join(
          path.posix.dirname(current),
          moduleSpecifierPath(imported),
        ),
      );
      if (entries.has(resolved) && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function assertRelativeImportsStayWithinArchiveNamespace({
  label,
  namespace,
  sources,
}) {
  for (const [current, source] of sources) {
    if (current !== namespace && !current.startsWith(`${namespace}/`)) {
      continue;
    }
    for (const imported of importedRelativePaths(source, current)) {
      const importPath = moduleSpecifierPath(imported);
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(current), importPath),
      );
      if (resolved !== namespace && !resolved.startsWith(`${namespace}/`)) {
        throw new Error(
          `community-observed ${label} relative import escapes ${namespace}: ${current} -> ${resolved}`,
        );
      }
    }
  }
}

function isProjectKeyCharacter(character) {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a) ||
      codePoint === 0x2d ||
      codePoint === 0x5f)
  );
}

function extractProjectKeyOccurrences(source) {
  const occurrences = [];
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(PROJECT_KEY_PREFIX_TEXT, searchFrom);
    if (start < 0) return occurrences;
    let cursor = start + PROJECT_KEY_PREFIX_TEXT.length;
    while (cursor < source.length && isProjectKeyCharacter(source[cursor])) {
      cursor += 1;
    }
    if (cursor - start - PROJECT_KEY_PREFIX_TEXT.length >= 20) {
      occurrences.push(source.slice(start, cursor));
    }
    searchFrom = start + PROJECT_KEY_PREFIX_TEXT.length;
  }
}

function regularArchiveEntries(asarPath, { archivePathApi, asarApi }) {
  const entries = new Map();
  let hasUnpackedEntries = false;
  for (const listedPath of asarApi.listPackage(asarPath)) {
    const entry = resolveCommunityObservedArchiveEntryPaths(
      listedPath,
      archivePathApi,
    );
    if (entries.has(entry.comparisonPath)) {
      throw new Error(
        `community-observed ASAR has duplicate canonical entry: ${entry.comparisonPath}`,
      );
    }
    const metadata = asarApi.statFile(asarPath, entry.lookupPath, false);
    if (!metadata || typeof metadata !== 'object') {
      throw new Error(
        `community-observed ASAR entry metadata is invalid: ${entry.comparisonPath}`,
      );
    }
    if ('unpacked' in metadata && typeof metadata.unpacked !== 'boolean') {
      throw new Error(
        `community-observed ASAR entry has non-boolean unpacked metadata: ${entry.comparisonPath}`,
      );
    }
    if (metadata.unpacked === true) hasUnpackedEntries = true;
    const isDirectory = 'files' in metadata;
    const isLink = 'link' in metadata;
    const isRegular = Number.isSafeInteger(metadata.size) && metadata.size >= 0;
    if (Number(isDirectory) + Number(isLink) + Number(isRegular) !== 1) {
      throw new Error(
        `community-observed ASAR entry has ambiguous or unsupported metadata: ${entry.comparisonPath}`,
      );
    }
    if (isDirectory) {
      if (
        !metadata.files ||
        typeof metadata.files !== 'object' ||
        Array.isArray(metadata.files)
      ) {
        throw new Error(
          `community-observed ASAR directory metadata is invalid: ${entry.comparisonPath}`,
        );
      }
      if (metadata.unpacked === true && isVitePath(entry.comparisonPath)) {
        throw new Error(
          `community-observed protected ASAR directory must remain packed: ${entry.comparisonPath}`,
        );
      }
      entries.set(entry.comparisonPath, { ...entry, kind: 'directory' });
      continue;
    }
    if (isLink) {
      const target = resolveCommunityObservedArchiveEntryPaths(
        metadata.link,
        archivePathApi,
      );
      entries.set(entry.comparisonPath, {
        ...entry,
        kind: 'link',
        targetComparisonPath: target.comparisonPath,
      });
      continue;
    }
    if (metadata.unpacked === true) {
      if (isVitePath(entry.comparisonPath)) {
        throw new Error(
          `community-observed protected ASAR entry must remain packed: ${entry.comparisonPath}`,
        );
      }
      entries.set(entry.comparisonPath, { ...entry, kind: 'unpacked' });
      continue;
    }
    entries.set(entry.comparisonPath, {
      ...entry,
      kind: 'regular',
      size: metadata.size,
    });
  }

  // Production dependencies can contain unrelated node_modules/.bin links.
  // Keep them no-follow, but reject any source or target chain that can alias
  // the protected Vite code namespaces.
  for (const entry of entries.values()) {
    if (entry.kind !== 'link') continue;
    const visited = new Set([entry.comparisonPath]);
    let targetPath = entry.targetComparisonPath;
    while (true) {
      if (
        pathTouchesViteNamespace(entry.comparisonPath) ||
        pathTouchesViteNamespace(targetPath)
      ) {
        throw new Error(
          `community-observed protected ASAR entry must not be a symlink: ${entry.comparisonPath} -> ${targetPath}`,
        );
      }
      if (visited.has(targetPath)) {
        throw new Error(
          `community-observed ASAR symlink cycle is not allowed: ${entry.comparisonPath}`,
        );
      }
      visited.add(targetPath);
      const target = entries.get(targetPath);
      if (!target) {
        if (isDependencyBinLink(entry.comparisonPath)) break;
        throw new Error(
          `community-observed ASAR symlink target is missing: ${entry.comparisonPath} -> ${targetPath}`,
        );
      }
      if (target.kind !== 'link') break;
      targetPath = target.targetComparisonPath;
    }
  }

  return {
    hasUnpackedEntries,
    regularEntries: [...entries.values()].filter(
      (entry) => entry.kind === 'regular',
    ),
  };
}

function assertNoProjectKeyInUnpackedResources(asarPath, required) {
  const unpackedRoot = `${asarPath}.unpacked`;
  if (!existsSync(unpackedRoot)) {
    if (required) {
      throw new Error(
        `community-observed app.asar declares unpacked files but ${unpackedRoot} is missing`,
      );
    }
    return;
  }

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
    if (metadata.isFile()) {
      const contents = readFileSync(current);
      if (
        contents.indexOf(PROJECT_KEY_PREFIX) >= 0 &&
        extractProjectKeyOccurrences(contents.toString('latin1')).length > 0
      ) {
        throw new Error(
          `community-observed PostHog project key escaped into app.asar.unpacked: ${current}`,
        );
      }
      continue;
    }
    throw new Error(
      `community-observed unpacked resource has an unsupported type: ${current}`,
    );
  }
}

function containsJavaScriptString(source, value) {
  return (
    source.includes(value) ||
    source.includes(JSON.stringify(value).slice(1, -1))
  );
}

export function inspectCommunityObservedTelemetryAsar(
  asarPath,
  { archivePathApi = path, asarApi = DEFAULT_ASAR_API } = {},
) {
  if (!existsSync(asarPath) || !statSync(asarPath).isFile()) {
    throw new Error(`community-observed app.asar is missing: ${asarPath}`);
  }

  const { hasUnpackedEntries, regularEntries } = regularArchiveEntries(
    asarPath,
    {
      archivePathApi,
      asarApi,
    },
  );
  const archiveEntries = [];
  const sources = new Map();
  const projectKeyOccurrences = new Map();
  for (const entry of regularEntries) {
    const contents = readArchiveBuffer(asarPath, entry, asarApi);
    if (contents.indexOf(PROJECT_KEY_PREFIX) >= 0) {
      const occurrences = extractProjectKeyOccurrences(
        contents.toString('latin1'),
      );
      if (occurrences.length > 0) {
        projectKeyOccurrences.set(entry.comparisonPath, occurrences);
      }
    }
    if (
      isExecutableVitePath(entry.comparisonPath) &&
      JAVASCRIPT_OR_HTML_PATTERN.test(entry.comparisonPath)
    ) {
      archiveEntries.push(entry.comparisonPath);
      sources.set(entry.comparisonPath, contents.toString('utf8'));
    }
  }
  const backendEntries = new Set(
    archiveEntries.filter((entry) => entry.startsWith('.vite/build/')),
  );
  assertRelativeImportsStayWithinArchiveNamespace({
    label: 'backend',
    namespace: '.vite/build',
    sources,
  });
  const backendClosure = resolveBackendClosure(backendEntries, sources);
  const backendSource = [...backendClosure]
    .map((entry) => sources.get(entry) ?? '')
    .join('\n');
  const backendProjectKeys = new Set();
  let backendProjectKeyOccurrenceCount = 0;
  for (const entry of backendClosure) {
    const occurrences = projectKeyOccurrences.get(entry) ?? [];
    backendProjectKeyOccurrenceCount += occurrences.length;
    for (const projectKey of occurrences) backendProjectKeys.add(projectKey);
  }
  const backendProjectKeyCount = backendProjectKeys.size;
  if (backendProjectKeyCount !== 1) {
    throw new Error(
      `community-observed backend must embed exactly one unique PostHog project key; found ${backendProjectKeyCount} unique values across ${backendProjectKeyOccurrenceCount} occurrences`,
    );
  }

  const rendererEntries = archiveEntries.filter((entry) =>
    entry.startsWith('.vite/renderer/'),
  );
  assertRelativeImportsStayWithinArchiveNamespace({
    label: 'renderer',
    namespace: '.vite/renderer',
    sources,
  });
  const rendererSource = rendererEntries
    .map((entry) => sources.get(entry) ?? '')
    .join('\n');
  for (const [entry] of projectKeyOccurrences) {
    if (backendClosure.has(entry)) continue;
    throw new Error(
      `community-observed PostHog project key escaped the backend entry graph: ${entry}`,
    );
  }
  assertNoProjectKeyInUnpackedResources(asarPath, hasUnpackedEntries);

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
    [
      'posthog.init',
      /\bposthog\s*(?:\?\.\s*init\b|\.\s*init\b|\[\s*["']init["']\s*\])/iu,
    ],
    [
      'autocapture enabled',
      /(?:\bautocapture\b|["']autocapture["']|\[\s*["']autocapture["']\s*\])\s*:\s*(?:true|!0)\b/iu,
    ],
    [
      'session recording start',
      /(?:\.\s*startSessionRecording|\[\s*["']startSessionRecording["']\s*\])\s*\(/iu,
    ],
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
    backendProjectKeyCount,
    backendEntryCount: backendClosure.size,
    rendererEntryCount: rendererEntries.length,
    contract: COMMUNITY_OBSERVED_TELEMETRY_CONTRACT,
    artifactAssertion: COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
  };
}
