#!/usr/bin/env tsx

/**
 * Cleanup script for clodex browser app local data
 *
 * This script removes all local data directories used by the Electron app,
 * including userData and temp directories for both production and development builds.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function getAppDataPath(): string {
  const platform = process.platform;
  const homeDir = os.homedir();

  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    case 'linux':
      return process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function getTempPath(): string {
  return os.tmpdir();
}

async function deleteDirectory(dirPath: string): Promise<boolean> {
  try {
    const exists = await fs
      .access(dirPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      log(`  ⊘ Directory does not exist: ${dirPath}`, colors.yellow);
      return false;
    }

    await fs.rm(dirPath, { recursive: true, force: true });
    log(`  ✓ Deleted: ${dirPath}`, colors.green);
    return true;
  } catch (error) {
    log(
      `  ✗ Failed to delete ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
      colors.red,
    );
    return false;
  }
}

async function cleanTempWorkspaces(tempBasePath: string): Promise<number> {
  let deletedCount = 0;
  try {
    const workspacesPath = path.join(tempBasePath, 'workspaces');
    const exists = await fs
      .access(workspacesPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      log(
        `  ⊘ Temp workspaces directory does not exist: ${workspacesPath}`,
        colors.yellow,
      );
      return 0;
    }

    const entries = await fs.readdir(workspacesPath);
    for (const entry of entries) {
      const entryPath = path.join(workspacesPath, entry);
      const deleted = await deleteDirectory(entryPath);
      if (deleted) deletedCount++;
    }

    // Also delete the parent workspaces directory if it's now empty
    await deleteDirectory(workspacesPath);
  } catch (error) {
    log(
      `  ⚠ Error cleaning temp workspaces: ${error instanceof Error ? error.message : String(error)}`,
      colors.yellow,
    );
  }
  return deletedCount;
}

async function main() {
  log('\n🧹 Clodex Browser Data Cleanup', colors.cyan);
  log('='.repeat(50), colors.cyan);

  const appDataPath = getAppDataPath();
  const tempPath = getTempPath();

  log(`\nDetected platform: ${process.platform}`, colors.blue);
  log(`App data base path: ${appDataPath}`, colors.blue);
  log(`Temp base path: ${tempPath}`, colors.blue);

  const pathsToClean = {
    'Production userData': path.join(appDataPath, 'clodex'),
    'Development userData': path.join(appDataPath, 'clodex-dev'),
  };

  log('\n📂 Cleaning userData directories...', colors.cyan);
  let deletedCount = 0;
  for (const [label, dirPath] of Object.entries(pathsToClean)) {
    log(`\n${label}:`, colors.blue);
    const deleted = await deleteDirectory(dirPath);
    if (deleted) deletedCount++;
  }

  log('\n📂 Cleaning temp workspace directories...', colors.cyan);
  log('\nProduction temp workspaces:', colors.blue);
  const prodTempDeleted = await cleanTempWorkspaces(
    path.join(tempPath, 'clodex'),
  );
  log('\nDevelopment temp workspaces:', colors.blue);
  const devTempDeleted = await cleanTempWorkspaces(
    path.join(tempPath, 'clodex-dev'),
  );

  log(`\n${'='.repeat(50)}`, colors.cyan);
  log(
    `\n✓ Cleanup complete! Deleted ${deletedCount} userData directories and ${prodTempDeleted + devTempDeleted} temp workspace directories.`,
    colors.green,
  );
  log(
    '\nNote: The application will recreate these directories on next launch.\n',
    colors.yellow,
  );
}

main().catch((error) => {
  log(
    `\n✗ Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    colors.red,
  );
  process.exit(1);
});
