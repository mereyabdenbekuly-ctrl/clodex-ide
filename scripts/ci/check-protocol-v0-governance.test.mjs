import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  for (const file of [
    'PROTOCOL_V0_G01_REVIEW_INTAKE.json',
    'PROTOCOL_V0_G01_REVIEW_INTAKE.md',
  ]) {
    cpSync(
      join(repositoryRoot, 'docs', 'provenance', file),
      join(root, 'docs', 'provenance', file),
    );
  }
  return root;
}

function mutateG01Intake(root, mutate) {
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_G01_REVIEW_INTAKE.json',
  );
  const document = JSON.parse(readFileSync(path, 'utf8'));
  mutate(document);
  writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
}

test('accepts the review-only Protocol v0 incubator baseline', () => {
  assert.deepEqual(checkProtocolV0Governance(repositoryRoot), []);
});

test('requires the setup-only PV0-G01 review intake', () => {
  const root = fixture();
  rmSync(
    join(root, 'docs', 'provenance', 'PROTOCOL_V0_G01_REVIEW_INTAKE.json'),
  );
  assert.ok(
    checkProtocolV0Governance(root).some((error) =>
      /required intake missing/u.test(error),
    ),
  );
});

test('rejects PV0-G01 frozen issue baseline drift', () => {
  const root = fixture();
  mutateG01Intake(root, (document) => {
    document.baseline.frozenMainCommit = 'f'.repeat(40);
    document.baseline.reviewInputs[3].sha256 = 'a'.repeat(64);
  });
  assert.ok(
    checkProtocolV0Governance(root).some((error) =>
      /frozen issue baseline drift/u.test(error),
    ),
  );
});

test('rejects missing, duplicate, and unknown PV0-G01 input reviews', () => {
  const cases = [
    (document) => document.inputReviews.pop(),
    (document) => {
      document.inputReviews[10] = structuredClone(document.inputReviews[0]);
    },
    (document) => {
      document.inputReviews[10].inputId = 'PV0-IN-999';
    },
  ];
  for (const mutate of cases) {
    const root = fixture();
    mutateG01Intake(root, mutate);
    assert.ok(
      checkProtocolV0Governance(root).some((error) =>
        /inputReviews must contain exactly PV0-IN-001\.\.011/u.test(error),
      ),
    );
  }
});

test('rejects a fabricated terminal PV0-G01 review or scope authorization', () => {
  const root = fixture();
  mutateG01Intake(root, (document) => {
    document.status = 'COMPLETE';
    document.reviewer.identity = 'self-approved reviewer';
    document.reviewer.reviewDate = '2026-07-20';
    document.inputReviews[0].decision = 'APPROVE';
    document.inputReviews[0].residualBlockers = [];
    document.gateClosure.eligible = true;
    document.gateClosure.gateRemainsOpen = false;
    document.scopeNonAuthorization.schemaEditsAuthorized = true;
    document.signOff.signedBy = 'self-approved reviewer';
  });
  const errors = checkProtocolV0Governance(root);
  for (const expected of [
    'invalid setup-only intake status',
    'must not claim reviewer attribution',
    'terminal review evidence is not present',
    'PV0-G01 must remain open',
    'prohibited scope was authorized',
    'setup intake must remain unsigned',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected,
    );
  }
});

test('rejects terms-slot or RED-preservation drift in PV0-G01 intake', () => {
  const root = fixture();
  mutateG01Intake(root, (document) => {
    const external = document.inputReviews.find(
      ({ inputId }) => inputId === 'PV0-IN-003',
    );
    external.termsNoticeReview.status = 'NOT_APPLICABLE';
    external.termsNoticeReview.licenseOrTermsConclusion = 'assumed allowed';
    const exposure = document.inputReviews.find(
      ({ inputId }) => inputId === 'PV0-IN-008',
    );
    exposure.redStatusRequirement = 'NOT_APPLICABLE';
  });
  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) => /terms and notice review slot drift/u.test(error)),
  );
  assert.ok(
    errors.some((error) =>
      /terminal review evidence is not present/u.test(error),
    ),
  );
});

test('rejects incomplete manifest review metadata and fake RED substitution', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  delete manifest.candidateInputs[0].prohibitedUse;
  manifest.candidateInputs.find(({ id }) => id === 'PV0-IN-008').status =
    'YELLOW_REVIEW_REQUIRED';
  manifest.candidateInputs.push({
    id: 'PV0-IN-999',
    type: 'repository_context_exposure',
    locator: 'fake exposure',
    immutableRevision: 'f'.repeat(40),
    status: 'RED_FOR_PROTOCOL_AUTHORING',
    permittedUse: 'none',
    prohibitedUse: 'all',
    blocker: 'fake',
  });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const errors = checkProtocolV0Governance(root);
  assert.ok(errors.some((error) => /lacks review metadata/u.test(error)));
  assert.ok(
    errors.some((error) =>
      /PV0-IN-008 repository exposure must remain RED/u.test(error),
    ),
  );
  assert.ok(
    errors.some((error) => /candidate input ids must be exactly/u.test(error)),
  );
});

test('rejects malformed public-standard observed terms evidence', () => {
  const root = fixture();
  const path = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.candidateInputs.find(
    ({ id }) => id === 'PV0-IN-004',
  ).observedTermsEvidence = [{}];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  assert.ok(
    checkProtocolV0Governance(root).some((error) =>
      /lacks observed terms evidence/u.test(error),
    ),
  );
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

test('keeps PV0-G01 explicitly open in manifest and traceability', () => {
  const root = fixture();
  const manifestPath = join(
    root,
    'docs',
    'provenance',
    'PROTOCOL_V0_INPUT_MANIFEST.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.openGates = manifest.openGates.filter((gate) => gate !== 'PV0-G01');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const tracePath = join(
    root,
    'docs',
    'protocol',
    'agent-gateway-v0',
    'traceability.json',
  );
  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  trace.unclosedGates = trace.unclosedGates.filter(
    (gate) => gate !== 'PV0-G01',
  );
  writeFileSync(tracePath, JSON.stringify(trace, null, 2) + '\n');

  const errors = checkProtocolV0Governance(root);
  assert.ok(
    errors.some((error) =>
      /all Protocol v0 gates must remain explicitly open/u.test(error),
    ),
  );
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
