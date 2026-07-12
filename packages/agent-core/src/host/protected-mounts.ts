import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from '../fs';
import type { HostPaths } from './paths';
import {
  ProtectedAppendFileStorage,
  protectedFileContext,
  readPossiblyProtectedFile,
  type ProtectedFileStorage,
} from './protected-files';

export type ProtectedMountPrefix = 'att' | 'shells' | 'memory';

export interface ResolvedProtectedMountFile {
  prefix: ProtectedMountPrefix;
  relativePath: string;
  absolutePath: string;
  context: string;
  appendOriented: boolean;
}

export function isProtectedMountPrefix(
  prefix: string,
): prefix is ProtectedMountPrefix {
  return prefix === 'att' || prefix === 'shells' || prefix === 'memory';
}

export function resolveProtectedMountFile(
  paths: HostPaths,
  agentId: string,
  mountedPath: string,
): ResolvedProtectedMountFile | null {
  const normalized = mountedPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  if (slash <= 0) return null;
  const prefix = normalized.slice(0, slash);
  const relativePath = normalized.slice(slash + 1);
  if (!relativePath || !isProtectedMountPrefix(prefix)) return null;

  if (prefix === 'att') {
    const root = paths.agentAttachmentsDir(agentId);
    return {
      prefix,
      relativePath,
      absolutePath: assertInside(root, path.resolve(root, relativePath)),
      context: protectedFileContext.attachment(agentId, relativePath),
      appendOriented: false,
    };
  }
  if (prefix === 'shells') {
    const root = paths.agentShellLogsDir(agentId);
    return {
      prefix,
      relativePath,
      absolutePath: assertInside(root, path.resolve(root, relativePath)),
      context: protectedFileContext.shellLog(agentId, relativePath),
      appendOriented: true,
    };
  }
  const root = paths.memoryDir();
  return {
    prefix,
    relativePath,
    absolutePath: assertInside(root, path.resolve(root, relativePath)),
    context: protectedFileContext.memory(relativePath),
    appendOriented: false,
  };
}

export async function readProtectedMountedFile(
  storage: ProtectedFileStorage | undefined,
  paths: HostPaths,
  agentId: string,
  mountedPath: string,
): Promise<Buffer | null> {
  const resolved = resolveProtectedMountFile(paths, agentId, mountedPath);
  if (!resolved) return null;
  if (resolved.appendOriented && storage) {
    return new ProtectedAppendFileStorage(
      storage,
      resolved.absolutePath,
      resolved.context,
    ).readFile();
  }
  return readPossiblyProtectedFile(
    storage,
    resolved.absolutePath,
    resolved.context,
  );
}

export async function hashProtectedMountedFile(
  storage: ProtectedFileStorage | undefined,
  paths: HostPaths,
  agentId: string,
  mountedPath: string,
): Promise<string | null> {
  const resolved = resolveProtectedMountFile(paths, agentId, mountedPath);
  if (!resolved) return null;
  const fileStat = await stat(resolved.absolutePath);
  if (fileStat.isDirectory()) return null;
  const content = await readProtectedMountedFile(
    storage,
    paths,
    agentId,
    mountedPath,
  );
  return content ? createHash('sha256').update(content).digest('hex') : null;
}

function assertInside(rootPath: string, candidatePath: string): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path traversal outside protected mount');
  }
  return candidate;
}
