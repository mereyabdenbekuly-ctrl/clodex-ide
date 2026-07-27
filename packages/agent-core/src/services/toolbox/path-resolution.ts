import path from 'node:path';
import { PLANS_PREFIX } from '../../plans';
import { LOGS_PREFIX } from '../../logs';
import type {
  UniversalToolboxDeps,
  MountPermission,
  StaticMount,
} from './types';

export interface ResolvedToolPath {
  inputPath: string;
  mountPrefix: string;
  relativePath: string;
  mountRoot: string;
  absolutePath: string;
  permissions: readonly MountPermission[];
}

const READ_ONLY_PERMISSIONS: readonly MountPermission[] = ['read'];
const FULL_PERMISSIONS: readonly MountPermission[] = [
  'read',
  'write',
  'create',
  'delete',
];

type WindowsPathInput =
  | { kind: 'absolute'; absolutePath: string }
  | { kind: 'device' }
  | { kind: 'drive-designator'; drive: string }
  | { kind: 'drive-relative'; drive: string }
  | { kind: 'rooted' };

interface RegisteredWorkspaceAlias {
  prefix: string;
  relativePath: string;
}

type RegisteredWorkspaceAliasResolution =
  | { kind: 'match'; alias: RegisteredWorkspaceAlias }
  | { kind: 'ambiguous' }
  | { kind: 'not-found' };

function classifyWindowsPathInput(value: string): WindowsPathInput | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (
    trimmed.startsWith('\\\\?\\') ||
    trimmed.startsWith('\\\\.\\') ||
    trimmed.startsWith('//?/') ||
    trimmed.startsWith('//./')
  ) {
    return { kind: 'device' };
  }

  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return { kind: 'absolute', absolutePath: trimmed };
  }

  // Some providers prepend one slash when serializing a drive-absolute path
  // (for example `/C:/Users/...`). Treat it as Windows syntax before the
  // generic mount parser strips the slash and mistakes `C:` for a prefix.
  const withoutLeadingSlash =
    (trimmed.startsWith('/') || trimmed.startsWith('\\')) &&
    /^[A-Za-z]:[\\/]/u.test(trimmed.slice(1))
      ? trimmed.slice(1)
      : trimmed;
  const driveMatch = withoutLeadingSlash.match(/^([A-Za-z]):/u);
  if (!driveMatch) {
    return trimmed.startsWith('/') || trimmed.startsWith('\\')
      ? { kind: 'rooted' }
      : null;
  }

  const drive = `${driveMatch[1]!.toUpperCase()}:`;
  if (withoutLeadingSlash.length === 2) {
    return { kind: 'drive-designator', drive };
  }
  if (/^[A-Za-z]:[\\/]/u.test(withoutLeadingSlash)) {
    return { kind: 'absolute', absolutePath: withoutLeadingSlash };
  }
  return { kind: 'drive-relative', drive };
}

function isInsideWindowsRoot(relativePath: string): boolean {
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.win32.sep}`) &&
      !path.win32.isAbsolute(relativePath))
  );
}

function findRegisteredWorkspaceAlias(
  deps: UniversalToolboxDeps,
  absolutePath: string,
): RegisteredWorkspaceAliasResolution {
  const mountManager = deps.mountManager;
  if (!mountManager || !path.win32.isAbsolute(absolutePath)) {
    return { kind: 'not-found' };
  }

  const candidate = path.win32.resolve(absolutePath);
  const matches: Array<
    RegisteredWorkspaceAlias & { normalizedRoot: string; rootLength: number }
  > = [];

  for (const prefix of mountManager.getMountPrefixes(deps.agentInstanceId) ??
    []) {
    const workspaceRoot = mountManager.getWorkspacePathForPrefix(prefix);
    if (!workspaceRoot || !path.win32.isAbsolute(workspaceRoot)) continue;

    const normalizedRoot = path.win32.resolve(workspaceRoot);
    const relativePath = path.win32.relative(normalizedRoot, candidate);
    if (!isInsideWindowsRoot(relativePath)) continue;

    matches.push({
      prefix,
      relativePath: relativePath.replaceAll('\\', '/'),
      normalizedRoot: normalizedRoot.toLowerCase(),
      rootLength: normalizedRoot.replace(/[\\/]+$/u, '').length,
    });
  }

  if (matches.length === 0) return { kind: 'not-found' };
  const longestRootLength = Math.max(
    ...matches.map((match) => match.rootLength),
  );
  const longestMatches = matches.filter(
    (match) => match.rootLength === longestRootLength,
  );
  const distinctRoots = new Set(
    longestMatches.map((match) => match.normalizedRoot),
  );
  const distinctPrefixes = new Set(longestMatches.map((match) => match.prefix));
  if (distinctRoots.size !== 1 || distinctPrefixes.size !== 1) {
    return { kind: 'ambiguous' };
  }

  const match = longestMatches[0]!;
  return {
    kind: 'match',
    alias: { prefix: match.prefix, relativePath: match.relativePath },
  };
}

function availableMountPrefixText(deps: UniversalToolboxDeps): string {
  const prefixes = listAvailableMountPrefixes(deps);
  return prefixes.length > 0
    ? prefixes.map((prefix) => `"${prefix}"`).join(', ')
    : 'none';
}

function assertNoWindowsPathInput(
  deps: UniversalToolboxDeps,
  inputPath: string,
): void {
  const windowsInput = classifyWindowsPathInput(inputPath);
  if (!windowsInput) return;

  const available = availableMountPrefixText(deps);
  if (windowsInput.kind === 'drive-designator') {
    throw new Error(
      `Windows drive designator "${windowsInput.drive}" is not a mount prefix. Use an exact registered prefix from <symlinks>. Available mount prefixes: ${available}`,
    );
  }
  if (windowsInput.kind === 'drive-relative') {
    throw new Error(
      `Windows drive-relative paths such as "${inputPath}" are not accepted. Use an exact registered mount-prefixed path from <symlinks>. Available mount prefixes: ${available}`,
    );
  }
  if (windowsInput.kind === 'device') {
    throw new Error(
      `Windows device paths such as "${inputPath}" are not accepted. Use an exact registered mount-prefixed path from <symlinks>. Available mount prefixes: ${available}`,
    );
  }
  if (windowsInput.kind === 'rooted') {
    throw new Error(
      `Paths beginning with "/" or "\\" are absolute/rooted paths, not mount-prefixed capability addresses. Remove the leading separator and use an exact registered prefix from <symlinks>. Available mount prefixes: ${available}`,
    );
  }

  const aliasResolution = findRegisteredWorkspaceAlias(
    deps,
    windowsInput.absolutePath,
  );
  if (aliasResolution.kind === 'match') {
    const { alias } = aliasResolution;
    const mountedPath = alias.relativePath
      ? `${alias.prefix}/${alias.relativePath}`
      : `${alias.prefix}/`;
    throw new Error(
      `Windows absolute paths are not accepted by file tools. This path belongs to registered mount "${alias.prefix}". For path arguments, retry with "${mountedPath}"; for mount_prefix arguments, use "${alias.prefix}".`,
    );
  }
  if (aliasResolution.kind === 'ambiguous') {
    throw new Error(
      `Windows absolute paths are not accepted by file tools, and the supplied path cannot be mapped to one unambiguous registered mount. Use an exact registered mount-prefixed path from <symlinks>. Available mount prefixes: ${available}`,
    );
  }

  throw new Error(
    `Windows absolute paths are not accepted by file tools, and the supplied path is not inside a workspace mounted for this agent. Use an exact registered mount-prefixed path from <symlinks>. Available mount prefixes: ${available}`,
  );
}

function normalizeMountPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function splitMountPath(value: string): {
  prefix: string;
  relativePath: string;
} {
  const normalized = normalizeMountPath(value);
  const [prefix, ...rest] = normalized.split('/');
  if (!prefix) throw new Error('Path must include a mount prefix');
  return { prefix, relativePath: rest.join('/') };
}

function hasPermission(
  permissions: readonly MountPermission[],
  permission: MountPermission,
): boolean {
  return permissions.includes(permission);
}

function assertInsideMount(absolutePath: string, mountRoot: string): void {
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(mountRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
}

const WINDOWS_RESERVED_DEVICE_BASENAME =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/iu;

function usesWindowsPathSemantics(mountRoot: string): boolean {
  return (
    process.platform === 'win32' ||
    /^[A-Za-z]:[\\/]/u.test(mountRoot) ||
    mountRoot.startsWith('\\\\') ||
    mountRoot.startsWith('//')
  );
}

function assertSafeWindowsRelativePath(relativePath: string): void {
  for (const segment of relativePath.split('/')) {
    if (!segment) continue;
    if (segment.includes(':')) {
      throw new Error(
        `Windows alternate data stream syntax is not allowed in mount-relative path segment "${segment}"`,
      );
    }

    const withoutTrailingDotsOrSpaces = segment.replace(/[. ]+$/u, '');
    const basename = (withoutTrailingDotsOrSpaces.split('.')[0] ?? '').replace(
      /[. ]+$/u,
      '',
    );
    if (WINDOWS_RESERVED_DEVICE_BASENAME.test(basename)) {
      throw new Error(
        `Windows reserved device name "${segment}" is not allowed in mount-relative paths`,
      );
    }
  }
}

function getStaticMounts(deps: UniversalToolboxDeps): StaticMount[] {
  return [
    ...(deps.staticMounts ?? []),
    {
      prefix: PLANS_PREFIX,
      absolutePath: deps.hostPaths.plansDir(),
      permissions: FULL_PERMISSIONS,
    },
    {
      prefix: LOGS_PREFIX,
      absolutePath: deps.hostPaths.logsDir(),
      permissions: FULL_PERMISSIONS,
    },
    {
      prefix: 'memory',
      absolutePath: deps.hostPaths.memoryDir(),
      permissions: READ_ONLY_PERMISSIONS,
    },
    {
      prefix: 'apps',
      absolutePath: deps.hostPaths.agentAppsDir(deps.agentInstanceId),
      permissions: FULL_PERMISSIONS,
    },
    {
      prefix: 'att',
      absolutePath: deps.hostPaths.agentAttachmentsDir(deps.agentInstanceId),
      permissions: READ_ONLY_PERMISSIONS,
    },
    {
      prefix: 'shells',
      absolutePath: deps.hostPaths.agentShellLogsDir(deps.agentInstanceId),
      permissions: READ_ONLY_PERMISSIONS,
    },
    {
      prefix: 'plugins',
      absolutePath: deps.hostPaths.pluginsDir(),
      permissions: READ_ONLY_PERMISSIONS,
    },
  ];
}

export function listAvailableMountPrefixes(
  deps: UniversalToolboxDeps,
): string[] {
  const prefixes = new Set<string>();
  for (const mount of getStaticMounts(deps)) prefixes.add(mount.prefix);
  for (const prefix of deps.mountManager?.getMountPrefixes(
    deps.agentInstanceId,
  ) ?? []) {
    prefixes.add(prefix);
  }
  return [...prefixes].sort();
}

export function resolveToolPath(
  deps: UniversalToolboxDeps,
  inputPath: string,
  permission: MountPermission = 'read',
): ResolvedToolPath {
  // Tool paths are capability addresses, not host filesystem paths. Detect
  // Windows drive/UNC syntax before backslash normalization can reinterpret a
  // drive letter (for example `C:`) as a mount prefix. Guidance may name an
  // already-registered alias, but absolute input is never authorized directly.
  assertNoWindowsPathInput(deps, inputPath);
  const { prefix, relativePath } = splitMountPath(inputPath);

  const staticMount = getStaticMounts(deps).find((m) => m.prefix === prefix);
  const delegatedWorkspacePrefixes =
    deps.mountManager?.getMountPrefixes(deps.agentInstanceId) ?? [];
  const workspaceRoot = delegatedWorkspacePrefixes.includes(prefix)
    ? deps.mountManager?.getWorkspacePathForPrefix(prefix)
    : undefined;
  const mountRoot = staticMount?.absolutePath ?? workspaceRoot;
  const permissions =
    staticMount?.permissions ??
    deps.mountManager?.getMountPermissionsForPrefix?.(
      deps.agentInstanceId,
      prefix,
    ) ??
    READ_ONLY_PERMISSIONS;

  if (!mountRoot) {
    throw new Error(
      `Mount ${prefix} not found. Available mounts: ${listAvailableMountPrefixes(deps).join(', ')}`,
    );
  }

  if (usesWindowsPathSemantics(mountRoot)) {
    assertSafeWindowsRelativePath(relativePath);
  }

  if (!hasPermission(permissions, permission)) {
    throw new Error(
      `Mount ${prefix} is read-only or does not allow ${permission}`,
    );
  }

  const absolutePath = path.resolve(mountRoot, relativePath);
  assertInsideMount(absolutePath, mountRoot);

  return {
    inputPath,
    mountPrefix: prefix,
    relativePath,
    mountRoot: path.resolve(mountRoot),
    absolutePath,
    permissions,
  };
}

export function resolveToolMountPrefix(
  deps: UniversalToolboxDeps,
  inputPrefix: string,
  permission: MountPermission = 'read',
): ResolvedToolPath {
  // Prefix-only tools append `/` before reaching the ordinary path resolver.
  // Check the raw value first so a bare drive designator (`C:`) is not turned
  // into the drive-absolute-looking `C:/`, and reject subpaths that those tools
  // would otherwise silently broaden to the whole mount.
  assertNoWindowsPathInput(deps, inputPrefix);
  if (!inputPrefix || inputPrefix.includes('/') || inputPrefix.includes('\\')) {
    throw new Error(
      `mount_prefix must be one exact registered prefix from <symlinks>, not a path. Available mount prefixes: ${availableMountPrefixText(deps)}`,
    );
  }
  return resolveToolPath(deps, `${inputPrefix}/`, permission);
}

export function findWorkspaceRootForPath(
  deps: UniversalToolboxDeps,
  absolutePath: string,
): string | null {
  return (
    deps.mountManager?.findWorkspaceForFile(
      deps.agentInstanceId,
      absolutePath,
    ) ?? null
  );
}
