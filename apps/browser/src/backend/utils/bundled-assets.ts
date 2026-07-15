import fs from 'node:fs';
import path from 'node:path';

const MAX_REPORTED_ISSUES = 25;
const RESERVED_ROOT_ENTRY_PREFIXES = ['.eslint-server-'];

export interface BundledAssetsPolicy {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  forbiddenDirectoryNames: ReadonlySet<string>;
}

export interface BundledAssetIssue {
  message: string;
  path: string;
}

export interface BundledAssetsReport {
  fileCount: number;
  issues: BundledAssetIssue[];
  omittedIssueCount: number;
  root: string;
  totalBytes: number;
}

export const DEFAULT_BUNDLED_ASSETS_POLICY: BundledAssetsPolicy = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 5_000,
  maxTotalBytes: 100 * 1024 * 1024,
  forbiddenDirectoryNames: new Set([
    '.git',
    '.venv',
    '__pycache__',
    'env',
    'node_modules',
    'venv',
  ]),
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function toRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function inspectBundledAssets(
  root: string,
  policy: BundledAssetsPolicy = DEFAULT_BUNDLED_ASSETS_POLICY,
): BundledAssetsReport {
  const absoluteRoot = path.resolve(root);
  const issues: BundledAssetIssue[] = [];
  let omittedIssueCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const addIssue = (absolutePath: string, message: string): void => {
    if (issues.length < MAX_REPORTED_ISSUES) {
      issues.push({
        message,
        path: toRelativePath(absoluteRoot, absolutePath) || '.',
      });
    } else {
      omittedIssueCount++;
    }
  };

  if (!fs.existsSync(absoluteRoot)) {
    addIssue(absoluteRoot, 'Bundled assets directory does not exist');
    return {
      fileCount,
      issues,
      omittedIssueCount,
      root: absoluteRoot,
      totalBytes,
    };
  }

  const walk = (directory: string, reportNestedIssues = true): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      addIssue(
        directory,
        `Directory cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const isReservedRootEntry =
        directory === absoluteRoot &&
        RESERVED_ROOT_ENTRY_PREFIXES.some((prefix) =>
          entry.name.startsWith(prefix),
        );
      if (reportNestedIssues && isReservedRootEntry) {
        addIssue(
          absolutePath,
          'Reserved ESLint build work state is forbidden in packaged bundled assets',
        );
      }

      if (entry.isSymbolicLink()) {
        if (reportNestedIssues) {
          addIssue(
            absolutePath,
            'Symbolic links are forbidden in bundled assets',
          );
        }
        continue;
      }

      if (entry.isDirectory()) {
        const isForbidden = policy.forbiddenDirectoryNames.has(entry.name);
        if (reportNestedIssues && isForbidden) {
          addIssue(
            absolutePath,
            `Directory "${entry.name}" is forbidden in bundled assets`,
          );
        }
        // A forbidden directory is already actionable. Continue counting its
        // contents for the global budgets, but avoid flooding the report with
        // every cache or dependency directory nested inside it.
        walk(
          absolutePath,
          reportNestedIssues && !isForbidden && !isReservedRootEntry,
        );
        continue;
      }

      if (!entry.isFile()) {
        if (reportNestedIssues) {
          addIssue(
            absolutePath,
            'Only regular files and directories are allowed in bundled assets',
          );
        }
        continue;
      }

      let size: number;
      try {
        size = fs.statSync(absolutePath).size;
      } catch (error) {
        addIssue(
          absolutePath,
          `File cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      fileCount++;
      totalBytes += size;

      if (reportNestedIssues && size > policy.maxFileBytes) {
        addIssue(
          absolutePath,
          `File size ${formatBytes(size)} exceeds the ${formatBytes(policy.maxFileBytes)} per-file limit`,
        );
      }
    }
  };

  walk(absoluteRoot);

  if (fileCount > policy.maxFiles) {
    addIssue(
      absoluteRoot,
      `File count ${fileCount.toLocaleString('en-US')} exceeds the ${policy.maxFiles.toLocaleString('en-US')} limit`,
    );
  }

  if (totalBytes > policy.maxTotalBytes) {
    addIssue(
      absoluteRoot,
      `Total size ${formatBytes(totalBytes)} exceeds the ${formatBytes(policy.maxTotalBytes)} limit`,
    );
  }

  return {
    fileCount,
    issues,
    omittedIssueCount,
    root: absoluteRoot,
    totalBytes,
  };
}

export function formatBundledAssetsFailure(
  report: BundledAssetsReport,
): string {
  const details = report.issues.map(
    (issue) => `  - ${issue.path}: ${issue.message}`,
  );
  if (report.omittedIssueCount > 0) {
    details.push(
      `  - ...and ${report.omittedIssueCount.toLocaleString('en-US')} more issue(s)`,
    );
  }

  return [
    `Bundled asset validation failed for ${report.root}:`,
    ...details,
    '',
    'Move local checkouts and virtual environments outside apps/browser/bundled.',
    'Use external runtime configuration such as OPENMANUS_HOME, or add a',
    'reproducible platform-specific artifact pipeline before shipping a runtime.',
  ].join('\n');
}

export function assertBundledAssetsSafe(
  root: string,
  policy: BundledAssetsPolicy = DEFAULT_BUNDLED_ASSETS_POLICY,
): BundledAssetsReport {
  const report = inspectBundledAssets(root, policy);
  if (report.issues.length > 0 || report.omittedIssueCount > 0) {
    throw new Error(formatBundledAssetsFailure(report));
  }
  return report;
}
