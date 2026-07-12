import type {
  FileSystemOperations,
  GrepOptions,
  GrepResult,
} from '../types.js';
import { grepNodeFallback } from './grep-node-fallback.js';
import { grepWithRipgrep } from './grep-ripgrep.js';

export async function grep(
  fileSystem: FileSystemOperations,
  pattern: string,
  rgBinaryBasePath: string,
  options?: GrepOptions,
): Promise<GrepResult> {
  const ripgrepResult = await grepWithRipgrep(
    fileSystem,
    pattern,
    rgBinaryBasePath,
    options,
  );
  if (ripgrepResult !== null) return ripgrepResult;
  return grepNodeFallback(fileSystem, pattern, options);
}
