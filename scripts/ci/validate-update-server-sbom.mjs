import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function componentName(component) {
  if (!component || typeof component !== 'object') return null;
  if (typeof component.name !== 'string' || !component.name) return null;
  return typeof component.group === 'string' && component.group
    ? `${component.group}/${component.name}`
    : component.name;
}

function allComponents(document) {
  return Array.isArray(document.components) ? [...document.components] : [];
}

function expectedPurl(name, version) {
  const purlName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${purlName}@${version}`;
}

function propertyValues(component, name) {
  return new Set(
    (Array.isArray(component.properties) ? component.properties : [])
      .filter((property) => property?.name === name)
      .map((property) => property.value)
      .filter((value) => typeof value === 'string'),
  );
}

function isInstalledNodeComponent(component, name, version) {
  const foundBy = propertyValues(component, 'syft:package:foundBy');
  const metadataTypes = propertyValues(component, 'syft:package:metadataType');
  const locations = propertyValues(component, 'syft:location:0:path');
  const packagePath =
    name === '@clodex/update-server'
      ? /\/(?:app\/)?package\.json$/u
      : new RegExp(
          `/(?:app/)?node_modules/${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/package\\.json$`,
          'u',
        );
  return (
    component.purl === expectedPurl(name, version) &&
    foundBy.has('javascript-package-cataloger') &&
    metadataTypes.has('javascript-npm-package') &&
    [...locations].some((location) => packagePath.test(location))
  );
}

function requireExactComponent(components, name, version, errors) {
  const matches = components.filter(
    (component) => componentName(component) === name,
  );
  if (matches.length === 0) {
    errors.push(
      `SBOM is missing required runtime component ${name}@${version}`,
    );
    return;
  }
  if (!matches.some((component) => component.version === version)) {
    const versions = [
      ...new Set(
        matches
          .map((component) => component.version)
          .filter((value) => typeof value === 'string'),
      ),
    ].sort();
    errors.push(
      `SBOM runtime component ${name} has ${versions.join(', ') || 'no version'}; expected ${version}`,
    );
    return;
  }
  if (
    !matches.some((component) =>
      isInstalledNodeComponent(component, name, version),
    )
  ) {
    errors.push(
      `SBOM runtime component ${name}@${version} is not bound to an installed package.json`,
    );
  }
}

export function validateUpdateServerSbom(document, policy) {
  const errors = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return ['SBOM must be a JSON object'];
  }
  if (document.bomFormat !== 'CycloneDX') {
    errors.push('SBOM bomFormat must be CycloneDX');
  }
  if (!/^1\.[5-7]$/u.test(document.specVersion ?? '')) {
    errors.push('SBOM specVersion must be CycloneDX 1.5, 1.6, or 1.7');
  }
  if (!/^urn:uuid:[0-9a-f-]{36}$/iu.test(document.serialNumber ?? '')) {
    errors.push('SBOM serialNumber must be a UUID URN');
  }

  const components = allComponents(document);
  if (components.length === 0) errors.push('SBOM has no runtime components');

  requireExactComponent(
    components,
    policy.runtime.application.name,
    policy.runtime.application.version,
    errors,
  );
  for (const [name, version] of Object.entries(
    policy.runtime.requiredNodePackages,
  )) {
    requireExactComponent(components, name, version, errors);
  }

  const componentNames = new Set(components.map(componentName).filter(Boolean));
  for (const name of policy.runtime.forbiddenNodePackages) {
    if (componentNames.has(name)) {
      errors.push(`SBOM contains forbidden development component ${name}`);
    }
  }
  return errors;
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    if (Object.hasOwn(values, match[1])) {
      throw new Error(`Duplicate argument: --${match[1]}`);
    }
    values[match[1]] = match[2];
  }
  for (const name of [
    'image-id',
    'image-ref',
    'record',
    'sbom',
    'source-commit',
    'syft-version',
  ]) {
    if (!values[name]) throw new Error(`Missing required argument: --${name}`);
  }
  return values;
}

function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.temporary`,
  );
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  });
  renameSync(temporary, path);
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const policyPath = join(
    repositoryRoot,
    'apps/update-server/deploy-toolchain.json',
  );
  const sbomPath = resolve(args.sbom);
  const recordPath = resolve(args.record);
  const policyBytes = readFileSync(policyPath);
  const policy = JSON.parse(policyBytes);
  const sbomBytes = readFileSync(sbomPath);
  const sbom = JSON.parse(sbomBytes);
  const errors = validateUpdateServerSbom(sbom, policy);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(args['image-id'])) {
    throw new Error('--image-id must be an exact sha256 image identifier');
  }
  if (!/^[a-f0-9]{40}$/u.test(args['source-commit'])) {
    throw new Error('--source-commit must be an exact 40-character commit');
  }
  if (args['syft-version'] !== policy.syft.version) {
    throw new Error(
      `Syft version ${args['syft-version']} does not match policy ${policy.syft.version}`,
    );
  }

  const dockerfilePath = join(repositoryRoot, 'apps/update-server/Dockerfile');
  const lockfilePath = join(repositoryRoot, policy.pnpm.lockfile);
  const record = {
    schemaVersion: 1,
    kind: 'clodex-update-server-ci-image-inspection',
    releaseEvidence: false,
    generatedAt: new Date().toISOString(),
    sourceCommit: args['source-commit'],
    image: {
      id: args['image-id'],
      reference: args['image-ref'],
    },
    inputs: {
      dockerfile: {
        path: 'apps/update-server/Dockerfile',
        sha256: sha256(readFileSync(dockerfilePath)),
      },
      lockfile: {
        path: policy.pnpm.lockfile,
        sha256: sha256(readFileSync(lockfilePath)),
      },
      toolchainPolicy: {
        path: 'apps/update-server/deploy-toolchain.json',
        sha256: sha256(policyBytes),
      },
    },
    sbom: {
      componentCount: allComponents(sbom).length,
      format: `${sbom.bomFormat}-${sbom.specVersion}`,
      path: basename(sbomPath),
      sha256: sha256(sbomBytes),
    },
    tools: {
      syft: policy.syft.version,
    },
  };
  writeRecord(recordPath, record);
  console.log(
    `Validated update-server runtime SBOM (${record.sbom.componentCount} components) and wrote ${recordPath}`,
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
