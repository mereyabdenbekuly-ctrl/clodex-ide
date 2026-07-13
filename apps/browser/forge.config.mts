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
import { execFileSync, execSync } from 'node:child_process';
import * as buildConstants from './build-constants';
import {
  assertBundledAssetsSafe,
  formatBytes,
} from './src/backend/utils/bundled-assets';

// Get Windows signing configuration (returns undefined if not configured)
const windowsSignConfig = getWindowsSignConfig();

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
const visualAssetChannel =
  buildConstants.__APP_RELEASE_CHANNEL__ === 'prerelease'
    ? 'nightly'
    : buildConstants.__APP_RELEASE_CHANNEL__;
const bundledAssetsPath = path.resolve(__dirname, 'bundled');
const allowUnsignedLocalBuild =
  process.env.CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD === 'true';
const packagerIconPath = path.resolve(
  __dirname,
  `assets/icons/${visualAssetChannel}/icon.icns`,
);

if (allowUnsignedLocalBuild && process.env.CI) {
  throw new Error(
    'CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD is forbidden in CI release builds',
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

const signUnsignedLocalMacApplication = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  if (platform !== 'darwin' || !allowUnsignedLocalBuild) {
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
      ['--force', '--deep', '--sign', '-', appPath],
      { stdio: 'inherit' },
    );
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      appPath,
    ]);
    console.log('[forge.config] Applied ad-hoc signature for local macOS use');
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
 * Downloads the VC++ 2015-2022 runtime DLLs from the official NuGet package
 * (VCRuntime.CefSharp.140, authored and signed by Microsoft) and copies the
 * x64 DLLs next to the packaged executable.
 *
 * Runs as an afterComplete hook — buildPath is the final output directory
 * (e.g. out/clodex-win32-x64/) containing the .exe.
 *
 * Using NuGet guarantees the correct architecture and the latest patch-level
 * DLLs without depending on a VS installation being present on the machine.
 * The .nupkg is a plain ZIP; extraction uses PowerShell's Expand-Archive
 * (built into every Windows install).
 *
 * No-op on non-Windows platforms.
 */

// NuGet package that ships x64 + x86 VC++ 2015-2022 CRT DLLs.
// Authored by Microsoft, package-signed (.signature.p7s included).
const VC_NUPKG_URL =
  'https://api.nuget.org/v3-flatcontainer/vcruntime.cefsharp.140/1.0.5/vcruntime.cefsharp.140.1.0.5.nupkg';

// Paths inside the extracted .nupkg
const VC_NUPKG_X64_DIR = path.join('vc_redist', 'x64');

const VC_REQUIRED_DLLS = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
];
const VC_HARD_REQUIRED = ['vcruntime140.dll', 'msvcp140.dll'];

const copyVcRedist = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  callback: (error?: Error) => void,
) => {
  if (platform !== 'win32') {
    callback();
    return;
  }

  (async () => {
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcredist-'));
    const nupkgPath = path.join(tmpDir, 'vcruntime.zip');
    const extractDir = path.join(tmpDir, 'extracted');

    try {
      console.log(
        `[forge.config] Downloading VC++ CRT DLLs from NuGet: ${VC_NUPKG_URL}`,
      );
      const resp = await fetch(VC_NUPKG_URL);
      if (!resp.ok)
        throw new Error(
          `[forge.config] NuGet fetch failed: ${resp.status} ${resp.statusText}`,
        );
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(nupkgPath, buf);
      console.log(
        `[forge.config] Downloaded ${(buf.length / 1024).toFixed(1)} KB`,
      );

      fs.mkdirSync(extractDir, { recursive: true });
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${nupkgPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'inherit' },
      );

      const srcDir = path.join(extractDir, VC_NUPKG_X64_DIR);
      const missing: string[] = [];
      const copied: string[] = [];

      for (const dll of VC_REQUIRED_DLLS) {
        const src = path.join(srcDir, dll);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(buildPath, dll));
          copied.push(dll);
        } else if (VC_HARD_REQUIRED.includes(dll)) {
          missing.push(dll);
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `[forge.config] Required VC++ DLLs missing in NuGet package: ${missing.join(', ')}`,
        );
      }

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
  if (!process.env.CI || !process.env.POSTHOG_CLI_API_KEY) {
    console.log(
      '[forge.config] Skipping source map upload (not in CI or missing POSTHOG_CLI_API_KEY)',
    );
    callback();
    return;
  }

  const viteDir = path.join(buildPath, '.vite');
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

    // Delete all .map files so they don't ship with the app
    const deleteMapFiles = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) deleteMapFiles(fullPath);
        else if (entry.name.endsWith('.map')) fs.unlinkSync(fullPath);
      }
    };
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

const config: ForgeConfig = {
  buildIdentifier: buildConstants.__APP_RELEASE_CHANNEL__,
  packagerConfig: {
    asar: {
      unpack: '**/{sharp,@img,node-pty,web-tree-sitter,@vscode}/**',
    },
    extraResource: [
      './bundled',
      './assets/sounds',
      `./assets/icons/${visualAssetChannel}/icon.png`,
    ],
    prune: true,
    beforeCopyExtraResources: [validateBundledAssets],
    afterCopyExtraResources: [applyMacApplicationMetadata],
    afterCopy: [
      copyNativeDependencies,
      pruneNonPlatformPrebuilds,
      uploadSourceMapsAndCleanup,
    ],
    afterComplete: [
      copyVcRedist, // sources DLLs directly from VS install on the runner
      signUnsignedLocalMacApplication,
    ],
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
    protocols: [
      {
        name: 'clodex',
        schemes: ['clodex'],
      },
    ],
    // macOS code signing (only for non-dev builds)
    ...(buildConstants.__APP_RELEASE_CHANNEL__ !== 'dev' &&
    !allowUnsignedLocalBuild
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
          path: `./out/${buildConstants.__APP_RELEASE_CHANNEL__}/${buildConstants.__APP_BASE_NAME__}-darwin-${buildConstants.__APP_ARCH__}/${buildConstants.__APP_BASE_NAME__}.app`,
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
