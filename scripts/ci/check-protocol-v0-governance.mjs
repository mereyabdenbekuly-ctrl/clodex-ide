import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const protocolPath = 'docs/protocol/agent-gateway-v0';
const inputPath = 'docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json';
const tracePath = protocolPath + '/traceability.json';
const allowedFiles = new Set([
  'README.md',
  'REQUIREMENTS.md',
  'approval-evidence-reference.schema.json',
  'common.schema.json',
  'conformance/README.md',
  'conformance/manifest.json',
  'error-envelope.schema.json',
  'openapi.yaml',
  'request-envelope.schema.json',
  'signed-effect-receipt.schema.json',
  'traceability.json',
  'version-negotiation.schema.json',
]);
const openGates = Array.from(
  { length: 10 },
  (_, index) => 'PV0-G' + String(index + 1).padStart(2, '0'),
);

function parseJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(label + ': invalid JSON: ' + error.message);
    return null;
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(directory, base, errors) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    const name = relative(base, path).replaceAll('\\', '/');
    if (stat.isSymbolicLink()) {
      errors.push(protocolPath + '/' + name + ': symlinks are forbidden');
    } else if (stat.isDirectory()) {
      result.push(...walk(path, base, errors));
    } else {
      result.push(name);
    }
  }
  return result;
}

function getPointer(document, pointer) {
  if (pointer === '/' || pointer === '') return document;
  let value = document;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, token)
    ) {
      return undefined;
    }
    value = value[token];
  }
  return value;
}

function documentRefs(value, result = []) {
  if (Array.isArray(value)) {
    for (const child of value) documentRefs(child, result);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        result.push(child);
      } else {
        documentRefs(child, result);
      }
    }
  }
  return result;
}

function splitReference(reference, label, errors) {
  if (reference.length === 0 || reference.includes('\\')) {
    errors.push(label + ': invalid reference ' + reference);
    return null;
  }
  const hash = reference.indexOf('#');
  if (hash !== -1 && reference.indexOf('#', hash + 1) !== -1) {
    errors.push(label + ': invalid reference ' + reference);
    return null;
  }
  return {
    target: hash === -1 ? reference : reference.slice(0, hash),
    fragment: hash === -1 ? '' : reference.slice(hash + 1),
  };
}

function checkDocumentReferences(name, document, documents, errors) {
  const label = protocolPath + '/' + name;
  for (const reference of documentRefs(document)) {
    const parts = splitReference(reference, label, errors);
    if (!parts) continue;

    let targetName = name;
    if (parts.target.length > 0) {
      const normalized = parts.target.startsWith('./')
        ? parts.target.slice(2)
        : parts.target;
      if (
        normalized.includes('/') ||
        !normalized.endsWith('.schema.json') ||
        !allowedFiles.has(normalized)
      ) {
        errors.push(label + ': external or non-allowlisted ref ' + reference);
        continue;
      }
      targetName = normalized;
    }

    const target = documents.get(targetName);
    if (!target) {
      errors.push(label + ': unresolved ref ' + reference);
      continue;
    }
    if (parts.fragment.length === 0) continue;

    let pointer;
    try {
      pointer = decodeURIComponent(parts.fragment);
    } catch {
      errors.push(label + ': invalid reference encoding ' + reference);
      continue;
    }
    if (!pointer.startsWith('/') || getPointer(target, pointer) === undefined) {
      errors.push(label + ': unresolved ref pointer ' + reference);
    }
  }
}

function checkInputManifest(root, errors) {
  const document = parseJson(join(root, inputPath), inputPath, errors);
  if (!document) return new Set();
  if (
    document.status !== 'FROZEN_ENGINEERING_INVENTORY_REVIEW_PENDING' ||
    document.cleanRoomClaim !== false ||
    document.publicationAuthorized !== false ||
    document.privateImplementationAuthorized !== false
  ) {
    errors.push(inputPath + ': invalid review-only authorization state');
  }
  if ((document.openGates ?? []).join('\n') !== openGates.join('\n')) {
    errors.push(
      inputPath + ': all Protocol v0 gates must remain explicitly open',
    );
  }
  if (
    !(
      document.authoringRestrictions?.repositoryExposedAgentsMustNot ?? []
    ).includes('author conformance fixture payloads')
  ) {
    errors.push(
      inputPath + ': repository-exposure restrictions are incomplete',
    );
  }

  const ids = new Set();
  for (const input of document.candidateInputs ?? []) {
    if (!/^PV0-IN-\d{3}$/u.test(input.id ?? '') || ids.has(input.id)) {
      errors.push(inputPath + ': invalid or duplicate input id ' + input.id);
      continue;
    }
    ids.add(input.id);
    const external = /^https?:\/\//u.test(input.locator ?? '');
    const repositoryExposure = input.type === 'repository_context_exposure';
    if (!external && !repositoryExposure) {
      if (!/^[0-9a-f]{40}$/u.test(input.immutableRevision ?? '')) {
        errors.push(inputPath + ': ' + input.id + ' lacks immutable revision');
      }
      if (!/^[0-9a-f]{40}$/u.test(input.gitBlob ?? '')) {
        errors.push(inputPath + ': ' + input.id + ' lacks git blob');
      }
      if (!/^[0-9a-f]{64}$/u.test(input.sha256 ?? '')) {
        errors.push(inputPath + ': ' + input.id + ' lacks SHA-256');
      }
    }
    if (external && !input.version) {
      errors.push(inputPath + ': ' + input.id + ' lacks standard version');
    }
    if (
      external &&
      (!Array.isArray(input.observedTermsEvidence) ||
        input.observedTermsEvidence.length === 0)
    ) {
      errors.push(
        inputPath + ': ' + input.id + ' lacks observed terms evidence',
      );
    }
    if (!input.status || !input.permittedUse || !input.blocker) {
      errors.push(inputPath + ': ' + input.id + ' lacks review metadata');
    }
  }
  const redExposure = (document.candidateInputs ?? []).some(
    (input) =>
      input.type === 'repository_context_exposure' &&
      input.status === 'RED_FOR_PROTOCOL_AUTHORING',
  );
  if (!redExposure) {
    errors.push(inputPath + ': repository exposure must remain RED');
  }
  return ids;
}

function checkSchemas(protocolRoot, files, errors) {
  const documents = new Map();
  for (const file of files.filter((name) => name.endsWith('.schema.json'))) {
    const path = join(protocolRoot, file);
    const schema = parseJson(path, protocolPath + '/' + file, errors);
    if (!schema) continue;
    documents.set(file, schema);
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      errors.push(protocolPath + '/' + file + ': wrong JSON Schema dialect');
    }
    if (
      typeof schema.$id !== 'string' ||
      !schema.$id.startsWith('https://schemas.clodex.dev/')
    ) {
      errors.push(protocolPath + '/' + file + ': missing incubator schema id');
    }
  }
  for (const [name, document] of documents) {
    checkDocumentReferences(name, document, documents, errors);
  }
}

function checkConformance(protocolRoot, errors) {
  const directory = join(protocolRoot, 'conformance');
  if (readdirSync(directory).sort().join('\n') !== 'README.md\nmanifest.json') {
    errors.push('conformance: fixture payloads or runners are not authorized');
  }
  const manifest = parseJson(
    join(directory, 'manifest.json'),
    protocolPath + '/conformance/manifest.json',
    errors,
  );
  if (!manifest) return;
  if (
    manifest.status !== 'DEFINITIONS_ONLY' ||
    manifest.fixturesPresent !== false
  ) {
    errors.push('conformance: manifest must remain definitions-only');
  }
  for (const vector of manifest.vectors ?? []) {
    if (vector.fixtureStatus !== 'PLANNED' || vector.mustNotExecute !== true) {
      errors.push(
        'conformance: vector ' + vector.id + ' is prematurely active',
      );
    }
  }
}

function checkTraceability(root, protocolRoot, requirements, inputs, errors) {
  const trace = parseJson(join(root, tracePath), tracePath, errors);
  if (!trace) return;
  if (
    trace.status !== 'INCUBATOR_MAPPING_REVIEW_PENDING' ||
    trace.authoringContext !== 'REPOSITORY_EXPOSED_NOT_CLEAN_ROOM' ||
    trace.publicationAuthorized !== false ||
    trace.privateImplementationAuthorized !== false ||
    (trace.unclosedGates ?? []).join('\n') !== openGates.join('\n')
  ) {
    errors.push(tracePath + ': invalid incubator status');
  }

  const artifactNames = new Set();
  const mapped = new Set();
  for (const artifact of trace.artifacts ?? []) {
    if (artifactNames.has(artifact.path)) {
      errors.push(tracePath + ': duplicate artifact ' + artifact.path);
      continue;
    }
    artifactNames.add(artifact.path);
    const path = join(protocolRoot, artifact.path);
    if (!existsSync(path)) {
      errors.push(tracePath + ': missing artifact ' + artifact.path);
      continue;
    }
    if (artifact.sha256 !== digest(path)) {
      errors.push(tracePath + ': hash drift for ' + artifact.path);
    }
    for (const input of artifact.sourceInputs ?? []) {
      if (!inputs.has(input)) {
        errors.push(tracePath + ': unknown input ' + input);
      }
    }
    for (const requirement of artifact.requirementIds ?? []) {
      mapped.add(requirement);
      if (!requirements.has(requirement)) {
        errors.push(tracePath + ': unknown requirement ' + requirement);
      }
    }
    let json = null;
    if (artifact.path.endsWith('.json')) {
      json = parseJson(path, protocolPath + '/' + artifact.path, errors);
    }
    for (const mapping of artifact.mappings ?? []) {
      for (const requirement of mapping.requirementIds ?? []) {
        mapped.add(requirement);
        if (!requirements.has(requirement)) {
          errors.push(
            tracePath + ': unknown mapped requirement ' + requirement,
          );
        }
      }
      if (json && getPointer(json, mapping.pointer) === undefined) {
        errors.push(
          tracePath + ': invalid pointer ' + artifact.path + mapping.pointer,
        );
      }
    }
  }

  const expected = [...allowedFiles]
    .filter((file) => file !== 'traceability.json')
    .sort();
  if ([...artifactNames].sort().join('\n') !== expected.join('\n')) {
    errors.push(tracePath + ': artifact set differs from allowlist');
  }
  for (const requirement of requirements) {
    if (!mapped.has(requirement)) {
      errors.push(tracePath + ': unmapped requirement ' + requirement);
    }
  }
}

function sameValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function checkSecurityInvariants(protocolRoot, errors) {
  const common = JSON.parse(
    readFileSync(join(protocolRoot, 'common.schema.json'), 'utf8'),
  );
  const request = JSON.parse(
    readFileSync(join(protocolRoot, 'request-envelope.schema.json'), 'utf8'),
  );
  const evidence = JSON.parse(
    readFileSync(
      join(protocolRoot, 'approval-evidence-reference.schema.json'),
      'utf8',
    ),
  );
  const receipt = JSON.parse(
    readFileSync(
      join(protocolRoot, 'signed-effect-receipt.schema.json'),
      'utf8',
    ),
  );
  const error = JSON.parse(
    readFileSync(join(protocolRoot, 'error-envelope.schema.json'), 'utf8'),
  );

  if (common.$defs?.DraftProtocolVersion?.const !== '0.1.0-draft') {
    errors.push('common.schema.json: draft protocol version drift');
  }
  if (
    common.$defs?.Nonce?.minLength !== 22 ||
    typeof common.$defs?.Nonce?.maxLength !== 'number' ||
    common.$defs?.Nonce?.maxLength > 128
  ) {
    errors.push(
      'common.schema.json: nonce no longer guarantees bounded 128-bit input',
    );
  }
  if (common.$defs?.StepIdentity?.properties?.attempt?.maximum !== 2147483647) {
    errors.push('common.schema.json: step attempt numeric bound drift');
  }
  if (
    !sameValues(common.$defs?.Artifact?.properties?.delivery?.enum, [
      'INLINE',
      'REFERENCE',
      'OUT_OF_BAND',
    ])
  ) {
    errors.push('common.schema.json: artifact delivery exclusivity drift');
  }
  if (
    evidence.properties?.scope?.const !== 'SINGLE_EFFECT' ||
    !sameValues(evidence.properties?.decision?.enum, ['APPROVED', 'DENIED'])
  ) {
    errors.push(
      'approval-evidence-reference.schema.json: single-effect decision boundary drift',
    );
  }
  for (const required of [
    'negotiation',
    'binding',
    'requestedEffect',
    'replayProtection',
    'signature',
  ]) {
    if (!(request.required ?? []).includes(required)) {
      errors.push('request-envelope.schema.json: missing required ' + required);
    }
  }
  for (const required of [
    'requestEnvelopeDigest',
    'negotiation',
    'binding',
    'requestReplayProtection',
    'authorization',
    'outcome',
    'signature',
  ]) {
    if (!(receipt.required ?? []).includes(required)) {
      errors.push(
        'signed-effect-receipt.schema.json: missing required ' + required,
      );
    }
  }
  const expectedErrorCodes = [
    'MALFORMED_ENVELOPE',
    'UNSUPPORTED_VERSION',
    'AUTHENTICATION_FAILED',
    'SIGNATURE_INVALID',
    'REPLAY_DETECTED',
    'IDEMPOTENCY_CONFLICT',
    'BINDING_MISMATCH',
    'EVIDENCE_INVALID',
    'EVIDENCE_REPLAY',
    'POLICY_UNAVAILABLE',
    'GATEWAY_UNAVAILABLE',
    'INTERNAL_ERROR',
  ];
  if (
    !sameValues(
      error.properties?.error?.properties?.code?.enum,
      expectedErrorCodes,
    )
  ) {
    errors.push('error-envelope.schema.json: bounded error code set drift');
  }
}

export function checkProtocolV0Governance(root) {
  const errors = [];
  const protocolRoot = join(root, protocolPath);
  if (!existsSync(protocolRoot)) return [protocolPath + ': missing directory'];

  const files = walk(protocolRoot, protocolRoot, errors).sort();
  for (const file of files) {
    if (!allowedFiles.has(file)) {
      errors.push(protocolPath + '/' + file + ': not allowlisted');
    }
  }
  for (const file of allowedFiles) {
    if (!files.includes(file)) {
      errors.push(protocolPath + '/' + file + ': required file missing');
    }
  }

  const inputs = checkInputManifest(root, errors);
  const requirementSource = readFileSync(
    join(protocolRoot, 'REQUIREMENTS.md'),
    'utf8',
  );
  const requirementMatches = [
    ...requirementSource.matchAll(/^\| [^\n]*?(PV0-[A-Z]+-\d{3})/gmu),
  ].map((match) => match[1]);
  const requirements = new Set(requirementMatches);
  if (requirements.size === 0) {
    errors.push('REQUIREMENTS.md: no stable requirement ids');
  }
  if (requirements.size !== requirementMatches.length) {
    errors.push('REQUIREMENTS.md: duplicate requirement id');
  }

  checkSchemas(protocolRoot, files, errors);
  const openapi = readFileSync(join(protocolRoot, 'openapi.yaml'), 'utf8');
  for (const marker of [
    'openapi: 3.2.0',
    'jsonSchemaDialect: https://json-schema.org/draft/2020-12/schema',
    '/protocol/versions:',
    '/v0/effect-requests:',
    'It is not a Gateway implementation',
  ]) {
    if (!openapi.includes(marker)) {
      errors.push('openapi.yaml: missing marker ' + marker);
    }
  }
  if (/^\s*servers\s*:/mu.test(openapi)) {
    errors.push('openapi.yaml: deployment server URLs are forbidden');
  }

  checkConformance(protocolRoot, errors);
  checkSecurityInvariants(protocolRoot, errors);
  checkTraceability(root, protocolRoot, requirements, inputs, errors);
  return errors;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = checkProtocolV0Governance(root);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error('protocol-v0-governance: ' + error);
    }
    process.exitCode = 1;
  } else {
    console.log(
      'Protocol v0 incubator governance: PASS (review-only; no gates closed)',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
