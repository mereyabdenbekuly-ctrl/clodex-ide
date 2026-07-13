import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const registryPath = 'docs/provenance/components.yml';
const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const ignoredDirectories = new Set([
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const builtins = new Set([
  ...builtinModules.flatMap((name) => [name, name.replace(/^node:/u, '')]),
  'test',
]);

function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot);
}

function packageDirectoryFromComponent(component) {
  for (const pattern of [
    ...(component.paths ?? []),
    ...(component.planned_paths ?? []),
  ]) {
    const match = /^packages\/([^/*]+)\/\*\*$/u.exec(pattern);
    if (match) return match[1];
  }
  return null;
}

function loadRegistry(rootDirectory) {
  const file = join(rootDirectory, registryPath);
  const document = JSON.parse(readFileSync(file, 'utf8'));
  if (document.version !== 1 || !document.components) {
    throw new Error(`${registryPath}: unsupported or invalid registry`);
  }

  const policiesByDirectory = new Map();
  const policiesByPackageName = new Map();
  for (const [id, component] of Object.entries(document.components)) {
    if (component.status !== 'independent') continue;
    const packageDirectory = packageDirectoryFromComponent(component);
    if (!packageDirectory || !component.package_name) {
      throw new Error(
        `${registryPath}: independent component ${id} needs a package path and package_name`,
      );
    }
    const policy = {
      id,
      packageDirectory,
      packageName: component.package_name,
      allowedInternal: new Set(component.allowed_internal_dependencies ?? []),
      allowedExternal: new Set(component.allowed_external_dependencies ?? []),
      allowedBuiltins: new Set(component.allowed_builtins ?? []),
      allowedTypeScriptLibs: new Set(component.allowed_typescript_libs ?? []),
      allowedTypeScriptTypes: new Set(component.allowed_typescript_types ?? []),
    };
    policiesByDirectory.set(packageDirectory, policy);
    policiesByPackageName.set(policy.packageName, policy);
  }

  return {
    allowedDevelopmentDependencies: new Set(
      document.common_development_dependencies ?? [],
    ),
    components: document.components,
    policiesByDirectory,
    policiesByPackageName,
  };
}

function walk(directory, context) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      context.errors.push(
        `${relative(context.rootDirectory, path)}: symlinks are not allowed in independent packages`,
      );
      continue;
    }
    if (stat.isDirectory()) files.push(...walk(path, context));
    else if (sourceExtensions.has(extensionOf(path))) files.push(path);
  }
  return files;
}

function isStringModuleSpecifier(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];
  function add(
    node,
    position = node?.getStart(sourceFile) ?? 0,
    invalidReason = 'non-literal module loading is not allowed',
  ) {
    if (node && isStringModuleSpecifier(node)) {
      specifiers.push({
        kind: 'module',
        position: node.getStart(sourceFile),
        value: node.text,
      });
    } else {
      specifiers.push({
        invalidReason,
        kind: 'module',
        position,
        value: null,
      });
    }
  }
  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      (node.text === 'eval' || node.text === 'Function')
    ) {
      add(
        null,
        node.getStart(sourceFile),
        'dynamic code evaluation is not allowed',
      );
    }
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const elementName = ts.isElementAccessExpression(node.expression)
        ? node.expression.argumentExpression
        : null;
      const elementNameText =
        elementName && isStringModuleSpecifier(elementName)
          ? elementName.text
          : null;
      const loadsModule =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'require' ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === 'require'))) ||
        (ts.isElementAccessExpression(node.expression) &&
          (elementNameText === 'require' ||
            (ts.isIdentifier(node.expression.expression) &&
              (node.expression.expression.text === 'module' ||
                node.expression.expression.text === 'require'))));
      if (loadsModule) {
        add(node.arguments[0], node.expression.getStart(sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  for (const reference of sourceFile.typeReferenceDirectives) {
    specifiers.push({
      kind: 'module',
      position: reference.pos,
      value: reference.fileName,
    });
  }
  for (const reference of sourceFile.referencedFiles) {
    specifiers.push({
      kind: 'module',
      position: reference.pos,
      value: reference.fileName,
    });
  }
  for (const reference of sourceFile.libReferenceDirectives) {
    specifiers.push({
      kind: 'typescript-lib',
      position: reference.pos,
      value: reference.fileName.toLowerCase(),
    });
  }
  return specifiers;
}

function isLegacyImport(specifier) {
  return (
    specifier === '@clodex/karton' ||
    specifier.startsWith('@clodex/karton/') ||
    specifier === '@clodex/stage-ui' ||
    specifier.startsWith('@clodex/stage-ui/') ||
    specifier === 'apps/browser' ||
    specifier.startsWith('apps/browser/') ||
    specifier.startsWith('@stagewise/')
  );
}

function isPlatformImport(specifier) {
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-dom' ||
    specifier.startsWith('react-dom/')
  );
}

function isPackageImport(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

function externalRoot(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function isBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/u, '').split('/')[0];
  return builtins.has(normalized);
}

function isRegistryDependencySpec(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('.') &&
    !/[/:\\$]/u.test(value)
  );
}

function isWorkspaceDependencySpec(value) {
  return value === 'workspace:*';
}

function isDevelopmentCandidate(file, packageRoot) {
  const path = relative(packageRoot, file);
  const name = basename(file);
  return (
    /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(name) ||
    /(?:^|[/\\])(?:__tests__|test|tests)(?:[/\\]|$)/u.test(path) ||
    /\.config\.[cm]?[jt]s$/u.test(name) ||
    /^(?:build|postinstall|prepare|preinstall)\.[cm]?[jt]s$/u.test(name) ||
    path.startsWith(`scripts${sep}`)
  );
}

function resolveSourcePath(target, filesByPath) {
  const candidates = [target];
  const extension = extensionOf(target);
  if (!sourceExtensions.has(extension)) {
    for (const sourceExtension of sourceExtensions) {
      candidates.push(`${target}${sourceExtension}`);
      candidates.push(join(target, `index${sourceExtension}`));
    }
  } else {
    const sourceAlternatives = {
      '.cjs': ['.cts'],
      '.js': ['.ts', '.tsx'],
      '.jsx': ['.tsx'],
      '.mjs': ['.mts'],
    }[extension];
    for (const sourceExtension of sourceAlternatives ?? []) {
      candidates.push(target.slice(0, -extension.length) + sourceExtension);
    }
  }
  return candidates
    .map((candidate) => resolve(candidate))
    .find((candidate) => filesByPath.has(candidate));
}

function buildProductionFiles(files, packageRoot, productionEntrypoints) {
  const filesByPath = new Set(files.map((file) => resolve(file)));
  const productionFiles = new Set(
    files
      .filter((file) => !isDevelopmentCandidate(file, packageRoot))
      .map((file) => resolve(file)),
  );
  for (const entrypoint of productionEntrypoints) {
    const source = resolveSourcePath(entrypoint, filesByPath);
    if (source) productionFiles.add(source);
  }

  const pending = [...productionFiles];
  while (pending.length > 0) {
    const file = pending.pop();
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const reference of collectModuleSpecifiers(sourceFile)) {
      if (
        reference.kind !== 'module' ||
        typeof reference.value !== 'string' ||
        !reference.value.startsWith('.')
      ) {
        continue;
      }
      const target = resolveSourcePath(
        resolve(dirname(file), reference.value),
        filesByPath,
      );
      if (target && !productionFiles.has(target)) {
        productionFiles.add(target);
        pending.push(target);
      }
    }
  }
  return productionFiles;
}

function findIndependentTarget(specifier, registry) {
  for (const [packageName, policy] of registry.policiesByPackageName) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return policy;
    }
  }
  return null;
}

function checkSpecifier({
  development,
  developmentDependencies,
  errors,
  file,
  location,
  invalidReason,
  packageRoot,
  policy,
  registry,
  rootDirectory,
  specifier,
}) {
  if (specifier === null) {
    errors.push(
      `${location}: ${invalidReason ?? 'non-literal module loading is not allowed'}`,
    );
    return;
  }

  if (isLegacyImport(specifier)) {
    errors.push(`${location}: forbidden platform import "${specifier}"`);
    return;
  }

  if (
    isPlatformImport(specifier) &&
    !policy.allowedExternal.has(externalRoot(specifier))
  ) {
    errors.push(`${location}: forbidden platform import "${specifier}"`);
    return;
  }

  if (!isPackageImport(specifier)) {
    const target = resolve(dirname(file), specifier);
    const pathFromPackage = relative(packageRoot, target);
    if (
      pathFromPackage === '..' ||
      pathFromPackage.startsWith(`..${sep}`) ||
      isAbsolute(pathFromPackage)
    ) {
      errors.push(
        `${location}: relative import escapes ${relative(rootDirectory, packageRoot)}`,
      );
    }
    return;
  }

  if (isBuiltin(specifier)) {
    const normalized = specifier.replace(/^node:/u, '').split('/')[0];
    if (
      !development &&
      !policy.allowedBuiltins.has(specifier) &&
      !policy.allowedBuiltins.has(normalized)
    ) {
      errors.push(
        `${location}: builtin "${specifier}" is not allowlisted for ${policy.packageName}`,
      );
    }
    return;
  }

  const target = findIndependentTarget(specifier, registry);
  if (target) {
    if (!policy.allowedInternal.has(target.id)) {
      errors.push(
        `${location}: ${policy.packageName} cannot depend on "${specifier}"`,
      );
    }
    return;
  }

  if (specifier.startsWith('@clodex/')) {
    errors.push(
      `${location}: legacy or undeclared Clodex dependency "${specifier}" is not allowed`,
    );
    return;
  }

  const root = externalRoot(specifier);
  if (development && developmentDependencies.has(root)) return;
  if (!policy.allowedExternal.has(root)) {
    errors.push(
      `${location}: external dependency "${specifier}" is not allowlisted for ${policy.packageName}`,
    );
  }
}

function checkDependencySpec({
  dependency,
  development,
  errors,
  field,
  manifestPath,
  registry,
  rootDirectory,
  value,
}) {
  const location = `${relative(rootDirectory, manifestPath)}:${field}.${dependency}`;
  const target = findIndependentTarget(dependency, registry);
  if (target) {
    if (!isWorkspaceDependencySpec(value)) {
      errors.push(
        `${location} must use the approved independent workspace specifier "workspace:*"`,
      );
    }
    return;
  }
  if (development && dependency === '@clodex/typescript-config') {
    if (!isWorkspaceDependencySpec(value)) {
      errors.push(
        `${location} must use the approved development workspace specifier "workspace:*"`,
      );
    }
    return;
  }
  if (!dependency.startsWith('@clodex/') && !isRegistryDependencySpec(value)) {
    errors.push(
      `${location} must use a registry version or dist-tag, not a local, URL, Git, workspace, patch, or package-alias specifier`,
    );
  }
}

function checkRootDependencyOverrides(rootDirectory, errors) {
  const manifestPath = join(rootDirectory, 'package.json');
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const workspacePath = join(rootDirectory, 'pnpm-workspace.yaml');
  const workspace = existsSync(workspacePath)
    ? parseYaml(readFileSync(workspacePath, 'utf8'))
    : {};
  const overrideRoots = [
    ['overrides', manifest.overrides],
    ['resolutions', manifest.resolutions],
    ['pnpm.overrides', manifest.pnpm?.overrides],
    ['pnpm-workspace.overrides', workspace?.overrides],
  ];
  function visit(sourcePath, label, value) {
    if (typeof value === 'string') {
      if (!isRegistryDependencySpec(value)) {
        errors.push(
          `${relative(rootDirectory, sourcePath)}:${label} must not redirect dependencies to local, URL, Git, workspace, patch, or package-alias sources`,
        );
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        visit(sourcePath, `${label}.${key}`, child);
      }
    }
  }
  for (const [label, value] of overrideRoots.slice(0, 3)) {
    if (value) visit(manifestPath, label, value);
  }
  if (overrideRoots[3][1]) {
    visit(workspacePath, overrideRoots[3][0], overrideRoots[3][1]);
  }
  for (const [sourcePath, label, value] of [
    [
      manifestPath,
      'pnpm.patchedDependencies',
      manifest.pnpm?.patchedDependencies,
    ],
    [manifestPath, 'pnpm.packageExtensions', manifest.pnpm?.packageExtensions],
    [workspacePath, 'patchedDependencies', workspace?.patchedDependencies],
    [workspacePath, 'packageExtensions', workspace?.packageExtensions],
  ]) {
    if (value && Object.keys(value).length > 0) {
      errors.push(
        `${relative(rootDirectory, sourcePath)}:${label} requires an explicit independent-component policy before use`,
      );
    }
  }

  for (const pnpmfile of ['.pnpmfile.cjs', '.pnpmfile.js']) {
    const pnpmfilePath = join(rootDirectory, pnpmfile);
    if (existsSync(pnpmfilePath)) {
      errors.push(
        `${pnpmfile}: pnpm manifest-rewrite hooks require an explicit independent-component policy`,
      );
    }
  }
  for (const [sourcePath, label, value] of [
    [manifestPath, 'configDependencies', manifest.configDependencies],
    [
      manifestPath,
      'pnpm.configDependencies',
      manifest.pnpm?.configDependencies,
    ],
    [workspacePath, 'configDependencies', workspace?.configDependencies],
  ]) {
    if (value && Object.keys(value).length > 0) {
      errors.push(
        `${relative(rootDirectory, sourcePath)}:${label} may install manifest-rewrite hooks and is not allowed`,
      );
    }
  }
  for (const [sourcePath, label, value] of [
    [manifestPath, 'pnpmfile', manifest.pnpmfile],
    [manifestPath, 'pnpm.pnpmfile', manifest.pnpm?.pnpmfile],
    [workspacePath, 'pnpmfile', workspace?.pnpmfile],
  ]) {
    if (value) {
      errors.push(
        `${relative(rootDirectory, sourcePath)}:${label} may load manifest-rewrite hooks and is not allowed`,
      );
    }
  }
  const npmrcPath = join(rootDirectory, '.npmrc');
  if (existsSync(npmrcPath)) {
    for (const [index, line] of readFileSync(npmrcPath, 'utf8')
      .split(/\r?\n/u)
      .entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      const rawKey = (
        separator === -1 ? trimmed : trimmed.slice(0, separator)
      ).trim();
      const unquotedKey =
        rawKey.length >= 2 &&
        ((rawKey.startsWith('"') && rawKey.endsWith('"')) ||
          (rawKey.startsWith("'") && rawKey.endsWith("'")))
          ? rawKey.slice(1, -1).trim()
          : rawKey;
      const key = unquotedKey.toLowerCase().replace(/[-_.\s]/gu, '');
      if (
        key === 'pnpmfile' ||
        key === 'globalpnpmfile' ||
        key.startsWith('configdependencies')
      ) {
        errors.push(
          `${relative(rootDirectory, npmrcPath)}:${index + 1} may load pnpm manifest-rewrite hooks and is not allowed`,
        );
      }
    }
  }
}

function isLocalLockResolution(value) {
  return (
    typeof value !== 'string' ||
    value.startsWith('.') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    /^(?:file|git(?:\+[^:]*)?|github|gitlab|bitbucket|https?|link|npm|patch|portal|workspace):/iu.test(
      value,
    )
  );
}

function packageLockKey(dependency, version) {
  return `${dependency}@${version.split('(')[0]}`;
}

function checkRegistryLockGraph({
  dependency,
  errors,
  lock,
  lockPath,
  rootDirectory,
  version,
  visited,
}) {
  const graphKey = `${dependency}@${version}`;
  if (visited.has(graphKey)) return;
  visited.add(graphKey);
  if (isLocalLockResolution(version)) {
    errors.push(
      `${relative(rootDirectory, lockPath)}: dependency ${graphKey} resolves through a local, URL, Git, workspace, patch, or package-alias source`,
    );
    return;
  }
  if (dependency.startsWith('@clodex/')) {
    errors.push(
      `${relative(rootDirectory, lockPath)}: dependency graph reaches undeclared legacy package ${dependency}`,
    );
    return;
  }

  const packageKey = packageLockKey(dependency, version);
  const packageRecord = lock.packages?.[packageKey];
  const resolution = packageRecord?.resolution;
  if (
    !packageRecord ||
    !resolution ||
    typeof resolution.integrity !== 'string' ||
    resolution.directory !== undefined ||
    resolution.tarball !== undefined ||
    resolution.type !== undefined
  ) {
    errors.push(
      `${relative(rootDirectory, lockPath)}: registry dependency ${packageKey} lacks an integrity-only registry resolution`,
    );
    return;
  }

  const snapshot = lock.snapshots?.[graphKey];
  if (!snapshot) return;
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [childDependency, childVersion] of Object.entries(
      snapshot[field] ?? {},
    )) {
      checkRegistryLockGraph({
        dependency: childDependency,
        errors,
        lock,
        lockPath,
        rootDirectory,
        version: childVersion,
        visited,
      });
    }
  }
}

function checkLockfile(rootDirectory, registry, errors) {
  const lockPath = join(rootDirectory, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    errors.push('pnpm-lock.yaml: lockfile is required');
    return;
  }
  const lock = parseYaml(readFileSync(lockPath, 'utf8'));
  const visited = new Set();
  for (const policy of registry.policiesByDirectory.values()) {
    const packageRoot = join(
      rootDirectory,
      'packages',
      policy.packageDirectory,
    );
    if (!existsSync(packageRoot)) continue;
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const importerKey = `packages/${policy.packageDirectory}`;
    const importer = lock.importers?.[importerKey];
    if (!importer) {
      errors.push(
        `${relative(rootDirectory, lockPath)}: importer ${importerKey} is missing`,
      );
      continue;
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [dependency, specifier] of Object.entries(
        manifest[field] ?? {},
      )) {
        const lockEntry = importer[field]?.[dependency];
        const location = `${relative(rootDirectory, lockPath)}:${importerKey}.${field}.${dependency}`;
        if (!lockEntry || typeof lockEntry !== 'object') {
          errors.push(`${location} is missing from the lock importer`);
          continue;
        }
        if (lockEntry.specifier !== specifier) {
          errors.push(
            `${location} does not match the package manifest specifier`,
          );
        }
        const version = lockEntry.version;
        const target = findIndependentTarget(dependency, registry);
        let workspaceTarget = null;
        if (target) {
          workspaceTarget = join(
            rootDirectory,
            'packages',
            target.packageDirectory,
          );
        } else if (
          field === 'devDependencies' &&
          dependency === '@clodex/typescript-config'
        ) {
          workspaceTarget = join(
            rootDirectory,
            'packages',
            'typescript-config',
          );
        }
        if (workspaceTarget) {
          const expected = `link:${relative(packageRoot, workspaceTarget).split(sep).join('/')}`;
          if (version !== expected) {
            errors.push(
              `${location} must resolve to the approved workspace target ${expected}`,
            );
          }
          continue;
        }
        if (dependency.startsWith('@clodex/')) continue;
        checkRegistryLockGraph({
          dependency,
          errors,
          lock,
          lockPath,
          rootDirectory,
          version,
          visited,
        });
      }
    }
  }
}

function normalizedTypeScriptLib(value) {
  return value
    .toLowerCase()
    .replace(/^lib\./u, '')
    .replace(/\.d\.ts$/u, '');
}

function pathEscapesPackage(packageRoot, value) {
  const pathFromPackage = relative(packageRoot, resolve(value));
  return (
    pathFromPackage === '..' ||
    pathFromPackage.startsWith(`..${sep}`) ||
    isAbsolute(pathFromPackage)
  );
}

function checkTsconfig({ errors, packageRoot, policy, rootDirectory }) {
  const configPath = join(packageRoot, 'tsconfig.json');
  if (!existsSync(configPath)) return;
  let fatalDiagnostic = null;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        fatalDiagnostic = diagnostic;
      },
    },
  );
  if (!parsed || fatalDiagnostic) {
    errors.push(
      `${relative(rootDirectory, configPath)}: TypeScript config could not be parsed`,
    );
    return;
  }
  if (parsed.options.paths) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.paths is not allowed in independent packages`,
    );
  }
  if (parsed.options.baseUrl) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.baseUrl is not allowed in independent packages`,
    );
  }
  if (parsed.options.rootDirs) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.rootDirs is not allowed in independent packages`,
    );
  }
  if (parsed.options.moduleSuffixes) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.moduleSuffixes is not allowed in independent packages`,
    );
  }

  for (const [option, values] of [
    ['declarationDir', [parsed.options.declarationDir]],
    ['outDir', [parsed.options.outDir]],
    ['rootDir', [parsed.options.rootDir]],
    ['typeRoots', parsed.options.typeRoots ?? []],
  ]) {
    for (const value of values.filter(Boolean)) {
      if (pathEscapesPackage(packageRoot, value)) {
        errors.push(
          `${relative(rootDirectory, configPath)}: compilerOptions.${option} escapes the independent package`,
        );
      }
    }
  }

  if (parsed.options.lib === undefined) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.lib must be explicit`,
    );
  } else {
    for (const value of parsed.options.lib) {
      const normalized = normalizedTypeScriptLib(value);
      if (!policy.allowedTypeScriptLibs.has(normalized)) {
        errors.push(
          `${relative(rootDirectory, configPath)}: TypeScript lib "${normalized}" is not allowlisted`,
        );
      }
    }
  }

  if (parsed.options.types === undefined) {
    errors.push(
      `${relative(rootDirectory, configPath)}: compilerOptions.types must be explicit`,
    );
  } else {
    for (const value of parsed.options.types) {
      if (!policy.allowedTypeScriptTypes.has(value)) {
        errors.push(
          `${relative(rootDirectory, configPath)}: TypeScript ambient type "${value}" is not allowlisted`,
        );
      }
    }
  }

  for (const file of parsed.fileNames) {
    if (pathEscapesPackage(packageRoot, file)) {
      errors.push(
        `${relative(rootDirectory, configPath)}: includes source outside the independent package`,
      );
      break;
    }
  }

  for (const reference of parsed.projectReferences ?? []) {
    if (pathEscapesPackage(packageRoot, reference.path)) {
      errors.push(
        `${relative(rootDirectory, configPath)}: project reference escapes the independent package`,
      );
    }
  }
}

function checkManifestTarget({
  errors,
  label,
  packageRoot,
  productionEntrypoints,
  rootDirectory,
  value,
}) {
  if (typeof value === 'string') {
    if (value.includes('*')) {
      errors.push(
        `${relative(rootDirectory, join(packageRoot, 'package.json'))}:${label} wildcard entrypoints are not allowed`,
      );
      return;
    }
    if (!value.startsWith('./')) {
      errors.push(
        `${relative(rootDirectory, join(packageRoot, 'package.json'))}:${label} must use a package-relative target`,
      );
      return;
    }
    const target = resolve(packageRoot, value);
    const pathFromPackage = relative(packageRoot, target);
    if (
      pathFromPackage === '..' ||
      pathFromPackage.startsWith(`..${sep}`) ||
      isAbsolute(pathFromPackage)
    ) {
      errors.push(
        `${relative(rootDirectory, join(packageRoot, 'package.json'))}:${label} escapes the package`,
      );
      return;
    }
    if (
      pathFromPackage
        .split(sep)
        .some((segment) => ignoredDirectories.has(segment))
    ) {
      errors.push(
        `${relative(rootDirectory, join(packageRoot, 'package.json'))}:${label} targets an ignored generated directory`,
      );
      return;
    }
    if (!sourceExtensions.has(extensionOf(target))) {
      errors.push(
        `${relative(rootDirectory, join(packageRoot, 'package.json'))}:${label} must target a scanned JavaScript or TypeScript source file`,
      );
      return;
    }
    productionEntrypoints.add(target);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      checkManifestTarget({
        errors,
        label: `${label}[${index}]`,
        packageRoot,
        productionEntrypoints,
        rootDirectory,
        value: entry,
      }),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      checkManifestTarget({
        errors,
        label: `${label}.${key}`,
        packageRoot,
        productionEntrypoints,
        rootDirectory,
        value: entry,
      });
    }
  }
}

function checkPackageManifest({
  errors,
  packageRoot,
  policy,
  registry,
  rootDirectory,
}) {
  const manifestPath = join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    errors.push(
      `${relative(rootDirectory, packageRoot)}: package.json is missing`,
    );
    return {
      developmentDependencies: new Set(),
      productionEntrypoints: new Set(),
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const productionEntrypoints = new Set();
  if (manifest.name !== policy.packageName) {
    errors.push(
      `${relative(rootDirectory, manifestPath)}: expected package name "${policy.packageName}"`,
    );
  }
  if (manifest.imports) {
    errors.push(
      `${relative(rootDirectory, manifestPath)}: package imports aliases are not allowed`,
    );
  }
  if (manifest.typesVersions) {
    errors.push(
      `${relative(rootDirectory, manifestPath)}: package typesVersions aliases are not allowed`,
    );
  }
  if (manifest.browser && typeof manifest.browser !== 'string') {
    errors.push(
      `${relative(rootDirectory, manifestPath)}: package browser aliases are not allowed`,
    );
  }
  const entrypointErrorCount = errors.length;
  for (const field of [
    'bin',
    'exports',
    'main',
    'module',
    'react-native',
    'source',
    'types',
    'typings',
  ]) {
    if (manifest[field] !== undefined) {
      checkManifestTarget({
        errors,
        label: field,
        packageRoot,
        productionEntrypoints,
        rootDirectory,
        value: manifest[field],
      });
    }
  }
  if (typeof manifest.browser === 'string') {
    checkManifestTarget({
      errors,
      label: 'browser',
      packageRoot,
      productionEntrypoints,
      rootDirectory,
      value: manifest.browser,
    });
  }
  if (
    productionEntrypoints.size === 0 &&
    errors.length === entrypointErrorCount
  ) {
    errors.push(
      `${relative(rootDirectory, manifestPath)}: an explicit production entrypoint is required`,
    );
  }

  const developmentDependencies = new Set(
    Object.keys(manifest.devDependencies ?? {}),
  );
  for (const [dependency, value] of Object.entries(
    manifest.devDependencies ?? {},
  )) {
    if (!registry.allowedDevelopmentDependencies.has(dependency)) {
      errors.push(
        `${relative(rootDirectory, manifestPath)}: devDependency "${dependency}" is not allowlisted`,
      );
    }
    checkDependencySpec({
      dependency,
      development: true,
      errors,
      field: 'devDependencies',
      manifestPath,
      registry,
      rootDirectory,
      value,
    });
  }

  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [dependency, value] of Object.entries(manifest[field] ?? {})) {
      checkDependencySpec({
        dependency,
        development: false,
        errors,
        field,
        manifestPath,
        registry,
        rootDirectory,
        value,
      });
      checkSpecifier({
        development: false,
        developmentDependencies,
        errors,
        file: manifestPath,
        location: `${relative(rootDirectory, manifestPath)}:${field}`,
        packageRoot,
        policy,
        registry,
        rootDirectory,
        specifier: dependency,
      });
    }
  }
  return { developmentDependencies, productionEntrypoints };
}

export function checkClodexBoundaries(rootDirectory) {
  const packagesDirectory = join(rootDirectory, 'packages');
  if (!existsSync(packagesDirectory)) return [];

  const registry = loadRegistry(rootDirectory);
  const errors = [];
  checkRootDependencyOverrides(rootDirectory, errors);
  checkLockfile(rootDirectory, registry, errors);
  for (const packageName of readdirSync(packagesDirectory).filter((name) =>
    name.startsWith('clodex-'),
  )) {
    const packageRoot = join(packagesDirectory, packageName);
    const packageStat = lstatSync(packageRoot);
    if (packageStat.isSymbolicLink()) {
      errors.push(
        `${relative(rootDirectory, packageRoot)}: independent package roots cannot be symlinks`,
      );
      continue;
    }
    if (!packageStat.isDirectory()) continue;
    const policy = registry.policiesByDirectory.get(packageName);
    if (!policy) {
      errors.push(
        `${relative(rootDirectory, packageRoot)}: no independent component policy is registered`,
      );
      continue;
    }

    const context = { errors, rootDirectory };
    const { developmentDependencies, productionEntrypoints } =
      checkPackageManifest({
        errors,
        packageRoot,
        policy,
        registry,
        rootDirectory,
      });
    checkTsconfig({ errors, packageRoot, policy, rootDirectory });

    const files = walk(packageRoot, context);
    const productionFiles = buildProductionFiles(
      files,
      packageRoot,
      productionEntrypoints,
    );
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const reference of collectModuleSpecifiers(sourceFile)) {
        const { invalidReason, kind, position, value: specifier } = reference;
        const { line } = sourceFile.getLineAndCharacterOfPosition(position);
        if (kind === 'typescript-lib') {
          if (!policy.allowedTypeScriptLibs.has(specifier)) {
            errors.push(
              `${relative(rootDirectory, file)}:${line + 1}: TypeScript lib "${specifier}" is not allowlisted`,
            );
          }
          continue;
        }
        checkSpecifier({
          development: !productionFiles.has(resolve(file)),
          developmentDependencies,
          errors,
          file,
          invalidReason,
          location: `${relative(rootDirectory, file)}:${line + 1}`,
          packageRoot,
          policy,
          registry,
          rootDirectory,
          specifier,
        });
      }
    }
  }

  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = checkClodexBoundaries(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Clodex package boundaries passed.');
  }
}
