import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { SquirrelInstallerNameFixPlugin } from './etc/forge-plugins/squirrel-installer-name-fix';
import { getWindowsSignConfig } from './etc/windows/windowsSign';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import * as buildConstants from './build-constants';
import {
  assertBundledAssetsSafe,
  formatBytes,
} from './src/backend/utils/bundled-assets';
import {
  inspectBundledComponentArtifacts,
  loadBundledComponentRegistry,
  prepareReleaseAttributionBundle,
  resolveElectronRuntimeNoticePaths,
  verifyBundledComponentFixedArtifactBytes,
  verifyBundledComponentSourceBytes,
} from './scripts/release-attribution.mjs';
import { enforceCommunityPostHogUsOnlyInBackend } from './scripts/community-posthog-us-only.mjs';

const isCommunityDistribution =
  buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-unsigned' ||
  buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-observed';

// Community artifacts must remain unsigned even if a developer happens to have
// official Azure signing variables in the ambient environment.
const configuredWindowsSignConfig = getWindowsSignConfig();
const windowsSignConfig = isCommunityDistribution
  ? undefined
  : configuredWindowsSignConfig;

/**
 * Release channel for the build.
 * Set via RELEASE_CHANNEL environment variable in CI workflows.
 *
 * - 'dev': Local development or CI builds on non-release commits
 * - 'nightly': Nightly releases
 * - 'prerelease': Legacy alpha or beta releases (alphaNNN, betaNNN versions)
 * - 'release': Production releases (stable versions without prerelease suffix)
 */

// Log the release channel for debugging
console.log(
  `[forge.config] Release channel: ${buildConstants.__APP_RELEASE_CHANNEL__}`,
);
console.log(
  `[forge.config] Distribution mode: ${buildConstants.__APP_DISTRIBUTION_MODE__}`,
);
const visualAssetChannel =
  buildConstants.__APP_RELEASE_CHANNEL__ === 'prerelease'
    ? 'nightly'
    : buildConstants.__APP_RELEASE_CHANNEL__;
const bundledAssetsPath = path.resolve(__dirname, 'bundled');
const repositoryPath = path.resolve(__dirname, '../..');
const releaseAttributionPath = path.resolve(
  __dirname,
  '.generated',
  'release-attribution',
);
const bundledComponentRegistry = loadBundledComponentRegistry({
  registryPath: path.join(
    repositoryPath,
    'docs/provenance/BUNDLED_COMPONENTS.json',
  ),
  strict: true,
});
const vcRuntimeComponent = (() => {
  const reviewedComponent = bundledComponentRegistry.components.find(
    (component) => component.id === 'vcruntime-cefsharp-140',
  );
  if (!reviewedComponent) {
    throw new Error(
      'Reviewed bundled-component registry has no vcruntime-cefsharp-140 record.',
    );
  }
  return reviewedComponent;
})();
const electronRuntimeNoticePaths = resolveElectronRuntimeNoticePaths({
  appDirectory: __dirname,
});
const allowUnsignedLocalBuild =
  process.env.CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD === 'true';
const useAdhocMacSignature = allowUnsignedLocalBuild || isCommunityDistribution;
const configuredAuthCallbackScheme =
  process.env.CLODEX_AUTH_CALLBACK_SCHEME?.trim().replace(/:$/, '');
const authCallbackScheme = configuredAuthCallbackScheme || 'clodex-ide';
const desktopProtocolSchemes = Array.from(
  // `clodex` remains the non-auth deep-link namespace. Account callbacks use
  // exactly one configured scheme so isolated local builds do not also claim
  // the canonical `clodex-ide://` callback from an installed stable build.
  new Set(['clodex', authCallbackScheme]),
);

prepareReleaseAttributionBundle({
  appDirectory: __dirname,
  outputDirectory: releaseAttributionPath,
  releaseChannel: buildConstants.__APP_RELEASE_CHANNEL__,
  repositoryDirectory: repositoryPath,
});

const resolvePackagerIconPath = (): string => {
  const iconBasePath = path.resolve(
    __dirname,
    `assets/icons/${visualAssetChannel}/icon`,
  );
  if (!useAdhocMacSignature || process.platform !== 'darwin') {
    return `${iconBasePath}.icns`;
  }

  /*
   * Electron Packager probes for a sibling `.icon` asset even when its icon
   * option explicitly points at an `.icns` file. On macOS versions before 26,
   * that makes ad-hoc packaging fail as soon as both formats share a basename.
   * Copy the legacy icon to an isolated basename so Packager can only discover
   * the `.icns` variant. Other builds keep the existing canonical `.icns`
   * path unchanged.
   */
  const localIconDirectory = path.join(
    os.tmpdir(),
    'clodex-electron-packager-icons',
    visualAssetChannel,
  );
  const localIconPath = path.join(localIconDirectory, 'legacy-app.icns');
  fs.mkdirSync(localIconDirectory, { recursive: true });
  fs.rmSync(path.join(localIconDirectory, 'legacy-app.icon'), {
    recursive: true,
    force: true,
  });
  fs.copyFileSync(`${iconBasePath}.icns`, localIconPath);
  return localIconPath;
};

const packagerIconPath = resolvePackagerIconPath();

if (
  allowUnsignedLocalBuild &&
  process.env.CI &&
  buildConstants.__APP_RELEASE_CHANNEL__ !== 'dev'
) {
  throw new Error(
    'CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD is forbidden in CI release builds',
  );
}
if (isCommunityDistribution) {
  console.warn(
    `[forge.config] Building a ${buildConstants.__APP_DISTRIBUTION_MODE__} package with no official Apple or Windows signing identity`,
  );
}
if (
  allowUnsignedLocalBuild &&
  buildConstants.__APP_RELEASE_CHANNEL__ !== 'dev'
) {
  console.warn(
    '[forge.config] Building an unsigned local release-channel package; never distribute this artifact',
  );
}

// DMG volume name (shown when mounted)
const dmgVolumeName = 'Install Clodex Agentic IDE';

// For now, we maintain a manually updated list of dependencies and sub-dependencies that need to be copied over in order to get a working deployed app.
// Ugly but works.
const nativeDependencies = [
  '@libsql',
  'libsql',
  '@neon-rs',
  'promise-limit',
  'js-base64',
  'ws',
  'sharp',
  '@img',
  'detect-libc',
  'node-pty',
  '@xterm/headless',
  'semver',
  'web-tree-sitter',
  '@vscode/tree-sitter-wasm',
  // Rollup leaves Ajv's generated validators as runtime requires in the
  // otherwise self-contained MCP host bundle.
  'ajv',
  'ajv-formats',
];

const copyNativeDependencies = (
  buildPath: string,
  _electronVersion: string,
  _platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  for (const dependency of nativeDependencies) {
    const src = path.resolve(__dirname, `../../node_modules/${dependency}`);
    const dest = path.join(buildPath, 'node_modules', dependency);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      throw new Error(`Missing native dependency ${dependency}`);
    }
  }
  callback();
};

const validateBundledAssets = (
  _buildPath: string,
  _electronVersion: string,
  _platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  try {
    const report = assertBundledAssetsSafe(bundledAssetsPath);
    console.log(
      `[forge.config] Bundled assets validated: ${report.fileCount.toLocaleString('en-US')} files, ${formatBytes(report.totalBytes)}`,
    );
    callback();
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
};

const applyMacApplicationMetadata = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  if (platform !== 'darwin') {
    callback();
    return;
  }

  try {
    const infoPlistPath = path.join(
      buildPath,
      `${buildConstants.__APP_BASE_NAME__}.app`,
      'Contents',
      'Info.plist',
    );
    if (!fs.existsSync(infoPlistPath)) {
      throw new Error(`Packaged Info.plist not found: ${infoPlistPath}`);
    }

    /*
     * Keep CFBundleName aligned with Packager's base name because Electron
     * derives the helper bundle names from it. CFBundleDisplayName provides
     * the user-facing product name without breaking helper discovery.
     */
    execFileSync('/usr/bin/plutil', [
      '-replace',
      'CFBundleDisplayName',
      '-string',
      buildConstants.__APP_NAME__,
      infoPlistPath,
    ]);
    execFileSync('/usr/bin/plutil', [
      '-replace',
      'NSAppleEventsUsageDescription',
      '-string',
      'Clodex uses a bounded, user-approved AppleScript fallback to inspect and press controls in explicitly allowed macOS apps.',
      infoPlistPath,
    ]);
    execFileSync('/usr/bin/plutil', [
      '-replace',
      'NSScreenCaptureUsageDescription',
      '-string',
      'Clodex captures the frontmost app window only during an explicit, visible desktop automation session.',
      infoPlistPath,
    ]);
    console.log(
      `[forge.config] Applied macOS application name: ${buildConstants.__APP_NAME__}`,
    );
    callback();
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
};

const signAdhocMacApplication = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  if (platform !== 'darwin' || !useAdhocMacSignature) {
    callback();
    return;
  }

  try {
    const appPath = path.join(
      buildPath,
      `${buildConstants.__APP_BASE_NAME__}.app`,
    );
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--identifier',
        buildConstants.__APP_BUNDLE_ID__,
        '--requirements',
        `=designated => identifier "${buildConstants.__APP_BUNDLE_ID__}"`,
        appPath,
      ],
      { stdio: 'inherit' },
    );
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      appPath,
    ]);
    console.log(
      `[forge.config] Applied ad-hoc signature for ${buildConstants.__APP_DISTRIBUTION_MODE__} macOS use`,
    );
    callback();
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
};

/**
 * Removes cross-platform prebuilds from native modules after copying.
 *
 * node-pty ships prebuilds for every OS (darwin-arm64, darwin-x64, linux-x64,
 * win32-x64, etc.). When Electron Forge unpacks native modules from the ASAR,
 * ALL prebuilds end up on disk. On Windows, signtool then tries to sign the
 * macOS Mach-O .node files — which fails because signtool only handles PE
 * binaries. Removing non-target prebuilds before packaging avoids this and
 * also shrinks the final bundle.
 */
const pruneNonPlatformPrebuilds = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error) => void,
) => {
  const targetPrefix = `${platform}-${arch}`;
  const prebuildsDir = path.join(
    buildPath,
    'node_modules',
    'node-pty',
    'prebuilds',
  );

  if (!fs.existsSync(prebuildsDir)) {
    callback();
    return;
  }

  try {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      if (entry === targetPrefix) continue;
      const full = path.join(prebuildsDir, entry);
      if (fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(
          `[forge.config] Pruned non-target prebuild: node-pty/prebuilds/${entry}`,
        );
      }
    }
  } catch (err) {
    console.warn('[forge.config] Warning: failed to prune prebuilds:', err);
  }
  callback();
};

/**
 * Copies the exact reviewed x64 VC++ runtime files from
 * VCRuntime.CefSharp.140@1.0.5. The NuGet owner is `havendv`; its metadata
 * names Microsoft as author/copyright holder and declares MIT for the package.
 * The engineering registry does not treat that declaration as a standalone
 * legal conclusion for Microsoft's DLLs. Source and DLL hashes fail closed.
 */

const copyVcRedist = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error) => void,
) => {
  if (platform !== 'win32') {
    callback();
    return;
  }
  if (!vcRuntimeComponent.architectures.some((value) => value === arch)) {
    callback(
      new Error(
        `[forge.config] ${vcRuntimeComponent.id} is not reviewed for ${arch}`,
      ),
    );
    return;
  }

  (async () => {
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcredist-'));
    const nupkgPath = path.join(tmpDir, 'vcruntime.zip');
    const extractDir = path.join(tmpDir, 'extracted');

    try {
      console.log(
        `[forge.config] Downloading pinned VC++ CRT package: ${vcRuntimeComponent.source.url}`,
      );
      const resp = await fetch(vcRuntimeComponent.source.url);
      if (!resp.ok)
        throw new Error(
          `[forge.config] NuGet fetch failed: ${resp.status} ${resp.statusText}`,
        );
      const buf = Buffer.from(await resp.arrayBuffer());
      const archiveVerification = verifyBundledComponentSourceBytes({
        bytes: buf,
        component: vcRuntimeComponent,
      });
      fs.writeFileSync(nupkgPath, buf);
      console.log(
        `[forge.config] Verified ${(buf.length / 1024).toFixed(1)} KB NuGet archive (${archiveVerification.sha256})`,
      );

      fs.mkdirSync(extractDir, { recursive: true });
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${nupkgPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'inherit' },
      );

      const metadataPath = path.join(
        extractDir,
        'VCRuntime.CefSharp.140.nuspec',
      );
      const signaturePath = path.join(extractDir, '.signature.p7s');
      if (!vcRuntimeComponent.metadataEvidence) {
        throw new Error(
          `[forge.config] ${vcRuntimeComponent.id} has no exact NuGet metadata evidence`,
        );
      }
      for (const [label, filePath, expectedHash] of [
        [
          'NuGet metadata',
          metadataPath,
          vcRuntimeComponent.metadataEvidence.sha256,
        ],
        [
          'NuGet signature entry',
          signaturePath,
          vcRuntimeComponent.source.signatureEntrySha256,
        ],
      ] as const) {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          throw new Error(`[forge.config] ${label} is missing: ${filePath}`);
        }
        const actualHash = createHash('sha256')
          .update(fs.readFileSync(filePath))
          .digest('hex');
        if (actualHash !== expectedHash) {
          throw new Error(
            `[forge.config] ${label} hash mismatch: ${actualHash} != ${expectedHash}`,
          );
        }
      }

      const copied: string[] = [];
      if (vcRuntimeComponent.packagedArtifacts.mode !== 'fixed-files') {
        throw new Error(
          `[forge.config] ${vcRuntimeComponent.id} must use fixed-file artifact verification`,
        );
      }
      for (const artifact of vcRuntimeComponent.packagedArtifacts.files) {
        if (!artifact.archivePath) {
          throw new Error(
            `[forge.config] ${vcRuntimeComponent.id} artifact ${artifact.path} has no archive path`,
          );
        }
        const sourcePath = path.join(extractDir, artifact.archivePath);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
          throw new Error(
            `[forge.config] Required VC++ DLL is missing: ${artifact.archivePath}`,
          );
        }
        const bytes = fs.readFileSync(sourcePath);
        verifyBundledComponentFixedArtifactBytes({
          artifact,
          bytes,
          component: vcRuntimeComponent,
        });
        fs.writeFileSync(path.join(buildPath, artifact.path), bytes);
        copied.push(artifact.path);
      }

      inspectBundledComponentArtifacts({
        applicationDirectory: buildPath,
        component: vcRuntimeComponent,
        resourcesDirectory: path.join(buildPath, 'resources'),
      });

      console.log(
        `[forge.config] Copied ${copied.length} VC++ DLL(s): ${copied.join(', ')}`,
      );
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
};

/**
 * After the app source is copied to the packaging directory, inject PostHog
 * source map metadata, upload maps to PostHog for stack trace resolution,
 * then delete .map files so they don't ship to users.
 *
 * Only runs in CI when POSTHOG_CLI_API_KEY is set. The PostHog CLI reads
 * POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, and POSTHOG_CLI_HOST from
 * the environment automatically.
 */
const uploadSourceMapsAndCleanup = (
  buildPath: string,
  _electronVersion: string,
  _platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  const viteDir = path.join(buildPath, '.vite');
  const deleteMapFiles = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) deleteMapFiles(fullPath);
      else if (entry.name.endsWith('.map')) fs.unlinkSync(fullPath);
    }
  };

  if (!buildConstants.__APP_EXCEPTION_TELEMETRY_ENABLED__) {
    if (fs.existsSync(viteDir)) deleteMapFiles(viteDir);
    console.log(
      '[forge.config] Removed source maps because exception telemetry is disabled',
    );
    callback();
    return;
  }

  if (!process.env.CI || !process.env.POSTHOG_CLI_API_KEY) {
    console.log(
      '[forge.config] Skipping source map upload (not in CI or missing POSTHOG_CLI_API_KEY)',
    );
    callback();
    return;
  }

  if (!fs.existsSync(viteDir)) {
    console.log(
      '[forge.config] No .vite directory found, skipping source map upload',
    );
    callback();
    return;
  }

  const version = buildConstants.__APP_VERSION__;

  try {
    console.log(`[forge.config] Injecting source map metadata in ${viteDir}`);
    execSync(`posthog-cli sourcemap inject --directory "${viteDir}"`, {
      stdio: 'inherit',
    });

    console.log(`[forge.config] Uploading source maps for version ${version}`);
    execSync(
      `posthog-cli sourcemap upload --directory "${viteDir}" --release-name clodex --release-version "${version}"`,
      { stdio: 'inherit' },
    );

    deleteMapFiles(viteDir);

    console.log(
      `[forge.config] Source maps uploaded and cleaned up for v${version}`,
    );
    callback();
  } catch (error) {
    console.error('[forge.config] Source map upload failed:', error);
    // Don't fail the build if source map upload fails
    callback();
  }
};

const enforceCommunityPostHogRegionalBoundary = (
  buildPath: string,
  _electronVersion: string,
  _platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  if (!isCommunityDistribution) {
    callback();
    return;
  }

  try {
    const evidence = enforceCommunityPostHogUsOnlyInBackend(buildPath);
    console.log(
      '[forge.config] Enforced US-only Community PostHog boundary across ' +
        `${evidence.filesScanned} backend files ` +
        `(${formatBytes(evidence.bytesScanned)}); rewrote ` +
        `${evidence.replacements.length} known EU origin(s)`,
    );
    callback();
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
};

const config: ForgeConfig = {
  buildIdentifier: buildConstants.__APP_BUILD_IDENTIFIER__,
  packagerConfig: {
    asar: {
      unpack: '**/{sharp,@img,node-pty,web-tree-sitter,@vscode}/**',
    },
    extraResource: [
      './bundled',
      './assets/sounds',
      `./assets/icons/${visualAssetChannel}/icon.png`,
      releaseAttributionPath,
      electronRuntimeNoticePaths.electron,
      electronRuntimeNoticePaths.chromium,
    ],
    prune: true,
    beforeCopyExtraResources: [validateBundledAssets],
    afterCopyExtraResources: [applyMacApplicationMetadata],
    afterCopy: [
      copyNativeDependencies,
      pruneNonPlatformPrebuilds,
      uploadSourceMapsAndCleanup,
      enforceCommunityPostHogRegionalBoundary,
    ],
    afterComplete: [copyVcRedist, signAdhocMacApplication],
    icon: packagerIconPath,
    appCopyright: `Copyright © ${new Date().getFullYear()} Clodex Labs`,
    win32metadata: {
      CompanyName: 'Clodex Labs',
      ProductName: buildConstants.__APP_NAME__,
      FileDescription: buildConstants.__APP_NAME__,
      'requested-execution-level': 'asInvoker',
    },
    name: buildConstants.__APP_BASE_NAME__,
    executableName: buildConstants.__APP_BASE_NAME__,
    appBundleId: buildConstants.__APP_BUNDLE_ID__,
    appVersion: buildConstants.__APP_VERSION__,
    appCategoryType: 'public.app-category.developer-tools',
    ...(buildConstants.__APP_REGISTER_DEFAULT_PROTOCOLS__
      ? {
          protocols: [
            {
              name: 'CLODEx desktop callbacks',
              schemes: desktopProtocolSchemes,
            },
          ],
        }
      : {}),
    // macOS code signing (only for non-dev builds)
    ...(buildConstants.__APP_RELEASE_CHANNEL__ !== 'dev' &&
    !useAdhocMacSignature
      ? {
          osxSign: {
            optionsForFile: (_filePath) => {
              return {
                entitlements: 'etc/macos/entitlements.plist',
                hardenedRuntime: true,
              };
            },
            identity: process.env.APPLE_SIGNING_IDENTITY!,
          },
          osxNotarize: {
            appleId: process.env.APPLE_ID!,
            appleIdPassword: process.env.APPLE_PASSWORD!,
            teamId: process.env.APPLE_TEAM_ID!,
          },
        }
      : {}),
    // Windows code signing via Azure Trusted Signing (only when configured)
    ...(windowsSignConfig ? { windowsSign: windowsSignConfig } : {}),
  },
  rebuildConfig: {
    force: true,
  },
  makers: [
    new MakerSquirrel((arch) => ({
      name: buildConstants.__APP_BASE_NAME__,
      description: buildConstants.__APP_NAME__,
      version: buildConstants.__APP_VERSION__,
      setupExe: `${buildConstants.__APP_BASE_NAME__}-${buildConstants.__APP_VERSION__}-${arch}-setup.exe`,
      copyright: `Copyright © ${new Date().getFullYear()} Clodex Labs`,
      setupIcon: `./assets/icons/${visualAssetChannel}/icon.ico`,
      loadingGif: `./assets/install/${visualAssetChannel}/windows-install-image.gif`,
      title: `Installing ${buildConstants.__APP_NAME__}...`,
      // Windows code signing for the installer (uses same config as packager)
      ...(windowsSignConfig ? { windowsSign: windowsSignConfig } : {}),
    })),
    new MakerRpm({
      options: {
        name: buildConstants.__APP_BASE_NAME__,
        bin: buildConstants.__APP_BASE_NAME__,
        productName: buildConstants.__APP_NAME__,
        genericName: 'Web Browser',
        icon: `./assets/icons/${visualAssetChannel}/icon.png`,
        homepage: buildConstants.__APP_HOMEPAGE__,
        revision: '1',
        categories: ['Development', 'Network', 'Utility'],
      },
    }),
    new MakerDeb({
      options: {
        name: buildConstants.__APP_BASE_NAME__,
        bin: buildConstants.__APP_BASE_NAME__,
        productName: buildConstants.__APP_NAME__,
        genericName: 'Web Browser',
        icon: `./assets/icons/${visualAssetChannel}/icon.png`,
        homepage: buildConstants.__APP_HOMEPAGE__,
        categories: ['Development', 'Network', 'Utility'],
        section: 'devel',
        priority: 'standard',
      },
    }),
    new MakerDMG({
      format: 'UDZO',
      title: dmgVolumeName,
      icon: `./assets/icons/${visualAssetChannel}/icon.icns`,
      additionalDMGOptions: {},
      background: './assets/install/macos-dmg-background.png',
      contents: [
        { x: 448, y: 200, type: 'link', path: '/Applications' },
        {
          x: 192,
          y: 200,
          type: 'file',
          path: `./out/${buildConstants.__APP_BUILD_IDENTIFIER__}/${buildConstants.__APP_BASE_NAME__}-darwin-${buildConstants.__APP_ARCH__}/${buildConstants.__APP_BASE_NAME__}.app`,
          name: `${buildConstants.__APP_NAME__}.app`,
        },
      ],
    }),
    new MakerZIP({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/backend/index.ts',
          config: 'vite.backend.config.ts',
          target: 'main',
        },
        {
          entry: 'src/ui-preload/index.ts',
          config: 'vite.ui-preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/quick-task-preload/index.ts',
          config: 'vite.quick-task-preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/web-content-preload/index.ts',
          config: 'vite.web-content-preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/backend/services/sandbox/sandbox-worker.ts',
          config: 'vite.sandbox-worker.config.ts',
          target: 'main',
        },
        {
          entry: 'src/backend/agent-host/host.ts',
          config: 'vite.agent-host.config.ts',
          target: 'main',
        },
        {
          entry: 'src/backend/mcp-host/host.ts',
          config: 'vite.mcp-host.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.ui.config.ts',
        },
        {
          name: 'pages',
          config: 'vite.pages.config.ts',
        },
      ],
    }),
    // new AutoUnpackNativesPlugin({}),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
    new SquirrelInstallerNameFixPlugin({
      appBaseName: buildConstants.__APP_BASE_NAME__,
      version: buildConstants.__APP_VERSION__,
    }),
  ],
};

export default config;
