import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkClodexBoundaries } from './check-clodex-boundaries.mjs';

const packageNames = {
  'clodex-contracts': '@clodex/contracts',
  'clodex-evidence': '@clodex/evidence',
  'clodex-guardian': '@clodex/guardian',
  'clodex-kernel': '@clodex/kernel',
  'clodex-ledger': '@clodex/ledger',
  'clodex-runtime': '@clodex/runtime',
};
const allowedInternalDependencies = {
  'clodex-contracts': [],
  'clodex-evidence': ['clodex-contracts'],
  'clodex-guardian': ['clodex-contracts'],
  'clodex-kernel': ['clodex-contracts'],
  'clodex-ledger': ['clodex-contracts'],
  'clodex-runtime': [
    'clodex-contracts',
    'clodex-evidence',
    'clodex-guardian',
    'clodex-kernel',
    'clodex-ledger',
  ],
};

function fixture(packages) {
  const root = mkdtempSync(join(tmpdir(), 'clodex-boundaries-'));
  const components = {};
  const lockImporters = {};
  const lockPackages = {};
  const lockSnapshots = {};
  for (const [name, packageName] of Object.entries(packageNames)) {
    components[name] = {
      status: 'independent',
      owner: 'test',
      paths: [`packages/${name}/**`],
      package_name: packageName,
      allowed_internal_dependencies: allowedInternalDependencies[name],
      allowed_external_dependencies: [],
      allowed_builtins: [],
      allowed_typescript_libs: ['es2022'],
      allowed_typescript_types: [],
      enforce_dependency_allowlist: true,
    };
  }
  mkdirSync(join(root, 'docs', 'provenance'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    JSON.stringify({ packages: ['packages/*'] }),
  );
  writeFileSync(
    join(root, 'docs', 'provenance', 'components.yml'),
    JSON.stringify({
      version: 1,
      common_development_dependencies: [
        '@clodex/typescript-config',
        '@types/node',
        'typescript',
        'vitest',
      ],
      components,
    }),
  );
  for (const [name, value] of Object.entries(packages)) {
    const packageRoot = join(root, 'packages', name);
    const source = typeof value === 'string' ? value : value.source;
    const filename = typeof value === 'string' ? 'index.ts' : value.filename;
    const manifest = typeof value === 'string' ? {} : (value.packageJson ?? {});
    const developmentOnlySource =
      /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename) ||
      /(?:^|[/\\])(?:__tests__|test|tests)(?:[/\\]|$)/u.test(filename) ||
      /\.config\.[cm]?[jt]s$/u.test(filename);
    const defaultEntrypoint = developmentOnlySource ? 'index.ts' : filename;
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(join(packageRoot, 'src', filename), source);
    if (defaultEntrypoint !== filename) {
      writeFileSync(
        join(packageRoot, 'src', defaultEntrypoint),
        'export {};\n',
      );
    }
    const packageManifest = {
      name: packageNames[name] ?? `@clodex/${name}`,
      exports: `./src/${defaultEntrypoint}`,
      ...manifest,
    };
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify(packageManifest),
    );
    writeFileSync(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ES2022'],
          types: [],
        },
        include: ['src'],
      }),
    );
    const importer = {};
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const entries = Object.entries(packageManifest[field] ?? {});
      if (entries.length === 0) continue;
      importer[field] = {};
      for (const [dependency, specifier] of entries) {
        const targetDirectory = Object.entries(packageNames).find(
          ([, packageName]) => packageName === dependency,
        )?.[0];
        let version = specifier;
        if (targetDirectory) {
          version = `link:../${targetDirectory}`;
        } else if (dependency === '@clodex/typescript-config') {
          version = 'link:../typescript-config';
        }
        importer[field][dependency] = { specifier, version };
        if (
          typeof version === 'string' &&
          !version.startsWith('.') &&
          !/^(?:file|git|github|gitlab|bitbucket|https?|link|npm|patch|portal|workspace):/u.test(
            version,
          ) &&
          !dependency.startsWith('@clodex/')
        ) {
          const packageKey = `${dependency}@${version.split('(')[0]}`;
          lockPackages[packageKey] = {
            resolution: { integrity: 'sha512-test' },
          };
          lockSnapshots[`${dependency}@${version}`] = {};
        }
      }
    }
    lockImporters[`packages/${name}`] = importer;
  }
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    JSON.stringify({
      importers: lockImporters,
      lockfileVersion: '9.0',
      packages: lockPackages,
      snapshots: lockSnapshots,
    }),
  );
  return root;
}

test('accepts a dependency-free contracts package', () => {
  const root = fixture({
    'clodex-contracts': 'export type TaskId = string;\n',
  });
  assert.deepEqual(checkClodexBoundaries(root), []);
});

test('ignores import-looking comments', () => {
  const root = fixture({
    'clodex-contracts': "// import { app } from 'electron';\nexport {};\n",
  });
  assert.deepEqual(checkClodexBoundaries(root), []);
});

test('allows declared test-only dependencies without weakening production rules', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.test.ts',
      source:
        "import test from 'node:test';\nimport { expect } from 'vitest';\n",
      packageJson: {
        devDependencies: {
          vitest: '^3.2.4',
        },
      },
    },
  });
  assert.deepEqual(checkClodexBoundaries(root), []);
});

test('applies production rules to dev-named files reachable from an entrypoint', () => {
  const root = fixture({
    'clodex-contracts': "export { readConfig } from './runtime.config';\n",
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'src', 'runtime.config.ts'),
    "import { readFileSync } from 'node:fs';\nexport const readConfig = readFileSync;\n",
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /builtin "node:fs" is not allowlisted/u);
});

test('rejects platform imports from all supported source extensions', () => {
  const root = fixture({
    'clodex-runtime': {
      filename: 'index.mts',
      source:
        "import { app } from 'electron';\nimport React from 'react';\nimport '@clodex/stage-ui';\n",
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => /forbidden platform import/u.test(error)));
});

test('rejects dynamic imports, requires, and independent subpath bypasses', () => {
  const root = fixture({
    'clodex-contracts':
      "await import('@clodex/runtime/private');\nrequire('@clodex/kernel');\n",
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /cannot depend/u.test(error)));
});

test('rejects non-literal module loading', () => {
  const root = fixture({
    'clodex-contracts':
      "const target = '@clodex/agent-core';\nawait import(target);\nrequire(target);\nrequire.resolve(target);\n",
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 3);
  assert.ok(
    errors.every((error) =>
      /non-literal module loading is not allowed/u.test(error),
    ),
  );
});

test('rejects alternate CommonJS loaders and dynamic code evaluation', () => {
  const root = fixture({
    'clodex-contracts':
      "module.require('../../agent-core');\nmodule['require']('../../agent-core');\nrequire['resolve']('../../agent-core');\neval(\"require('../../agent-core')\");\n(0, eval)(\"require('../../agent-core')\");\nnew Function('return process')();\n",
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 6);
  assert.equal(
    errors.filter((error) => /relative import escapes/u.test(error)).length,
    3,
  );
  assert.equal(
    errors.filter((error) =>
      /dynamic code evaluation is not allowed/u.test(error),
    ).length,
    3,
  );
});

test('rejects import types and triple-slash type references', () => {
  const root = fixture({
    'clodex-contracts':
      '/// <reference types="electron" />\nexport type Window = import(\'electron\').BrowserWindow;\n',
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /forbidden platform import/u.test(error)));
});

test('rejects unallowlisted TypeScript lib references', () => {
  const root = fixture({
    'clodex-contracts':
      '/// <reference lib="dom" />\nexport type BrowserWindow = Window;\n',
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /TypeScript lib "dom" is not allowlisted/u);
});

test('rejects legacy Clodex dependencies in source and package manifests', () => {
  const root = fixture({
    'clodex-runtime': {
      filename: 'index.cts',
      source: "import '@clodex/agent-core';\n",
      packageJson: {
        dependencies: {
          '@clodex/agent-shell': 'workspace:*',
        },
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every((error) =>
      /legacy or undeclared Clodex dependency/u.test(error),
    ),
  );
});

test('rejects local and aliased dependency sources', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
    'clodex-kernel': {
      filename: 'index.ts',
      source: "import type { TaskId } from '@clodex/contracts';\n",
      packageJson: {
        dependencies: {
          '@clodex/contracts': 'file:../../apps/browser',
          zod: 'npm:@clodex/agent-core@0.0.0',
        },
      },
    },
  });
  const registryPath = join(root, 'docs', 'provenance', 'components.yml');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.components['clodex-kernel'].allowed_external_dependencies = ['zod'];
  writeFileSync(registryPath, JSON.stringify(registry));
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 3);
  assert.ok(
    errors.some((error) => /independent workspace specifier/u.test(error)),
  );
  assert.ok(
    errors.some((error) => /registry version or dist-tag/u.test(error)),
  );
  assert.ok(errors.some((error) => /resolves through a local/u.test(error)));
});

test('rejects root dependency-source redirects', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      pnpm: {
        overrides: {
          zod: 'file:apps/browser',
        },
      },
      private: true,
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must not redirect dependencies/u);
});

test('rejects workspace dependency-source redirects', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    JSON.stringify({
      overrides: {
        zod: 'file:apps/browser',
      },
      packages: ['packages/*'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must not redirect dependencies/u);
});

test('rejects pnpm manifest-rewrite hooks', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  writeFileSync(join(root, '.pnpmfile.cjs'), 'module.exports = {};\n');
  writeFileSync(
    join(root, '.npmrc'),
    [
      'pnpmfile=./hooks.cjs',
      'config-dependencies.plugin=1.0.0',
      '"pnpmfile" = ./quoted-hooks.cjs',
      'global-pnpmfile=./global-hooks.cjs',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      pnpm: {
        configDependencies: {
          'pnpm-plugin-root': '1.0.0',
        },
      },
      private: true,
    }),
  );
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    JSON.stringify({
      configDependencies: {
        'pnpm-plugin-workspace': '1.0.0',
      },
      packages: ['packages/*'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 7);
  assert.equal(
    errors.filter((error) => /manifest-rewrite hooks/u.test(error)).length,
    7,
  );
});

test('rejects local lock importer resolutions', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        dependencies: {
          zod: '1.0.0',
        },
      },
    },
  });
  const registryPath = join(root, 'docs', 'provenance', 'components.yml');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.components['clodex-contracts'].allowed_external_dependencies = [
    'zod',
  ];
  writeFileSync(registryPath, JSON.stringify(registry));
  const lockPath = join(root, 'pnpm-lock.yaml');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.importers['packages/clodex-contracts'].dependencies.zod.version =
    'link:../../apps/browser';
  writeFileSync(lockPath, JSON.stringify(lock));
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /resolves through a local/u);
});

test('rejects local package records behind safe lock versions', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        dependencies: {
          zod: '1.0.0',
        },
      },
    },
  });
  const registryPath = join(root, 'docs', 'provenance', 'components.yml');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.components['clodex-contracts'].allowed_external_dependencies = [
    'zod',
  ];
  writeFileSync(registryPath, JSON.stringify(registry));
  const lockPath = join(root, 'pnpm-lock.yaml');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages['zod@1.0.0'].resolution = {
    directory: 'apps/browser',
    type: 'directory',
  };
  writeFileSync(lockPath, JSON.stringify(lock));
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lacks an integrity-only registry resolution/u);
});

test('allows only inward independent-package dependencies', () => {
  const root = fixture({
    'clodex-contracts': 'export type TaskId = string;\n',
    'clodex-kernel': "import type { TaskId } from '@clodex/contracts';\n",
    'clodex-runtime':
      "import type { TaskId } from '@clodex/contracts';\nimport '@clodex/kernel';\n",
  });
  assert.deepEqual(checkClodexBoundaries(root), []);
});

test('rejects relative imports that escape a package', () => {
  const root = fixture({
    'clodex-contracts': "export * from '../../legacy';\n",
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /relative import escapes/u);
});

test('rejects unregistered clodex package directories', () => {
  const root = fixture({
    'clodex-unknown': 'export {};\n',
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no independent component policy/u);
});

test('rejects tsconfig path aliases in independent packages', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2022'],
        paths: {
          '@clodex/contracts': ['../../apps/browser/index.ts'],
        },
        types: [],
      },
      include: ['src'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /compilerOptions\.paths is not allowed/u);
});

test('rejects TypeScript baseUrl shadowing', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: "export * from 'zod';\n",
      packageJson: {
        dependencies: {
          zod: '^3.0.0',
        },
      },
    },
  });
  mkdirSync(join(root, 'packages', 'clodex-contracts', 'tests'), {
    recursive: true,
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tests', 'zod.ts'),
    "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
  );
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: 'tests',
        lib: ['ES2022'],
        types: [],
      },
      include: ['src', 'tests'],
    }),
  );
  const registryPath = join(root, 'docs', 'provenance', 'components.yml');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.components['clodex-contracts'].allowed_external_dependencies = [
    'zod',
  ];
  writeFileSync(registryPath, JSON.stringify(registry));
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /compilerOptions\.baseUrl is not allowed/u);
});

test('rejects TypeScript resolution and source escapes', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  const legacyRoot = join(root, 'apps', 'browser');
  mkdirSync(join(legacyRoot, 'types'), { recursive: true });
  writeFileSync(join(legacyRoot, 'legacy.ts'), 'export {};\n');
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2022'],
        rootDirs: ['src', '../../apps/browser'],
        typeRoots: ['../../apps/browser/types'],
        types: [],
      },
      include: ['src', '../../apps/browser/legacy.ts'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => /rootDirs is not allowed/u.test(error)));
  assert.ok(errors.some((error) => /typeRoots escapes/u.test(error)));
  assert.ok(errors.some((error) => /includes source outside/u.test(error)));
});

test('rejects TypeScript module suffix resolution', () => {
  const root = fixture({
    'clodex-contracts': "export * from './runtime';\n",
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'src', 'runtime.config.ts'),
    "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
  );
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2022'],
        moduleSuffixes: ['.config', ''],
        types: [],
      },
      include: ['src'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /moduleSuffixes is not allowed/u);
});

test('requires explicit TypeScript ambient types and allowlisted libs', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['DOM'],
      },
      include: ['src'],
    }),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /TypeScript lib "dom"/u.test(error)));
  assert.ok(
    errors.some((error) =>
      /compilerOptions\.types must be explicit/u.test(error),
    ),
  );
});

test('rejects package entrypoints that escape the independent package', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        exports: {
          '.': '../../apps/browser/index.ts',
        },
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must use a package-relative target/u);
});

test('rejects package browser and typesVersions aliases', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        browser: {
          './src/index.ts': '../../apps/browser/index.ts',
        },
        typesVersions: {
          '*': {
            '*': ['../../apps/browser/*'],
          },
        },
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 2);
  assert.ok(
    errors.some((error) => /browser aliases are not allowed/u.test(error)),
  );
  assert.ok(
    errors.some((error) =>
      /typesVersions aliases are not allowed/u.test(error),
    ),
  );
});

test('rejects package entrypoints in ignored generated directories', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        exports: './dist/index.js',
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /targets an ignored generated directory/u);
});

test('rejects wildcard package entrypoints', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        exports: {
          './*': './src/*.config.ts',
        },
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /wildcard entrypoints are not allowed/u);
});

test('rejects package entrypoints outside scanned source types', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'index.ts',
      source: 'export {};\n',
      packageJson: {
        bin: './bin/tool',
      },
    },
  });
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must target a scanned JavaScript or TypeScript/u);
});

test('treats root package entrypoints as production source', () => {
  const root = fixture({
    'clodex-contracts': {
      filename: 'placeholder.ts',
      source: 'export {};\n',
      packageJson: {
        exports: './index.ts',
      },
    },
  });
  writeFileSync(
    join(root, 'packages', 'clodex-contracts', 'index.ts'),
    "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /builtin "node:fs" is not allowlisted/u);
});

test('rejects symlinks in independent packages', () => {
  const root = fixture({
    'clodex-contracts': 'export {};\n',
  });
  const target = join(root, 'legacy.ts');
  writeFileSync(target, 'export const legacy = true;\n');
  symlinkSync(
    target,
    join(root, 'packages', 'clodex-contracts', 'src', 'legacy.ts'),
  );
  const errors = checkClodexBoundaries(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /symlinks are not allowed/u);
});
