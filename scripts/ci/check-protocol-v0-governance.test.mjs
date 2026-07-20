import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProtocolV0Governance } from './check-protocol-v0-governance.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clodex-protocol-v0-'));
  mkdirSync(join(root, 'docs', 'protocol'), { recursive: true });
  mkdirSync(join(root, 'docs', 'provenance'), { recursive: true });
  cpSync(
    join(repositoryRoot, 'docs', 'protocol', 'agent-gateway-v0'),
    join(root, 'docs', 'protocol', 'agent-gateway-v0'),
    { recursive: true },
  );
  cpSync(
    join(
      repositoryRoot,
      'docs',
      'provenance',
      'PROTOCOL_V0_INPUT_MANIFEST.json',
    ),
    join(root, 'docs', 'provenance', 'PROTOCOL_V0_INPUT_MANIFEST.json'),
  );
  return root;
}

test('accepts the review-only Protocol v0 incubator baseline', () => {
  assert.deepEqual(checkProtocolV0Governance(repositoryRoot), []);
});

test('rejects protocol artifact hash drift', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'common.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  schema.description = 'tampered after traceability review';
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) => /hash drift for common\.schema\.json/u.test(error)),
  );
});

test('rejects premature conformance fixture authoring', () => {
  const root = fixture();
  const directory = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'conformance',
    'agw-v0-valid-request-001',
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'input.json'), '{}\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /fixture payloads or runners are not authorized/u.test(error),
    ),
  );
  assert.ok(errors.some((error) => /not allowlisted/u.test(error)));
});

test('rejects premature publication or private implementation authorization', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.publicationAuthorized = true;
  manifest.privateImplementationAuthorized = true;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /invalid review-only authorization state/u.test(error),
    ),
  );
});

test('rejects an unpinned repository input', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const input = manifest.candidateInputs.find(
    (candidate) => candidate.id === 'PV0-IN-009',
  );
  delete input.immutableRevision;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) => /PV0-IN-009 lacks immutable revision/u.test(error)),
  );
});

test('rejects public standards without observed terms evidence', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const input = manifest.candidateInputs.find(
    (candidate) => candidate.id === 'PV0-IN-003',
  );
  delete input.observedTermsEvidence;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /PV0-IN-003 lacks observed terms evidence/u.test(error),
    ),
  );
});

test('rejects a traceability record that hides an open gate', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'traceability.json',
  );
  const trace = JSON.parse(readFileSync(path, 'utf8'));
  trace.unclosedGates = trace.unclosedGates.filter(
    (gate) => gate !== 'PV0-G06',
  );
  writeFileSync(path, JSON.stringify(trace, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(errors.some((error) => /invalid incubator status/u.test(error)));
});

test('rejects weakening the single-effect evidence boundary', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'approval-evidence-reference.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  schema.properties.scope.const = 'MULTI_EFFECT';
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /single-effect decision boundary drift/u.test(error),
    ),
  );
});

test('rejects weakening the nonce lower bound', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'common.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  schema.$defs.Nonce.minLength = 8;
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /nonce no longer guarantees bounded 128-bit input/u.test(error),
    ),
  );
});

test('rejects removing the nonce upper bound', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'common.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  delete schema.$defs.Nonce.maxLength;
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /nonce no longer guarantees bounded 128-bit input/u.test(error),
    ),
  );
});

test('rejects schema references that escape the incubator allowlist', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'request-envelope.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  schema.properties.protocolVersion.$ref =
    '../../../provenance/PROTOCOL_V0_INPUT_MANIFEST.json';
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) => /external or non-allowlisted ref/u.test(error)),
  );
});

test('rejects unresolved local schema reference pointers', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'request-envelope.schema.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  schema.properties.protocolVersion.$ref =
    'common.schema.json#/$defs/DoesNotExist';
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(errors.some((error) => /unresolved ref pointer/u.test(error)));
});

test('rejects executable files in the schema-only protocol directory', () => {
  const root = fixture();
  writeFileSync(
    join(root, 'docs', 'protocol', 'agent-gateway-v0', 'server.ts'),
    'export const gateway = true;\n',
  );
  const errors = checkProtocolV0Governance(root);
  assert.ok(errors.some((error) => /server\.ts: not allowlisted/u.test(error)));
});
