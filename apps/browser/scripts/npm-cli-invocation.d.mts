export interface NpmCliInvocationOptions {
  existsSyncImpl?: (filePath: string) => boolean;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}

export function resolveNpmCliPath(options?: NpmCliInvocationOptions): string;

export function buildNpmCliInvocation(options?: NpmCliInvocationOptions): {
  arguments: string[];
  command: string;
};
