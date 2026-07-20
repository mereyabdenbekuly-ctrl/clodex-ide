import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const protocolPath = 'docs/protocol/agent-gateway-v0';
const inputPath = 'docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json';
const g01ReviewIntakePath =
  'docs/provenance/PROTOCOL_V0_G01_REVIEW_INTAKE.json';
const g01ReviewGuidePath = 'docs/provenance/PROTOCOL_V0_G01_REVIEW_INTAKE.md';
const g03ReviewIntakePath =
  'docs/provenance/PROTOCOL_V0_G03_REQUIREMENTS_REVIEW_INTAKE.json';
const g03ReviewGuidePath =
  'docs/provenance/PROTOCOL_V0_G03_REQUIREMENTS_REVIEW_INTAKE.md';
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
const g01InputIds = Array.from(
  { length: 11 },
  (_, index) => 'PV0-IN-' + String(index + 1).padStart(3, '0'),
);
const g01ExternalTermsInputIds = new Set(
  Array.from(
    { length: 5 },
    (_, index) => 'PV0-IN-' + String(index + 2).padStart(3, '0'),
  ),
);
const g01RepositoryBindingInputIds = new Set([
  'PV0-IN-001',
  'PV0-IN-007',
  'PV0-IN-009',
  'PV0-IN-010',
  'PV0-IN-011',
]);
const g01FrozenMainCommit = '374539f98dba20d1aade6208c2834928bf7fa09a';
const g01ReviewGuideSha256 =
  '227fd464b3a68de4ac02df701df6e6a7a74aadd4ddf81be4a9b54259c54343cb';
const g01PendingBlocker =
  'Independent provenance-owner review required by issue #75 has not been recorded.';
const g01FrozenReviewInputs = [
  {
    path: 'docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json',
    gitBlob: '5000ec24b5c90c0c0296f0d72076b1710518c1f3',
    sha256: '73d1b87194605704037162cb7cc5b47ac5fd2dc56dd6c0860d3757f34fd0b1b2',
  },
  {
    path: 'docs/provenance/PROTOCOL_EXTRACTION_AUDIT.md',
    gitBlob: '880bea15455756120a6ddd3ea8eab9a7d4571107',
    sha256: '04f8e2b28c2dd9071af8a5be6bf97f3d19ce380b2a16e887c2d40086feba4334',
  },
  {
    path: 'docs/protocol/agent-gateway-v0/traceability.json',
    gitBlob: 'a8857d64eb0a5a6891d45937dff5a6692e26b45c',
    sha256: 'e08704376b6955b894b6b0d6ae61de22d3ede1306695a4de96dc567b324b610d',
  },
  {
    path: 'docs/governance/OPEN_CLOSED_BOUNDARY.md',
    gitBlob: '53067da80054014fa0179d2bcfce125c3b8f292a',
    sha256: '25aac2097baf2f5dc9c336074c0ddd8286f9247cce9878d3e6aabfbb69e9b6c3',
  },
];
const g03FrozenMainCommit = '374539f98dba20d1aade6208c2834928bf7fa09a';
const g03PendingBlocker =
  'Independent requirements review required by issue #76 has not been recorded.';
const g03PrerequisiteReason =
  'PV0-G01 has no attributed terminal approval; an approved input set is not established.';
const g03GateOpenReason =
  'Setup-only intake; PV0-G01 is open and no attributed independent per-requirement review or exact approved catalogue revision is present.';
const g03FrozenReviewInputs = [
  {
    path: 'docs/protocol/agent-gateway-v0/REQUIREMENTS.md',
    gitBlob: '2a1768411bbf7c78c3c2eca09e86c4a5052477d1',
    sha256: 'e670ea4af006602d304f92b13d977067a7201e185d8db028010c101450958d52',
  },
  {
    path: 'docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json',
    gitBlob: '5000ec24b5c90c0c0296f0d72076b1710518c1f3',
    sha256: '73d1b87194605704037162cb7cc5b47ac5fd2dc56dd6c0860d3757f34fd0b1b2',
  },
  {
    path: 'docs/protocol/agent-gateway-v0/traceability.json',
    gitBlob: 'a8857d64eb0a5a6891d45937dff5a6692e26b45c',
    sha256: 'e08704376b6955b894b6b0d6ae61de22d3ede1306695a4de96dc567b324b610d',
  },
];
const g03ReviewGuideSha256 =
  '25632cda70e26e730ab07f649a0d0e9034e74818bb141de2343e7db6b91ef592';
const g03FrozenReviewGuideRows = g03FrozenReviewInputs.map(
  ({ path, gitBlob, sha256 }) =>
    `| \`${path}\` | \`${gitBlob}\` | \`${sha256}\` |`,
);
const g03FrozenRequirementIds = [
  'PV0-BOUND-001',
  'PV0-VER-001',
  'PV0-VER-002',
  'PV0-VER-003',
  'PV0-BIND-001',
  'PV0-BIND-002',
  'PV0-BIND-003',
  'PV0-BIND-004',
  'PV0-BIND-005',
  'PV0-ART-001',
  'PV0-ART-002',
  'PV0-ART-003',
  'PV0-ART-004',
  'PV0-ART-005',
  'PV0-SIG-001',
  'PV0-SIG-002',
  'PV0-SIG-003',
  'PV0-REPLAY-001',
  'PV0-REPLAY-002',
  'PV0-REPLAY-003',
  'PV0-EVID-001',
  'PV0-EVID-002',
  'PV0-EVID-003',
  'PV0-AUTH-001',
  'PV0-AUTH-002',
  'PV0-RCPT-001',
  'PV0-RCPT-002',
  'PV0-RCPT-003',
  'PV0-RCPT-004',
  'PV0-ERR-001',
  'PV0-ERR-002',
  'PV0-NEG-001',
  'PV0-NEG-002',
  'PV0-NEG-003',
  'PV0-NEG-004',
  'PV0-LIMIT-001',
  'PV0-PRIV-001',
  'PV0-PROV-001',
  'PV0-PROV-002',
];

function parseJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(label + ': invalid JSON: ' + error.message);
    return null;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkExactFields(value, expected, label, errors) {
  if (!isRecord(value)) {
    errors.push(label + ': expected an object');
    return false;
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (!sameValues(actual, sortedExpected)) {
    errors.push(
      label + ': fields must be exactly ' + sortedExpected.join(', '),
    );
    return false;
  }
  return true;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function checkSetupOnlyGuideClaims(source, path, errors) {
  for (const claim of [
    /\bPV0-G\d{2}\s+is\s+(?:CLOSED|GREEN|APPROVED)\b/iu,
    /\b(?:all\s+)?Protocol v0 gates?\s+(?:is|are)\s+(?:CLOSED|GREEN|APPROVED)\b/iu,
    /\b(?:Gateway implementation|private implementation|SDK publication|schema edits?|conformance payloads?|relicensing|enterprise(?:\/cloud)? implementation)\s+(?:is|are)\s+authorized\b/iu,
    /\bthis intake authorizes\b[^\n]*(?:Gateway|private implementation|SDK|schema|conformance|relicensing|enterprise|cloud)\b/iu,
  ]) {
    if (claim.test(source)) {
      errors.push(
        path + ': contradictory gate-closure or scope-authorization claim',
      );
    }
  }
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
  if (!document) return new Map();
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

  const inputs = new Map();
  for (const input of document.candidateInputs ?? []) {
    if (!/^PV0-IN-\d{3}$/u.test(input.id ?? '') || inputs.has(input.id)) {
      errors.push(inputPath + ': invalid or duplicate input id ' + input.id);
      continue;
    }
    inputs.set(input.id, input);
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
        input.observedTermsEvidence.length === 0 ||
        input.observedTermsEvidence.some(
          (entry) =>
            !isRecord(entry) ||
            typeof entry.locator !== 'string' ||
            entry.locator.length === 0 ||
            typeof entry.observation !== 'string' ||
            entry.observation.length === 0,
        ))
    ) {
      errors.push(
        inputPath + ': ' + input.id + ' lacks observed terms evidence',
      );
    }
    if (
      !input.status ||
      !input.permittedUse ||
      !input.prohibitedUse ||
      !input.blocker
    ) {
      errors.push(inputPath + ': ' + input.id + ' lacks review metadata');
    }
  }
  if (!sameValues([...inputs.keys()], g01InputIds)) {
    errors.push(
      inputPath + ': candidate input ids must be exactly PV0-IN-001..011',
    );
  }
  const redExposure = inputs.get('PV0-IN-008');
  if (
    redExposure?.type !== 'repository_context_exposure' ||
    redExposure?.status !== 'RED_FOR_PROTOCOL_AUTHORING'
  ) {
    errors.push(inputPath + ': PV0-IN-008 repository exposure must remain RED');
  }
  return inputs;
}

function checkG01ReviewIntake(root, inputs, errors) {
  const intake = join(root, g01ReviewIntakePath);
  if (!existsSync(intake)) {
    errors.push(g01ReviewIntakePath + ': required intake missing');
    return;
  }
  const document = parseJson(intake, g01ReviewIntakePath, errors);
  if (!document) return;
  if (
    !checkExactFields(
      document,
      [
        'artifactType',
        'baseline',
        'decisionVocabulary',
        'gateClosure',
        'gateId',
        'inputReviews',
        'issue',
        'reviewer',
        'schemaVersion',
        'scopeNonAuthorization',
        'signOff',
        'status',
      ],
      g01ReviewIntakePath,
      errors,
    )
  ) {
    return;
  }
  if (
    document.schemaVersion !== 1 ||
    document.artifactType !== 'PV0_G01_INDEPENDENT_REVIEW_INTAKE' ||
    document.gateId !== 'PV0-G01' ||
    document.status !== 'AWAITING_INDEPENDENT_REVIEW'
  ) {
    errors.push(g01ReviewIntakePath + ': invalid setup-only intake status');
  }

  if (
    !checkExactFields(
      document.issue,
      ['number', 'repository', 'url'],
      g01ReviewIntakePath + '.issue',
      errors,
    ) ||
    document.issue.repository !== 'mereyabdenbekuly-ctrl/clodex-ide' ||
    document.issue.number !== 75 ||
    document.issue.url !==
      'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/75'
  ) {
    errors.push(g01ReviewIntakePath + ': issue binding must remain #75');
  }

  if (
    !checkExactFields(
      document.baseline,
      ['frozenMainCommit', 'policy', 'reviewedMainCommit', 'reviewInputs'],
      g01ReviewIntakePath + '.baseline',
      errors,
    ) ||
    document.baseline.policy !== 'ISSUE_PINNED' ||
    document.baseline.frozenMainCommit !== g01FrozenMainCommit ||
    document.baseline.reviewedMainCommit !== null ||
    JSON.stringify(document.baseline.reviewInputs) !==
      JSON.stringify(g01FrozenReviewInputs)
  ) {
    errors.push(g01ReviewIntakePath + ': frozen issue baseline drift');
  }

  const reviewerFields = [
    'affiliation',
    'identity',
    'independenceDeclaration',
    'reviewDate',
    'role',
    'sourceExposureDeclaration',
  ];
  if (
    !checkExactFields(
      document.reviewer,
      reviewerFields,
      g01ReviewIntakePath + '.reviewer',
      errors,
    ) ||
    reviewerFields.some((field) => document.reviewer[field] !== null)
  ) {
    errors.push(
      g01ReviewIntakePath +
        ': setup intake must not claim reviewer attribution or completion',
    );
  }
  if (
    !sameValues(document.decisionVocabulary, [
      'PENDING',
      'APPROVE',
      'REJECT',
      'CONDITIONAL',
    ])
  ) {
    errors.push(g01ReviewIntakePath + ': decision vocabulary drift');
  }

  const inputReviews = Array.isArray(document.inputReviews)
    ? document.inputReviews
    : [];
  if (!Array.isArray(document.inputReviews)) {
    errors.push(g01ReviewIntakePath + ': inputReviews must be an array');
  }
  const reviewIds = inputReviews.map((review) => review?.inputId);
  if (!sameValues(reviewIds, g01InputIds)) {
    errors.push(
      g01ReviewIntakePath +
        ': inputReviews must contain exactly PV0-IN-001..011 once and in order',
    );
  }
  const reviewFields = [
    'conditions',
    'decidedPermittedUse',
    'decidedProhibitedUse',
    'decision',
    'inputId',
    'rationale',
    'redStatusRequirement',
    'requiredManifestStatus',
    'residualBlockers',
    'termsNoticeReview',
    'verification',
  ];
  const verificationFields = [
    'blocker',
    'gitBlob',
    'immutableRevision',
    'locator',
    'manifestStatus',
    'permittedUse',
    'prohibitedUse',
    'sha256',
    'version',
  ];
  const termsFields = [
    'applicability',
    'contentSha256',
    'exampleCodeDecision',
    'licenseOrTermsConclusion',
    'noticeConclusion',
    'officialRevision',
    'specificationTextDecision',
    'status',
    'testVectorDecision',
  ];
  for (const [index, review] of inputReviews.entries()) {
    const label = g01ReviewIntakePath + '.inputReviews[' + index + ']';
    if (!checkExactFields(review, reviewFields, label, errors)) continue;
    const input = inputs.get(review.inputId);
    if (!input) continue;
    const external = g01ExternalTermsInputIds.has(review.inputId);
    const expectedVerification = {
      locator: 'PENDING',
      version: external ? 'PENDING' : 'NOT_APPLICABLE',
      immutableRevision: 'PENDING',
      gitBlob: g01RepositoryBindingInputIds.has(review.inputId)
        ? 'PENDING'
        : 'NOT_APPLICABLE',
      sha256: review.inputId === 'PV0-IN-008' ? 'NOT_APPLICABLE' : 'PENDING',
      manifestStatus: 'PENDING',
      permittedUse: 'PENDING',
      prohibitedUse: 'PENDING',
      blocker: 'PENDING',
    };
    if (
      review.requiredManifestStatus !== input.status ||
      review.decision !== 'PENDING' ||
      review.decidedPermittedUse !== null ||
      review.decidedProhibitedUse !== null ||
      review.rationale !== null ||
      !sameValues(review.conditions, []) ||
      !sameValues(review.residualBlockers, [g01PendingBlocker]) ||
      review.redStatusRequirement !==
        (review.inputId === 'PV0-IN-008'
          ? 'MUST_REMAIN_RED_FOR_PROTOCOL_AUTHORING'
          : 'NOT_APPLICABLE')
    ) {
      errors.push(label + ': terminal review evidence is not present');
    }
    if (
      !checkExactFields(
        review.verification,
        verificationFields,
        label + '.verification',
        errors,
      ) ||
      JSON.stringify(review.verification) !==
        JSON.stringify(expectedVerification)
    ) {
      errors.push(label + ': verification must remain pending');
    }
    if (
      !checkExactFields(
        review.termsNoticeReview,
        termsFields,
        label + '.termsNoticeReview',
        errors,
      ) ||
      review.termsNoticeReview.applicability !==
        (external ? 'REQUIRED' : 'NOT_APPLICABLE') ||
      review.termsNoticeReview.status !==
        (external ? 'PENDING' : 'NOT_APPLICABLE') ||
      termsFields
        .filter((field) => field !== 'applicability' && field !== 'status')
        .some((field) => review.termsNoticeReview[field] !== null)
    ) {
      errors.push(label + ': terms and notice review slot drift');
    }
  }

  if (
    !checkExactFields(
      document.gateClosure,
      ['eligible', 'gateRemainsOpen', 'reason', 'unresolvedInputIds'],
      g01ReviewIntakePath + '.gateClosure',
      errors,
    ) ||
    document.gateClosure.eligible !== false ||
    document.gateClosure.gateRemainsOpen !== true ||
    !sameValues(document.gateClosure.unresolvedInputIds, g01InputIds) ||
    document.gateClosure.reason !==
      'Setup-only intake; no attributed independent review or terminal input decision is present.'
  ) {
    errors.push(g01ReviewIntakePath + ': PV0-G01 must remain open');
  }

  const scopeFields = [
    'conformancePayloadsAuthorized',
    'gatewayImplementationAuthorized',
    'otherGateClosuresAuthorized',
    'relicensingAuthorized',
    'schemaEditsAuthorized',
    'sdkPublicationAuthorized',
  ];
  if (
    !checkExactFields(
      document.scopeNonAuthorization,
      scopeFields,
      g01ReviewIntakePath + '.scopeNonAuthorization',
      errors,
    ) ||
    scopeFields
      .filter((field) => field !== 'otherGateClosuresAuthorized')
      .some((field) => document.scopeNonAuthorization[field] !== false) ||
    !sameValues(document.scopeNonAuthorization.otherGateClosuresAuthorized, [])
  ) {
    errors.push(g01ReviewIntakePath + ': prohibited scope was authorized');
  }

  const signOffFields = [
    'evidenceReference',
    'signedAt',
    'signedBy',
    'statement',
  ];
  if (
    !checkExactFields(
      document.signOff,
      signOffFields,
      g01ReviewIntakePath + '.signOff',
      errors,
    ) ||
    signOffFields.some((field) => document.signOff[field] !== null)
  ) {
    errors.push(g01ReviewIntakePath + ': setup intake must remain unsigned');
  }

  const guide = join(root, g01ReviewGuidePath);
  if (!existsSync(guide)) {
    errors.push(g01ReviewGuidePath + ': required guide missing');
    return;
  }
  const guideSource = readFileSync(guide, 'utf8');
  if (digest(guide) !== g01ReviewGuideSha256) {
    errors.push(g01ReviewGuidePath + ': exact setup-only guide content drift');
  }
  checkSetupOnlyGuideClaims(guideSource, g01ReviewGuidePath, errors);
  for (const marker of [
    'setup only; awaiting a named independent provenance owner',
    g01FrozenMainCommit,
    'PV0-IN-008` must remain',
    'This scaffold cannot prove reviewer independence',
    'all `PV0-G01` through `PV0-G10`',
  ]) {
    if (!guideSource.includes(marker)) {
      errors.push(g01ReviewGuidePath + ': missing boundary marker ' + marker);
    }
  }
}

function checkG03RequirementsReviewIntake(root, errors) {
  const intake = join(root, g03ReviewIntakePath);
  if (!existsSync(intake)) {
    errors.push(g03ReviewIntakePath + ': required intake missing');
    return;
  }
  const document = parseJson(intake, g03ReviewIntakePath, errors);
  if (!document) return;
  if (
    !checkExactFields(
      document,
      [
        'approvedCatalogueRevision',
        'artifactType',
        'assessmentVocabulary',
        'baseline',
        'catalogueCompletenessReview',
        'decisionVocabulary',
        'gateClosure',
        'gateId',
        'issue',
        'methodConstraints',
        'prerequisiteState',
        'requirementReviews',
        'reviewer',
        'schemaVersion',
        'scopeNonAuthorization',
        'signOff',
        'status',
      ],
      g03ReviewIntakePath,
      errors,
    )
  ) {
    return;
  }
  if (
    document.schemaVersion !== 1 ||
    document.artifactType !==
      'PV0_G03_INDEPENDENT_REQUIREMENTS_REVIEW_INTAKE' ||
    document.gateId !== 'PV0-G03' ||
    document.status !== 'AWAITING_INDEPENDENT_REQUIREMENTS_REVIEW'
  ) {
    errors.push(g03ReviewIntakePath + ': invalid setup-only intake status');
  }

  if (
    !checkExactFields(
      document.issue,
      ['number', 'repository', 'url'],
      g03ReviewIntakePath + '.issue',
      errors,
    ) ||
    document.issue.repository !== 'mereyabdenbekuly-ctrl/clodex-ide' ||
    document.issue.number !== 76 ||
    document.issue.url !==
      'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/76'
  ) {
    errors.push(g03ReviewIntakePath + ': issue binding must remain #76');
  }

  if (
    !checkExactFields(
      document.baseline,
      ['frozenMainCommit', 'policy', 'reviewedMainCommit', 'reviewInputs'],
      g03ReviewIntakePath + '.baseline',
      errors,
    ) ||
    document.baseline.policy !== 'ISSUE_PINNED' ||
    document.baseline.frozenMainCommit !== g03FrozenMainCommit ||
    document.baseline.reviewedMainCommit !== null ||
    JSON.stringify(document.baseline.reviewInputs) !==
      JSON.stringify(g03FrozenReviewInputs)
  ) {
    errors.push(g03ReviewIntakePath + ': frozen issue baseline drift');
  }

  if (
    !checkExactFields(
      document.prerequisiteState,
      [
        'approvedInputEvidenceReference',
        'approvedInputIds',
        'reason',
        'rederivationEligible',
        'requiredGate',
        'requiredGateStatus',
      ],
      g03ReviewIntakePath + '.prerequisiteState',
      errors,
    ) ||
    document.prerequisiteState.requiredGate !== 'PV0-G01' ||
    document.prerequisiteState.requiredGateStatus !== 'OPEN' ||
    document.prerequisiteState.approvedInputEvidenceReference !== null ||
    !sameValues(document.prerequisiteState.approvedInputIds, []) ||
    document.prerequisiteState.rederivationEligible !== false ||
    document.prerequisiteState.reason !== g03PrerequisiteReason
  ) {
    errors.push(
      g03ReviewIntakePath +
        ': PV0-G01 prerequisite must remain unresolved and fail closed',
    );
  }

  const reviewerFields = [
    'affiliation',
    'approvedInputsOnlyDeclaration',
    'identity',
    'implementationStructureNonAuthorityDeclaration',
    'independenceDeclaration',
    'reviewDate',
    'role',
    'sourceExposureDeclaration',
  ];
  if (
    !checkExactFields(
      document.reviewer,
      reviewerFields,
      g03ReviewIntakePath + '.reviewer',
      errors,
    ) ||
    reviewerFields.some((field) => document.reviewer[field] !== null)
  ) {
    errors.push(
      g03ReviewIntakePath +
        ': setup intake must not claim reviewer attribution or completion',
    );
  }
  if (
    !sameValues(document.decisionVocabulary, [
      'PENDING',
      'APPROVE',
      'REVISE',
      'REJECT',
    ])
  ) {
    errors.push(g03ReviewIntakePath + ': decision vocabulary drift');
  }
  if (
    !sameValues(document.assessmentVocabulary, [
      'PENDING',
      'SATISFIED',
      'DEFICIENT',
      'NOT_APPLICABLE',
    ])
  ) {
    errors.push(g03ReviewIntakePath + ': assessment vocabulary drift');
  }

  const methodFields = [
    'approvedInputsOnly',
    'currentImplementationStructureNormative',
    'currentSchemaStructureNormative',
    'deploymentIndependentAcceptanceCriteriaOnly',
    'deploymentIndependentThreatCriteriaOnly',
    'redSourceAuthoringAllowed',
    'traceabilityFileFieldMappingsNormative',
  ];
  const expectedMethod = {
    approvedInputsOnly: true,
    deploymentIndependentThreatCriteriaOnly: true,
    deploymentIndependentAcceptanceCriteriaOnly: true,
    currentImplementationStructureNormative: false,
    currentSchemaStructureNormative: false,
    traceabilityFileFieldMappingsNormative: false,
    redSourceAuthoringAllowed: false,
  };
  if (
    !checkExactFields(
      document.methodConstraints,
      methodFields,
      g03ReviewIntakePath + '.methodConstraints',
      errors,
    ) ||
    JSON.stringify(document.methodConstraints) !==
      JSON.stringify(expectedMethod)
  ) {
    errors.push(
      g03ReviewIntakePath +
        ': approved-input and implementation-independence constraints drift',
    );
  }

  const reviews = Array.isArray(document.requirementReviews)
    ? document.requirementReviews
    : [];
  if (!Array.isArray(document.requirementReviews)) {
    errors.push(g03ReviewIntakePath + ': requirementReviews must be an array');
  }
  const reviewIds = reviews.map((review) => review?.requirementId);
  if (!sameValues(reviewIds, g03FrozenRequirementIds)) {
    errors.push(
      g03ReviewIntakePath +
        ': requirementReviews must contain exactly the 39 frozen requirement ids once and in order',
    );
  }
  const reviewFields = [
    'assessment',
    'conditions',
    'decision',
    'implementationStructureReview',
    'proposedRequirementText',
    'rationale',
    'requirementId',
    'residualBlockers',
    'sourceDerivation',
  ];
  const assessmentFields = [
    'clarity',
    'conflictReview',
    'necessity',
    'privacyConstraintReview',
    'securityConstraintReview',
    'testability',
  ];
  const sourceFields = [
    'approvedInputIds',
    'deploymentIndependentAcceptanceCriteria',
    'deploymentIndependentThreatCriteria',
    'evidenceReferences',
    'status',
  ];
  const implementationFields = [
    'normativeImplementationDependencies',
    'status',
    'traceabilityComparisonNotes',
  ];
  for (const [index, review] of reviews.entries()) {
    const label = g03ReviewIntakePath + '.requirementReviews[' + index + ']';
    if (!checkExactFields(review, reviewFields, label, errors)) continue;
    if (
      review.decision !== 'PENDING' ||
      review.proposedRequirementText !== null ||
      review.rationale !== null ||
      !sameValues(review.conditions, []) ||
      !sameValues(review.residualBlockers, [g03PendingBlocker])
    ) {
      errors.push(
        label + ': terminal requirement review evidence is not present',
      );
    }
    if (
      !checkExactFields(
        review.assessment,
        assessmentFields,
        label + '.assessment',
        errors,
      ) ||
      assessmentFields.some((field) => review.assessment[field] !== 'PENDING')
    ) {
      errors.push(label + ': requirement assessment must remain pending');
    }
    if (
      !checkExactFields(
        review.sourceDerivation,
        sourceFields,
        label + '.sourceDerivation',
        errors,
      ) ||
      review.sourceDerivation.status !== 'PENDING' ||
      !sameValues(review.sourceDerivation.approvedInputIds, []) ||
      !sameValues(review.sourceDerivation.evidenceReferences, []) ||
      review.sourceDerivation.deploymentIndependentThreatCriteria !== null ||
      review.sourceDerivation.deploymentIndependentAcceptanceCriteria !== null
    ) {
      errors.push(
        label + ': approved-input derivation must remain absent and pending',
      );
    }
    if (
      !checkExactFields(
        review.implementationStructureReview,
        implementationFields,
        label + '.implementationStructureReview',
        errors,
      ) ||
      review.implementationStructureReview.status !== 'PENDING' ||
      review.implementationStructureReview
        .normativeImplementationDependencies !== null ||
      review.implementationStructureReview.traceabilityComparisonNotes !== null
    ) {
      errors.push(
        label + ': implementation-structure review must remain pending',
      );
    }
  }

  const completenessFields = [
    'approvedInputsReviewed',
    'conflictingRequirementPairs',
    'deploymentIndependentAcceptanceCriteriaReview',
    'deploymentIndependentThreatCriteriaReview',
    'missingPrivacyRequirements',
    'missingSecurityRequirements',
    'otherMissingRequirements',
    'rationale',
    'residualBlockers',
    'status',
  ];
  if (
    !checkExactFields(
      document.catalogueCompletenessReview,
      completenessFields,
      g03ReviewIntakePath + '.catalogueCompletenessReview',
      errors,
    ) ||
    document.catalogueCompletenessReview.status !== 'PENDING' ||
    document.catalogueCompletenessReview.approvedInputsReviewed !== 'PENDING' ||
    document.catalogueCompletenessReview
      .deploymentIndependentThreatCriteriaReview !== 'PENDING' ||
    document.catalogueCompletenessReview
      .deploymentIndependentAcceptanceCriteriaReview !== 'PENDING' ||
    completenessFields
      .filter((field) =>
        [
          'conflictingRequirementPairs',
          'missingPrivacyRequirements',
          'missingSecurityRequirements',
          'otherMissingRequirements',
          'rationale',
        ].includes(field),
      )
      .some((field) => document.catalogueCompletenessReview[field] !== null) ||
    !sameValues(document.catalogueCompletenessReview.residualBlockers, [
      g03PendingBlocker,
    ])
  ) {
    errors.push(
      g03ReviewIntakePath +
        ': catalogue completeness review must remain pending',
    );
  }

  const revisionFields = [
    'commit',
    'gitBlob',
    'path',
    'requirementIds',
    'sha256',
    'status',
  ];
  if (
    !checkExactFields(
      document.approvedCatalogueRevision,
      revisionFields,
      g03ReviewIntakePath + '.approvedCatalogueRevision',
      errors,
    ) ||
    document.approvedCatalogueRevision.status !== 'PENDING' ||
    revisionFields
      .filter((field) => !['requirementIds', 'status'].includes(field))
      .some((field) => document.approvedCatalogueRevision[field] !== null) ||
    !sameValues(document.approvedCatalogueRevision.requirementIds, [])
  ) {
    errors.push(
      g03ReviewIntakePath + ': approved catalogue revision is absent',
    );
  }

  if (
    !checkExactFields(
      document.gateClosure,
      [
        'catalogueCompletenessUnresolved',
        'eligible',
        'gateRemainsOpen',
        'reason',
        'unresolvedRequirementIds',
      ],
      g03ReviewIntakePath + '.gateClosure',
      errors,
    ) ||
    document.gateClosure.eligible !== false ||
    document.gateClosure.gateRemainsOpen !== true ||
    document.gateClosure.catalogueCompletenessUnresolved !== true ||
    !sameValues(
      document.gateClosure.unresolvedRequirementIds,
      g03FrozenRequirementIds,
    ) ||
    document.gateClosure.reason !== g03GateOpenReason
  ) {
    errors.push(g03ReviewIntakePath + ': PV0-G03 must remain open');
  }

  const scopeFields = [
    'codeGenerationAuthorized',
    'conformancePayloadsAuthorized',
    'enterpriseCloudImplementationAuthorized',
    'gatewayImplementationAuthorized',
    'otherGateClosuresAuthorized',
    'relicensingAuthorized',
    'requirementsCatalogueChangesAuthorized',
    'schemaEditsAuthorized',
    'sdkPublicationAuthorized',
  ];
  if (
    !checkExactFields(
      document.scopeNonAuthorization,
      scopeFields,
      g03ReviewIntakePath + '.scopeNonAuthorization',
      errors,
    ) ||
    scopeFields
      .filter((field) => field !== 'otherGateClosuresAuthorized')
      .some((field) => document.scopeNonAuthorization[field] !== false) ||
    !sameValues(document.scopeNonAuthorization.otherGateClosuresAuthorized, [])
  ) {
    errors.push(g03ReviewIntakePath + ': prohibited scope was authorized');
  }

  const signOffFields = [
    'evidenceReference',
    'signedAt',
    'signedBy',
    'statement',
  ];
  if (
    !checkExactFields(
      document.signOff,
      signOffFields,
      g03ReviewIntakePath + '.signOff',
      errors,
    ) ||
    signOffFields.some((field) => document.signOff[field] !== null)
  ) {
    errors.push(g03ReviewIntakePath + ': setup intake must remain unsigned');
  }

  const guide = join(root, g03ReviewGuidePath);
  if (!existsSync(guide)) {
    errors.push(g03ReviewGuidePath + ': required guide missing');
    return;
  }
  const guideSource = readFileSync(guide, 'utf8');
  const guideBindingRows = guideSource
    .split('\n')
    .filter((line) => line.startsWith('| `docs/'));
  if (!sameValues(guideBindingRows, g03FrozenReviewGuideRows)) {
    errors.push(g03ReviewGuidePath + ': frozen baseline table drift');
  }
  if (digest(guide) !== g03ReviewGuideSha256) {
    errors.push(g03ReviewGuidePath + ': exact setup-only guide content drift');
  }
  checkSetupOnlyGuideClaims(guideSource, g03ReviewGuidePath, errors);
  for (const marker of [
    'setup only; awaiting a named independent requirements reviewer',
    g03FrozenMainCommit,
    'exactly 39 frozen requirement IDs',
    '`PV0-G01` remains open',
    '`traceability.json` is non-normative comparison material',
    'This scaffold cannot prove reviewer independence',
    '`PV0-G10` remain OPEN',
  ]) {
    if (!guideSource.includes(marker)) {
      errors.push(g03ReviewGuidePath + ': missing boundary marker ' + marker);
    }
  }
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
  checkG01ReviewIntake(root, inputs, errors);
  checkG03RequirementsReviewIntake(root, errors);
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
