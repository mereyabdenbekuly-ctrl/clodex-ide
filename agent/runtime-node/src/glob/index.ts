import type {
  FileSystemOperations,
  GlobResult,
  GlobOptions,
} from '../types.js';
import { globWithRipgrep } from './glob-ripgrep.js';
import { globNodeFallback } from './glob-node-fallback.js';

export async function glob(
  fileSystem: FileSystemOperations,
  pattern: string,
  rgBinaryBasePath: string,
  options?: GlobOptions,
): Promise<GlobResult> {
  const ripgrepResult = await globWithRipgrep(
    fileSystem,
    pattern,
    rgBinaryBasePath,
    options,
  );
  if (ripgrepResult !== null) return ripgrepResult;
  return globNodeFallback(pattern, fileSystem, options);
}
