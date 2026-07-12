import path from 'node:path';
import type { WorkspaceInfo } from './index';

/**
 * Formats workspace info into a human-readable markdown summary.
 * Useful for providing context to agents about the project structure.
 */
export function formatWorkspaceInfoMarkdown(
  workspaceInfo: WorkspaceInfo,
): string {
  const lines: string[] = [];

  // Basic info
  if (workspaceInfo.packageManager) {
    lines.push(`- **Package Manager**: ${workspaceInfo.packageManager}`);
  }
  if (workspaceInfo.isLikelyMonorepo) {
    lines.push('- **Project Type**: Monorepo');
  }
  if (workspaceInfo.gitRepoRoot) {
    lines.push(`- **Git Root**: ${workspaceInfo.gitRepoRoot}`);
  }

  // Packages summary
  if (workspaceInfo.packagesInRepo.length > 0) {
    lines.push('');
    lines.push('### Detected Packages');
    lines.push('');

    for (const pkg of workspaceInfo.packagesInRepo) {
      const relativePath = workspaceInfo.gitRepoRoot
        ? path.relative(workspaceInfo.gitRepoRoot, pkg.path)
        : pkg.path;
      const allDeps = [
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      ];
      const uniqueDepNames = [...new Set(allDeps.map((d) => d.name))];

      lines.push(
        `- **${pkg.name}** (${relativePath})${pkg.version ? ` v${pkg.version}` : ''}`,
      );
      if (uniqueDepNames.length > 0) {
        lines.push(
          `  - Key deps: ${uniqueDepNames.slice(0, 10).join(', ')}${uniqueDepNames.length > 10 ? '...' : ''}`,
        );
      }
    }
  }

  return lines.join('\n');
}
