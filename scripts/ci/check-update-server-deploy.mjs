import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const expectedDockerignore = [
  '**',
  '!package.json',
  '!pnpm-lock.yaml',
  '!pnpm-workspace.yaml',
  '!.npmrc',
  '!apps/',
  '!apps/update-server/',
  '!apps/update-server/package.json',
  '!apps/update-server/tsconfig.json',
  '!apps/update-server/deploy-toolchain.json',
  '!apps/update-server/src/',
  '!apps/update-server/src/**',
];
const requiredAttestationFlags = [
  '--deny-self-hosted-runners',
  '--signer-digest',
  '--signer-workflow',
  '--source-digest',
  '--source-ref',
];
const sha256Pattern = /^[a-f0-9]{64}$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function validateArchiveSet({ archives, expectedKeys, filePrefix, label }) {
  const errors = [];
  if (!archives || typeof archives !== 'object' || Array.isArray(archives)) {
    return [`${label}.archives must be an object`];
  }
  const keys = Object.keys(archives).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expectedKeys].sort())) {
    errors.push(
      `${label}.archives must contain exactly ${expectedKeys.join(', ')}`,
    );
  }
  for (const [key, archive] of Object.entries(archives)) {
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
      errors.push(`${label}.archives.${key} must be an object`);
      continue;
    }
    if (
      typeof archive.file !== 'string' ||
      !archive.file.startsWith(filePrefix) ||
      !archive.file.endsWith('.tar.gz') ||
      archive.file.includes('/')
    ) {
      errors.push(`${label}.archives.${key}.file is not an exact tarball name`);
    }
    if (
      typeof archive.sha256 !== 'string' ||
      !sha256Pattern.test(archive.sha256)
    ) {
      errors.push(`${label}.archives.${key}.sha256 must be lowercase SHA-256`);
    }
  }
  return errors;
}

function validateToolchain(
  policy,
  rootManifest,
  updateManifest,
  lock,
  nodeVersion,
) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['deploy-toolchain.json must be an object'];
  }
  if (policy.schemaVersion !== 1) {
    errors.push('deploy-toolchain.json schemaVersion must be 1');
  }
  if (policy.node?.version !== nodeVersion) {
    errors.push('deploy toolchain Node version must match .node-version');
  }
  if (
    policy.node?.image !== `node:${nodeVersion}-alpine3.23` ||
    !/^sha256:[a-f0-9]{64}$/u.test(policy.node?.manifestDigest ?? '')
  ) {
    errors.push(
      'deploy toolchain Node image must use the exact .node-version Alpine tag and a manifest digest',
    );
  }

  const packageManager = /^pnpm@([^+]+)(?:\+.+)?$/u.exec(
    rootManifest?.packageManager ?? '',
  )?.[1];
  if (!packageManager || policy.pnpm?.version !== packageManager) {
    errors.push('deploy toolchain pnpm version must match package.json');
  }
  if (policy.pnpm?.lockfile !== 'pnpm-lock.yaml') {
    errors.push('deploy toolchain must name the root pnpm-lock.yaml');
  }

  const ghVersion = policy.githubCli?.version;
  if (
    typeof ghVersion !== 'string' ||
    policy.githubCli?.sourceBaseUrl !==
      `https://github.com/cli/cli/releases/download/v${ghVersion}`
  ) {
    errors.push('GitHub CLI source URL must be pinned to its exact version');
  }
  errors.push(
    ...validateArchiveSet({
      archives: policy.githubCli?.archives,
      expectedKeys: ['amd64', 'arm64'],
      filePrefix: `gh_${ghVersion}_linux_`,
      label: 'githubCli',
    }),
  );
  if (
    JSON.stringify(policy.githubCli?.requiredAttestationFlags) !==
    JSON.stringify(requiredAttestationFlags)
  ) {
    errors.push(
      'GitHub CLI policy must require the complete attestation verifier flag set',
    );
  }

  const syftVersion = policy.syft?.version;
  if (
    typeof syftVersion !== 'string' ||
    policy.syft?.sourceBaseUrl !==
      `https://github.com/anchore/syft/releases/download/v${syftVersion}`
  ) {
    errors.push('Syft source URL must be pinned to its exact version');
  }
  errors.push(
    ...validateArchiveSet({
      archives: policy.syft?.archives,
      expectedKeys: [
        'darwin-amd64',
        'darwin-arm64',
        'linux-amd64',
        'linux-arm64',
      ],
      filePrefix: `syft_${syftVersion}_`,
      label: 'syft',
    }),
  );

  if (
    policy.runtime?.application?.name !== updateManifest?.name ||
    policy.runtime?.application?.version !== updateManifest?.version
  ) {
    errors.push(
      'runtime application identity must match update-server package.json',
    );
  }
  const importer = lock?.importers?.['apps/update-server'];
  if (!importer) {
    errors.push('root pnpm lockfile is missing apps/update-server importer');
  }
  for (const [name, version] of Object.entries(
    policy.runtime?.requiredNodePackages ?? {},
  )) {
    const manifestSpecifier = updateManifest?.dependencies?.[name];
    const locked = importer?.dependencies?.[name];
    if (!manifestSpecifier || locked?.specifier !== manifestSpecifier) {
      errors.push(`${name}: update-server manifest and root lockfile drifted`);
    }
    if (locked?.version !== version) {
      errors.push(
        `${name}: locked version must match runtime SBOM policy ${version}`,
      );
    }
  }
  const forbidden = policy.runtime?.forbiddenNodePackages;
  if (
    !Array.isArray(forbidden) ||
    forbidden.length === 0 ||
    forbidden.some((name) => typeof name !== 'string' || !name)
  ) {
    errors.push(
      'runtime forbiddenNodePackages must be a non-empty string array',
    );
  }
  return errors;
}

function validateDockerfile(dockerfile, policy) {
  const errors = [];
  const expectedImage = `${policy.node.image}@${policy.node.manifestDigest}`;
  const from = [
    ...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gimu),
  ].map((match) => ({ alias: match[2]?.toLowerCase(), source: match[1] }));
  if (
    from.length !== 3 ||
    from[0]?.source !== expectedImage ||
    from[0]?.alias !== 'node-base' ||
    from[1]?.source !== 'node-base' ||
    from[1]?.alias !== 'builder' ||
    from[2]?.source !== 'node-base' ||
    from[2]?.alias !== 'runtime'
  ) {
    errors.push(
      `Dockerfile stages must derive only from immutable ${expectedImage}`,
    );
  }
  if (/\bnpm\s+(?:ci|install)\b/iu.test(dockerfile)) {
    errors.push('Dockerfile must not use npm ci/install');
  }
  if (/package-lock\.json/iu.test(dockerfile)) {
    errors.push('Dockerfile must not reference package-lock.json');
  }
  for (const pattern of [
    new RegExp(
      `corepack prepare pnpm@${escapeRegExp(policy.pnpm.version)} --activate`,
      'u',
    ),
    /pnpm install[\s\\]+--filter @clodex\/update-server\.\.\.[\s\\]+--frozen-lockfile/iu,
    /pnpm --config\.inject-workspace-packages=true[\s\\]+--filter @clodex\/update-server[\s\\]+deploy[\s\\]+--prod[\s\\]+\/opt\/update-server/iu,
    /COPY --from=builder --chown=node:node \/opt\/update-server\/ \/app\//u,
    /^USER node$/mu,
    /wget -O \/tmp\/gh\.tar\.gz/iu,
    /test "\$\(sha256sum \/tmp\/gh\.tar\.gz \| awk/iu,
    /rm -f[\s\\]+\/opt\/update-server\/pnpm-lock\.yaml/iu,
    /gh attestation verify --help/iu,
  ]) {
    if (!pattern.test(dockerfile)) {
      errors.push(`Dockerfile is missing required deploy control ${pattern}`);
    }
  }
  return errors;
}

export function checkUpdateServerDeploy(rootDirectory) {
  const errors = [];
  const paths = {
    buildScript: join(rootDirectory, 'scripts/ci/build-update-server-image.sh'),
    dockerfile: join(rootDirectory, 'apps/update-server/Dockerfile'),
    dockerignore: join(
      rootDirectory,
      'apps/update-server/Dockerfile.dockerignore',
    ),
    lockfile: join(rootDirectory, 'pnpm-lock.yaml'),
    monorepoCi: join(rootDirectory, '.github/workflows/monorepo-ci.yml'),
    nodeVersion: join(rootDirectory, '.node-version'),
    policy: join(rootDirectory, 'apps/update-server/deploy-toolchain.json'),
    rootManifest: join(rootDirectory, 'package.json'),
    updateManifest: join(rootDirectory, 'apps/update-server/package.json'),
  };
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) errors.push(`${label}: required file is missing`);
  }
  if (errors.length > 0) return errors;
  if (existsSync(join(rootDirectory, 'apps/update-server/package-lock.json'))) {
    errors.push(
      'apps/update-server/package-lock.json is forbidden; use root pnpm-lock.yaml',
    );
  }
  if (existsSync(join(rootDirectory, 'apps/update-server/.dockerignore'))) {
    errors.push(
      'apps/update-server/.dockerignore is ambiguous for root-context builds; use Dockerfile.dockerignore',
    );
  }

  const rootManifest = readJson(paths.rootManifest, 'package.json', errors);
  const updateManifest = readJson(
    paths.updateManifest,
    'apps/update-server/package.json',
    errors,
  );
  const policy = readJson(
    paths.policy,
    'apps/update-server/deploy-toolchain.json',
    errors,
  );
  let lock = null;
  try {
    lock = parseYaml(readFileSync(paths.lockfile, 'utf8'));
  } catch (error) {
    errors.push(
      `pnpm-lock.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const nodeVersion = readFileSync(paths.nodeVersion, 'utf8').trim();
  errors.push(
    ...validateToolchain(
      policy,
      rootManifest,
      updateManifest,
      lock,
      nodeVersion,
    ),
  );

  if (JSON.stringify(updateManifest?.files) !== JSON.stringify(['dist'])) {
    errors.push('update-server package files must contain exactly dist');
  }

  const dockerfile = readFileSync(paths.dockerfile, 'utf8');
  errors.push(...validateDockerfile(dockerfile, policy));

  const dockerignore = readFileSync(paths.dockerignore, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (JSON.stringify(dockerignore) !== JSON.stringify(expectedDockerignore)) {
    errors.push(
      'Dockerfile.dockerignore must be the reviewed root-context allowlist',
    );
  }

  const buildScript = readFileSync(paths.buildScript, 'utf8');
  const flattenedBuildScript = buildScript.replace(/\\\r?\n\s*/gu, ' ');
  for (const pattern of [
    /docker build\s+--file apps\/update-server\/Dockerfile\s+--pull\s+--tag "\$image_ref"\s+\./u,
    /syft" scan\s+"docker:\$image_ref"/u,
    /validate-update-server-sbom\.mjs/u,
    /test "\$\(sha256_file "\$temporary_directory\/syft\.tar\.gz"\)" = "\$syft_sha256"/u,
  ]) {
    if (!pattern.test(flattenedBuildScript)) {
      errors.push(
        `image/SBOM build script is missing required control ${pattern}`,
      );
    }
  }
  if (/\bnpm\s+(?:ci|install)\b/iu.test(buildScript)) {
    errors.push('image/SBOM build script must not use npm ci/install');
  }

  const monorepoCi = readFileSync(paths.monorepoCi, 'utf8');
  for (const value of [
    'scripts/ci/build-update-server-image.sh',
    'security-reports/update-server-image/update-server.cyclonedx.json',
    'security-reports/update-server-image/update-server-image-inspection.json',
  ]) {
    if (!monorepoCi.includes(value)) {
      errors.push(
        `monorepo CI is missing update-server image evidence wiring: ${value}`,
      );
    }
  }
  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = checkUpdateServerDeploy(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Update-server deploy graph policy passed.');
  }
}
