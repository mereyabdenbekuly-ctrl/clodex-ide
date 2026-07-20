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
const authoringIntakePath =
  'docs/provenance/PROTOCOL_V0_G02_G04_G05_AUTHORING_INTAKE.json';
const authoringGuidePath =
  'docs/provenance/PROTOCOL_V0_G02_G04_G05_AUTHORING_INTAKE.md';
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
const authoringIntakeSha256 =
  'ff14d0b97c9601bb8f028ba557ff9f6d86543996b0954100ad8574f9375de43d';
const authoringGuideSha256 =
  '1a3b55a0345984d68a2c064a565900f8d12a16110f442af7fd53daa53be65f54';
const authoringIssueBodySha256 =
  'f422c8187e1a9b1cb8975ecc513acb3a33fa2095651bef4a93c550522cb3a1fc';
const authoringG01IssueBodySha256 =
  '3394dd728b9d3e3d16efe8b6d3e1a0eb7d91990f9e31dec0cbc6827c69b8082f';
const authoringG03IssueBodySha256 =
  '4688df7067b30271abca89a0929c5ebe828dc85b2a34f9769f05c5386190a709';
const authoringGateScope = ['PV0-G02', 'PV0-G04', 'PV0-G05'];
const authoringExternalInputIds = [
  'PV0-IN-002',
  'PV0-IN-003',
  'PV0-IN-004',
  'PV0-IN-005',
  'PV0-IN-006',
];
const authoringRepositoryDerivedInputIds = [
  'PV0-IN-001',
  'PV0-IN-007',
  'PV0-IN-009',
  'PV0-IN-010',
  'PV0-IN-011',
];
const authoringProhibitedContextClasses = [
  'CLODEX_IDE_IMPLEMENTATION_SOURCE_ANY_REVISION',
  'PROTOCOL_V0_INCUBATOR_PR74_AND_DESCENDANTS',
  'IMPLEMENTATION_TYPES_VALIDATORS_TESTS_FIXTURES_CONSTANTS_COMMENTS',
  'DISTINCTIVE_LITERALS_AND_CURRENT_MODULE_STRUCTURE',
  'STAGEWISE_DERIVED_AGENT_SHELL_AGENT_CORE_KARTON_BROWSER_IPC_UI_RUNTIME',
  'RUNNER_SDK_SOURCE_OR_EXPORTS',
  'PRIOR_AI_SESSION_MEMORY_SUMMARY_OR_FORK_WITH_PROHIBITED_CONTEXT',
  'PRIVATE_REPOSITORY_CUSTOMER_PRODUCTION_OR_RESTRICTED_MATERIAL',
  'UNKNOWN_OR_UNRECORDED_INPUT',
];
const authoringBlockers = [
  'PV0_G01_OPEN',
  'PV0_G03_OPEN',
  'NAMED_CLEAN_AUTHOR_MISSING',
  'NAMED_CLEAN_REVIEWER_MISSING',
  'SOURCE_EXPOSURE_UNRESOLVED',
  'APPROVED_AUTHOR_PACKET_UNBOUND',
  'FRESH_WORKSPACE_UNBOUND',
  'TOOL_CONTEXT_UNBOUND',
  'ENVIRONMENT_ATTESTATION_MISSING',
];
const authoringRequiredRunFields = [
  'toolRunId',
  'provider',
  'product',
  'modelOrVersion',
  'build',
  'freshSession',
  'memoryEnabled',
  'historyImported',
  'retrievalEnabled',
  'repositoryMounts',
  'mcpServers',
  'networkPolicy',
  'systemInstructionsSha256',
  'taskPromptSha256',
  'approvedPacketSha256',
  'transcriptSha256',
  'generatedOutputBindings',
];
const authoringRequiredPerFileFields = [
  'path',
  'sha256',
  'gitBlob',
  'creationCommit',
  'authorParticipantIds',
  'reviewerParticipantIds',
  'approvedInputBindings',
  'requirementIds',
  'toolRunIds',
  'generationMethod',
  'manualEditEvidence',
  'reviewDecision',
  'reviewRationale',
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
    /\b(?:fresh\s+)?schema\s+(?:authorship|authoring|changes?|edits?)\s+(?:is|are)\s+authorized\b/iu,
    /\bauthoringMayBegin\s*[:=]\s*true\b/iu,
    /\bexecution\s+(?:is\s+)?(?:UNBLOCKED|AUTHORIZED|APPROVED)\b/iu,
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

function checkConstrainedAuthoringIntake(root, errors) {
  const intake = join(root, authoringIntakePath);
  if (!existsSync(intake)) {
    errors.push(authoringIntakePath + ': required intake missing');
    return;
  }
  const document = parseJson(intake, authoringIntakePath, errors);
  if (!document) return;
  if (digest(intake) !== authoringIntakeSha256) {
    errors.push(
      authoringIntakePath + ': exact setup-only intake content drift',
    );
  }
  if (
    !checkExactFields(
      document,
      [
        'artifactType',
        'executionGate',
        'frozenBindings',
        'gateClosure',
        'gateScope',
        'inputPolicy',
        'issue',
        'participantSlots',
        'protocolGateState',
        'provenancePlan',
        'schemaVersion',
        'scopeNonAuthorization',
        'signOff',
        'sourceExposurePolicy',
        'status',
        'toolingAndEnvironment',
      ],
      authoringIntakePath,
      errors,
    )
  ) {
    return;
  }
  if (
    document.schemaVersion !== 1 ||
    document.artifactType !==
      'PV0_G02_G04_G05_CONSTRAINED_AUTHORING_SETUP_INTAKE' ||
    document.status !== 'SETUP_ONLY_EXECUTION_BLOCKED'
  ) {
    errors.push(authoringIntakePath + ': invalid setup-only intake status');
  }

  const expectedIssue = {
    repository: 'mereyabdenbekuly-ctrl/clodex-ide',
    number: 77,
    url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/77',
    title: 'Protocol v0: constrained authoring plan for PV0-G02/G04/G05',
    createdAt: '2026-07-20T03:30:58Z',
    updatedAt: '2026-07-20T03:30:58Z',
    bodySha256: authoringIssueBodySha256,
  };
  if (
    !checkExactFields(
      document.issue,
      [
        'bodySha256',
        'createdAt',
        'number',
        'repository',
        'title',
        'updatedAt',
        'url',
      ],
      authoringIntakePath + '.issue',
      errors,
    ) ||
    JSON.stringify(document.issue) !== JSON.stringify(expectedIssue)
  ) {
    errors.push(authoringIntakePath + ': issue #77 binding drift');
  }
  if (!sameValues(document.gateScope, authoringGateScope)) {
    errors.push(authoringIntakePath + ': gate scope must remain G02/G04/G05');
  }
  if (
    !checkExactFields(
      document.protocolGateState,
      ['allGatesRemainOpen', 'closedGates', 'openGates'],
      authoringIntakePath + '.protocolGateState',
      errors,
    ) ||
    document.protocolGateState.allGatesRemainOpen !== true ||
    !sameValues(document.protocolGateState.openGates, openGates) ||
    !sameValues(document.protocolGateState.closedGates, [])
  ) {
    errors.push(
      authoringIntakePath + ': all Protocol v0 gates must remain open',
    );
  }

  const bindings = document.frozenBindings;
  if (
    !checkExactFields(
      bindings,
      [
        'approvedAuthorInputPacket',
        'cleanAuthoringWorkspace',
        'contaminatedIncubator',
        'policy',
        'pv0G01ReviewTarget',
        'pv0G03ReviewTarget',
      ],
      authoringIntakePath + '.frozenBindings',
      errors,
    ) ||
    bindings.policy !== 'ISSUE_AND_CONTAMINATED_INCUBATOR_BASELINE_PINNED'
  ) {
    errors.push(authoringIntakePath + ': frozen binding policy drift');
  }
  const contaminated = bindings?.contaminatedIncubator;
  if (
    !checkExactFields(
      contaminated,
      [
        'allRepositoryRevisionsDenied',
        'classification',
        'protocolTree',
        'pullRequest',
        'traceabilityBinding',
        'warning',
      ],
      authoringIntakePath + '.frozenBindings.contaminatedIncubator',
      errors,
    ) ||
    contaminated.classification !== 'DENY_FOR_AUTHOR_AND_REVIEWER_CONTEXT' ||
    contaminated.allRepositoryRevisionsDenied !== true ||
    contaminated.warning !==
      'This binding identifies prohibited repository-exposed history. It is not an approved author input.'
  ) {
    errors.push(
      authoringIntakePath + ': contaminated baseline classification drift',
    );
  }
  const expectedPullRequest = {
    repository: 'mereyabdenbekuly-ctrl/clodex-ide',
    number: 74,
    url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/74',
    baseCommit: '8d2618a91a541607944fb7eb7bad30001d5b4aeb',
    headCommit: 'c0e0c6d4fb66b98806a2a80884b8f034b2e860b1',
    mergeCommit: g01FrozenMainCommit,
  };
  if (
    !checkExactFields(
      contaminated?.pullRequest,
      [
        'baseCommit',
        'headCommit',
        'mergeCommit',
        'number',
        'repository',
        'url',
      ],
      authoringIntakePath + '.frozenBindings.contaminatedIncubator.pullRequest',
      errors,
    ) ||
    JSON.stringify(contaminated.pullRequest) !==
      JSON.stringify(expectedPullRequest) ||
    JSON.stringify(contaminated.protocolTree) !==
      JSON.stringify({
        path: protocolPath,
        gitTree: 'd36c03eab98cd249a2b52fa1bd662869e7a494b3',
      }) ||
    JSON.stringify(contaminated.traceabilityBinding) !==
      JSON.stringify(g01FrozenReviewInputs[2])
  ) {
    errors.push(authoringIntakePath + ': PR #74 frozen baseline drift');
  }

  const g01Target = bindings?.pv0G01ReviewTarget;
  if (
    !checkExactFields(
      g01Target,
      [
        'closureEvidence',
        'frozenMainCommit',
        'gateId',
        'issue',
        'reviewInputs',
        'status',
      ],
      authoringIntakePath + '.frozenBindings.pv0G01ReviewTarget',
      errors,
    ) ||
    g01Target.gateId !== 'PV0-G01' ||
    g01Target.status !== 'OPEN' ||
    g01Target.frozenMainCommit !== g01FrozenMainCommit ||
    JSON.stringify(g01Target.reviewInputs) !==
      JSON.stringify(g01FrozenReviewInputs) ||
    JSON.stringify(g01Target.issue) !==
      JSON.stringify({
        number: 75,
        url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/75',
        createdAt: '2026-07-20T03:30:54Z',
        updatedAt: '2026-07-20T03:30:54Z',
        bodySha256: authoringG01IssueBodySha256,
      }) ||
    !isRecord(g01Target.closureEvidence) ||
    Object.keys(g01Target.closureEvidence).some(
      (field) => g01Target.closureEvidence[field] !== null,
    )
  ) {
    errors.push(
      authoringIntakePath +
        ': PV0-G01 must remain open with no closure evidence',
    );
  }
  const g03Target = bindings?.pv0G03ReviewTarget;
  if (
    !checkExactFields(
      g03Target,
      [
        'closureEvidence',
        'frozenMainCommit',
        'gateId',
        'issue',
        'reviewInputs',
        'status',
      ],
      authoringIntakePath + '.frozenBindings.pv0G03ReviewTarget',
      errors,
    ) ||
    g03Target.gateId !== 'PV0-G03' ||
    g03Target.status !== 'OPEN' ||
    g03Target.frozenMainCommit !== g03FrozenMainCommit ||
    JSON.stringify(g03Target.reviewInputs) !==
      JSON.stringify(g03FrozenReviewInputs) ||
    JSON.stringify(g03Target.issue) !==
      JSON.stringify({
        number: 76,
        url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/76',
        createdAt: '2026-07-20T03:30:56Z',
        updatedAt: '2026-07-20T03:30:56Z',
        bodySha256: authoringG03IssueBodySha256,
      }) ||
    !isRecord(g03Target.closureEvidence) ||
    Object.keys(g03Target.closureEvidence).some(
      (field) => g03Target.closureEvidence[field] !== null,
    )
  ) {
    errors.push(
      authoringIntakePath +
        ': PV0-G03 must remain open with no closure evidence',
    );
  }
  const packet = bindings?.approvedAuthorInputPacket;
  if (
    !checkExactFields(
      packet,
      [
        'approvedAt',
        'approvedBy',
        'createdAt',
        'createdBy',
        'packetSha256',
        'path',
        'sourceManifestSha256',
        'status',
      ],
      authoringIntakePath + '.frozenBindings.approvedAuthorInputPacket',
      errors,
    ) ||
    packet.status !== 'UNBOUND' ||
    Object.keys(packet)
      .filter((field) => field !== 'status')
      .some((field) => packet[field] !== null)
  ) {
    errors.push(
      authoringIntakePath + ': author input packet must remain unbound',
    );
  }
  const cleanWorkspace = bindings?.cleanAuthoringWorkspace;
  if (
    !checkExactFields(
      cleanWorkspace,
      [
        'artifactRoot',
        'environmentAttestationSha256',
        'initialEmptyCommit',
        'initialTree',
        'repositoryIdentifier',
        'status',
      ],
      authoringIntakePath + '.frozenBindings.cleanAuthoringWorkspace',
      errors,
    ) ||
    cleanWorkspace.status !== 'UNBOUND' ||
    Object.keys(cleanWorkspace)
      .filter((field) => field !== 'status')
      .some((field) => cleanWorkspace[field] !== null)
  ) {
    errors.push(
      authoringIntakePath + ': clean authoring workspace must remain unbound',
    );
  }

  const participantSlots = document.participantSlots;
  if (
    !checkExactFields(
      participantSlots,
      ['authors', 'environmentCustodian', 'reviewers', 'separationPolicy'],
      authoringIntakePath + '.participantSlots',
      errors,
    ) ||
    !Array.isArray(participantSlots.authors) ||
    participantSlots.authors.length !== 1 ||
    !Array.isArray(participantSlots.reviewers) ||
    participantSlots.reviewers.length !== 1
  ) {
    errors.push(
      authoringIntakePath +
        ': exactly one pending author and reviewer slot required',
    );
  }
  const participantFields = [
    'affiliation',
    'conflictOfInterestDeclaration',
    'eligibility',
    'identity',
    'independenceDeclaration',
    'role',
    'selectedAt',
    'signOff',
    'slotId',
    'sourceExposure',
  ];
  const exposureFields = [
    'clodexIdeRepositorySource',
    'declaration',
    'declaredAt',
    'distinctiveLiteralsAndModuleStructure',
    'evidenceReferences',
    'implementationTypesValidatorsTestsFixtures',
    'overallStatus',
    'priorAiContextOrMemory',
    'privateCustomerProductionMaterial',
    'protocolIncubatorPr74',
  ];
  const expectedParticipants = [
    [
      participantSlots?.authors?.[0],
      'PV0-AUTHOR-01',
      'CONSTRAINED_SCHEMA_AUTHOR',
    ],
    [
      participantSlots?.reviewers?.[0],
      'PV0-REVIEWER-01',
      'INDEPENDENT_SCHEMA_REVIEWER',
    ],
  ];
  for (const [participant, slotId, role] of expectedParticipants) {
    const label = authoringIntakePath + '.participantSlots.' + slotId;
    if (
      !checkExactFields(participant, participantFields, label, errors) ||
      participant.slotId !== slotId ||
      participant.role !== role ||
      participant.identity !== null ||
      participant.affiliation !== null ||
      participant.selectedAt !== null ||
      participant.independenceDeclaration !== null ||
      participant.conflictOfInterestDeclaration !== null ||
      participant.eligibility !== 'PENDING'
    ) {
      errors.push(label + ': participant attribution must remain pending');
    }
    const exposure = participant?.sourceExposure;
    if (
      !checkExactFields(
        exposure,
        exposureFields,
        label + '.sourceExposure',
        errors,
      ) ||
      exposureFields
        .filter(
          (field) =>
            !['declaration', 'declaredAt', 'evidenceReferences'].includes(
              field,
            ),
        )
        .some((field) => exposure[field] !== 'UNKNOWN') ||
      exposure.declaration !== null ||
      exposure.declaredAt !== null ||
      !sameValues(exposure.evidenceReferences, [])
    ) {
      errors.push(label + ': source exposure must remain unresolved');
    }
    if (
      !checkExactFields(
        participant?.signOff,
        ['evidenceReference', 'signedAt', 'statement'],
        label + '.signOff',
        errors,
      ) ||
      Object.values(participant.signOff).some((value) => value !== null)
    ) {
      errors.push(label + ': participant slot must remain unsigned');
    }
  }
  const expectedCustodian = {
    slotId: 'PV0-CUSTODIAN-01',
    role: 'SOURCE_CONSTRAINT_ENVIRONMENT_CUSTODIAN',
    identity: null,
    affiliation: null,
    selectedAt: null,
    repositoryExposureAllowedForCustodyOnly: true,
    mayAuthorSchemas: false,
    mayPerformNormativeSchemaReview: false,
    attestation: null,
    attestedAt: null,
    evidenceReference: null,
  };
  if (
    !checkExactFields(
      participantSlots?.environmentCustodian,
      Object.keys(expectedCustodian),
      authoringIntakePath + '.participantSlots.environmentCustodian',
      errors,
    ) ||
    JSON.stringify(participantSlots.environmentCustodian) !==
      JSON.stringify(expectedCustodian)
  ) {
    errors.push(
      authoringIntakePath +
        ': custodian must remain non-authoring and unattributed',
    );
  }
  const expectedSeparationPolicy = {
    minimumNamedAuthors: 1,
    minimumNamedReviewers: 1,
    authorsAndReviewersMustBeDisjoint: true,
    authorsMayNotReviewOwnArtifacts: true,
    reviewersMayNotModifyAuthoredArtifacts: true,
    custodianMayNotAuthorOrSemanticallyApprove: true,
    aiSystemsAreToolsNotAccountableSignatories: true,
  };
  if (
    !checkExactFields(
      participantSlots?.separationPolicy,
      Object.keys(expectedSeparationPolicy),
      authoringIntakePath + '.participantSlots.separationPolicy',
      errors,
    ) ||
    JSON.stringify(participantSlots.separationPolicy) !==
      JSON.stringify(expectedSeparationPolicy)
  ) {
    errors.push(
      authoringIntakePath + ': author/reviewer separation policy drift',
    );
  }

  const sourcePolicy = document.sourceExposurePolicy;
  if (
    !checkExactFields(
      sourcePolicy,
      [
        'authorAndReviewerRequiredState',
        'humanAndEnvironmentEvidenceRequired',
        'prohibitedContextClasses',
        'selfDeclarationAloneClosesGate',
        'trainingDataClaim',
        'unknownExposureDefault',
      ],
      authoringIntakePath + '.sourceExposurePolicy',
      errors,
    ) ||
    sourcePolicy.unknownExposureDefault !== 'DISQUALIFY_UNTIL_RESOLVED' ||
    sourcePolicy.authorAndReviewerRequiredState !==
      'DECLARED_NO_PROHIBITED_CONTEXT_EXPOSURE' ||
    !sameValues(
      sourcePolicy.prohibitedContextClasses,
      authoringProhibitedContextClasses,
    ) ||
    sourcePolicy.trainingDataClaim !==
      'No claim is made about unknowable model pretraining. Evidence covers supplied runtime context, retrieval, tools, memory, mounts, prompts, and sessions.' ||
    sourcePolicy.selfDeclarationAloneClosesGate !== false ||
    sourcePolicy.humanAndEnvironmentEvidenceRequired !== true
  ) {
    errors.push(
      authoringIntakePath + ': fail-closed source exposure policy drift',
    );
  }

  const inputPolicy = document.inputPolicy;
  if (
    !checkExactFields(
      inputPolicy,
      [
        'alwaysDenied',
        'authorPacketRules',
        'conditionallyEligibleAfterGateClosure',
        'currentlyAllowedForSchemaAuthoring',
        'currentlyBoundAuthorPacketEntries',
        'repositoryDerivedInputsRoute',
        'unknownInputsDefaultTo',
      ],
      authoringIntakePath + '.inputPolicy',
      errors,
    ) ||
    inputPolicy.unknownInputsDefaultTo !== 'RED' ||
    !sameValues(inputPolicy.currentlyAllowedForSchemaAuthoring, []) ||
    !sameValues(inputPolicy.currentlyBoundAuthorPacketEntries, [])
  ) {
    errors.push(
      authoringIntakePath +
        ': current author input allowlist must remain empty and default RED',
    );
  }
  const eligible = inputPolicy?.conditionallyEligibleAfterGateClosure;
  if (
    !Array.isArray(eligible) ||
    eligible.length !== 2 ||
    eligible[0]?.sourceClass !== 'APPROVED_PV0_G03_REQUIREMENTS_CATALOGUE' ||
    eligible[0]?.requiredGate !== 'PV0-G03' ||
    eligible[0]?.directAuthorExposure !== true ||
    eligible[1]?.sourceClass !== 'APPROVED_EXTERNAL_STANDARDS' ||
    !sameValues(eligible[1]?.inputIds, authoringExternalInputIds) ||
    eligible[1]?.requiredGate !== 'PV0-G01' ||
    eligible[1]?.directAuthorExposure !== true ||
    !Array.isArray(eligible[0]?.conditions) ||
    eligible[0].conditions.length !== 3 ||
    !Array.isArray(eligible[1]?.conditions) ||
    eligible[1].conditions.length !== 4
  ) {
    errors.push(
      authoringIntakePath + ': conditional approved-input policy drift',
    );
  }
  const route = inputPolicy?.repositoryDerivedInputsRoute;
  if (
    !checkExactFields(
      route,
      ['directAuthorExposure', 'inputIds', 'permittedRoute'],
      authoringIntakePath + '.inputPolicy.repositoryDerivedInputsRoute',
      errors,
    ) ||
    !sameValues(route.inputIds, authoringRepositoryDerivedInputIds) ||
    route.directAuthorExposure !== false ||
    route.permittedRoute !== 'APPROVED_PV0_G03_REQUIREMENTS_CATALOGUE_ONLY'
  ) {
    errors.push(
      authoringIntakePath +
        ': repository-derived inputs may not reach authors directly',
    );
  }
  const denied = Array.isArray(inputPolicy?.alwaysDenied)
    ? inputPolicy.alwaysDenied
    : [];
  const expectedDeniedIds = [
    'PV0-IN-008',
    'CURRENT_PROTOCOL_INCUBATOR',
    'IMPLEMENTATION_ARTIFACT_CLASSES',
    'LEGACY_AND_TRANSITIVE_SOURCE',
    'PRIOR_AI_CONTEXT',
    'PRIVATE_OR_RESTRICTED_MATERIAL',
    'UNKNOWN_INPUT',
  ];
  if (
    !sameValues(
      denied.map((entry) => entry?.id),
      expectedDeniedIds,
    ) ||
    denied.some(
      (entry) =>
        !checkExactFields(
          entry,
          ['id', 'reason', 'scope'],
          authoringIntakePath + '.inputPolicy.alwaysDenied.' + entry?.id,
          errors,
        ),
    ) ||
    denied[0]?.scope !== 'ALL_REVISIONS'
  ) {
    errors.push(
      authoringIntakePath + ': permanent RED and deny input inventory drift',
    );
  }
  const packetRules = inputPolicy?.authorPacketRules;
  if (
    !checkExactFields(
      packetRules,
      [
        'dynamicOrMutableUrlsForbidden',
        'exactBytesAndSha256Required',
        'packetChangesRequireNewDigestAndApproval',
        'symlinksForbidden',
        'unrecordedAttachmentsForbidden',
      ],
      authoringIntakePath + '.inputPolicy.authorPacketRules',
      errors,
    ) ||
    Object.values(packetRules).some((value) => value !== true)
  ) {
    errors.push(authoringIntakePath + ': exact author packet rules drift');
  }

  const environment = document.toolingAndEnvironment;
  if (
    !checkExactFields(
      environment,
      [
        'aiContextRuns',
        'attestation',
        'dependencyPolicy',
        'status',
        'toolPolicy',
        'toolRuns',
        'workspace',
      ],
      authoringIntakePath + '.toolingAndEnvironment',
      errors,
    ) ||
    environment.status !== 'UNBOUND' ||
    !sameValues(environment.toolRuns, []) ||
    !sameValues(environment.aiContextRuns, [])
  ) {
    errors.push(
      authoringIntakePath + ': tool and AI run evidence must remain unbound',
    );
  }
  const toolPolicy = environment?.toolPolicy;
  if (
    !checkExactFields(
      toolPolicy,
      [
        'allowedAuthoringModes',
        'allowedEgressModes',
        'codeGraphOrRepositoryIndexForbidden',
        'freshSessionRequiredWhenAiUsed',
        'githubCodeSearchForbidden',
        'mcpServerAllowlist',
        'networkDefaultDeny',
        'persistentMemoryMustBeDisabled',
        'priorConversationImportForbidden',
        'repositoryRetrievalForbidden',
        'repositoryToolAllowlist',
        'requiredRunFields',
        'selectedAuthoringMode',
        'selectedEgressMode',
        'unapprovedMcpServersForbidden',
      ],
      authoringIntakePath + '.toolingAndEnvironment.toolPolicy',
      errors,
    ) ||
    !sameValues(toolPolicy.allowedAuthoringModes, [
      'NO_AI',
      'FRESH_CONTEXT_AI_SESSION',
    ]) ||
    toolPolicy.selectedAuthoringMode !== null ||
    toolPolicy.freshSessionRequiredWhenAiUsed !== true ||
    toolPolicy.persistentMemoryMustBeDisabled !== true ||
    toolPolicy.priorConversationImportForbidden !== true ||
    toolPolicy.repositoryRetrievalForbidden !== true ||
    toolPolicy.githubCodeSearchForbidden !== true ||
    toolPolicy.codeGraphOrRepositoryIndexForbidden !== true ||
    toolPolicy.unapprovedMcpServersForbidden !== true ||
    !sameValues(toolPolicy.mcpServerAllowlist, []) ||
    !sameValues(toolPolicy.repositoryToolAllowlist, []) ||
    toolPolicy.networkDefaultDeny !== true ||
    !sameValues(toolPolicy.allowedEgressModes, [
      'OFFLINE',
      'AI_PROVIDER_ONLY',
    ]) ||
    toolPolicy.selectedEgressMode !== null ||
    !sameValues(toolPolicy.requiredRunFields, authoringRequiredRunFields)
  ) {
    errors.push(
      authoringIntakePath + ': fail-closed tool and AI context policy drift',
    );
  }
  const workspace = environment?.workspace;
  if (
    !checkExactFields(
      workspace,
      [
        'artifactRoot',
        'createdAt',
        'egressLogSha256',
        'environmentAttestationSha256',
        'filesystemManifestSha256',
        'importedCommitsOrPatchesForbidden',
        'initialEmptyCommit',
        'initialTree',
        'mustNotContainClodexIdeHistory',
        'mustStartEmpty',
        'repositoryIdentifier',
        'repositoryMounts',
        'requiredType',
        'toolchainLockSha256',
      ],
      authoringIntakePath + '.toolingAndEnvironment.workspace',
      errors,
    ) ||
    workspace.requiredType !== 'FRESH_SOURCE_CONSTRAINED_REPOSITORY' ||
    workspace.mustStartEmpty !== true ||
    workspace.mustNotContainClodexIdeHistory !== true ||
    workspace.importedCommitsOrPatchesForbidden !== true ||
    !sameValues(workspace.repositoryMounts, []) ||
    [
      'repositoryIdentifier',
      'createdAt',
      'initialEmptyCommit',
      'initialTree',
      'artifactRoot',
      'filesystemManifestSha256',
      'toolchainLockSha256',
      'environmentAttestationSha256',
      'egressLogSha256',
    ].some((field) => workspace[field] !== null)
  ) {
    errors.push(
      authoringIntakePath + ': fresh workspace must remain empty and unbound',
    );
  }
  const dependencies = environment?.dependencyPolicy;
  if (
    !checkExactFields(
      dependencies,
      [
        'dependencyManifestBindings',
        'developmentToolsMustBePinnedAndReviewed',
        'forbiddenDependencySources',
        'forbiddenPackageScopes',
        'installOrBuildLifecycleFetchScriptsForbidden',
        'lockfileBindings',
        'runtimeDependenciesAllowed',
      ],
      authoringIntakePath + '.toolingAndEnvironment.dependencyPolicy',
      errors,
    ) ||
    dependencies.runtimeDependenciesAllowed !== false ||
    !sameValues(dependencies.forbiddenDependencySources, [
      'workspace:',
      'file:',
      'link:',
      'git',
      'github',
    ]) ||
    !sameValues(dependencies.forbiddenPackageScopes, [
      '@clodex/*',
      '@stagewise/*',
    ]) ||
    dependencies.installOrBuildLifecycleFetchScriptsForbidden !== true ||
    dependencies.developmentToolsMustBePinnedAndReviewed !== true ||
    !sameValues(dependencies.dependencyManifestBindings, []) ||
    !sameValues(dependencies.lockfileBindings, [])
  ) {
    errors.push(
      authoringIntakePath +
        ': zero-runtime and monorepo dependency policy drift',
    );
  }
  const attestation = environment?.attestation;
  if (
    !checkExactFields(
      attestation,
      ['attestedAt', 'attestedBy', 'evidenceReference', 'status'],
      authoringIntakePath + '.toolingAndEnvironment.attestation',
      errors,
    ) ||
    attestation.status !== 'MISSING' ||
    ['attestedBy', 'attestedAt', 'evidenceReference'].some(
      (field) => attestation[field] !== null,
    )
  ) {
    errors.push(
      authoringIntakePath + ': environment attestation must remain missing',
    );
  }

  const provenance = document.provenancePlan;
  if (
    !checkExactFields(
      provenance,
      [
        'generatedArtifacts',
        'perFileRecords',
        'redSourceWarningScan',
        'requiredPerFileFields',
        'runtimeDependencyEvidence',
        'schemaHistory',
        'semanticCompletenessReview',
      ],
      authoringIntakePath + '.provenancePlan',
      errors,
    ) ||
    !sameValues(provenance.perFileRecords, []) ||
    !sameValues(provenance.generatedArtifacts, []) ||
    !sameValues(
      provenance.requiredPerFileFields,
      authoringRequiredPerFileFields,
    )
  ) {
    errors.push(
      authoringIntakePath +
        ': per-file and generated provenance must remain empty',
    );
  }
  const schemaHistory = provenance?.schemaHistory;
  if (
    !checkExactFields(
      schemaHistory,
      [
        'commitRange',
        'evidenceReference',
        'firstAuthoringCommit',
        'historyImported',
        'historyRewrittenAfterReview',
        'initialEmptyCommit',
        'repositoryIdentifier',
        'reviewedHeadCommit',
        'status',
      ],
      authoringIntakePath + '.provenancePlan.schemaHistory',
      errors,
    ) ||
    schemaHistory.status !== 'NOT_STARTED' ||
    schemaHistory.historyImported !== false ||
    Object.keys(schemaHistory)
      .filter((field) => !['historyImported', 'status'].includes(field))
      .some((field) => schemaHistory[field] !== null)
  ) {
    errors.push(
      authoringIntakePath + ': fresh schema history must remain absent',
    );
  }
  const completeness = provenance?.semanticCompletenessReview;
  if (
    !checkExactFields(
      completeness,
      [
        'coverageEvidenceSha256',
        'decision',
        'normativeComparisonSource',
        'reviewedCommit',
        'reviewer',
        'status',
      ],
      authoringIntakePath + '.provenancePlan.semanticCompletenessReview',
      errors,
    ) ||
    completeness.status !== 'NOT_STARTED' ||
    completeness.normativeComparisonSource !==
      'APPROVED_PV0_G03_REQUIREMENTS_ONLY' ||
    ['reviewer', 'reviewedCommit', 'coverageEvidenceSha256', 'decision'].some(
      (field) => completeness[field] !== null,
    )
  ) {
    errors.push(
      authoringIntakePath +
        ': semantic completeness evidence must remain absent',
    );
  }
  const warningScan = provenance?.redSourceWarningScan;
  if (
    !checkExactFields(
      warningScan,
      [
        'dispositiveProofOfCleanProvenance',
        'mayModifyAuthoredArtifacts',
        'mayReturnSourceExcerptsToAuthorsOrReviewers',
        'mode',
        'prohibitedCorpusBinding',
        'resultDigest',
        'reviewedBy',
        'scannerBinding',
        'status',
      ],
      authoringIntakePath + '.provenancePlan.redSourceWarningScan',
      errors,
    ) ||
    warningScan.status !== 'NOT_STARTED' ||
    warningScan.mode !==
      'POST_FREEZE_WARNING_ONLY_BY_NON_AUTHORING_CUSTODIAN' ||
    warningScan.prohibitedCorpusBinding !==
      'frozenBindings.contaminatedIncubator' ||
    warningScan.mayReturnSourceExcerptsToAuthorsOrReviewers !== false ||
    warningScan.mayModifyAuthoredArtifacts !== false ||
    warningScan.dispositiveProofOfCleanProvenance !== false ||
    ['scannerBinding', 'resultDigest', 'reviewedBy'].some(
      (field) => warningScan[field] !== null,
    )
  ) {
    errors.push(
      authoringIntakePath + ': RED-source warning scan boundary drift',
    );
  }
  const dependencyEvidence = provenance?.runtimeDependencyEvidence;
  if (
    !checkExactFields(
      dependencyEvidence,
      [
        'forbiddenDependencyFindings',
        'lockfileSha256',
        'manifestSha256',
        'monorepoDependencyCount',
        'reviewedBy',
        'runtimeDependencyCount',
        'scanEvidenceSha256',
        'status',
      ],
      authoringIntakePath + '.provenancePlan.runtimeDependencyEvidence',
      errors,
    ) ||
    dependencyEvidence.status !== 'NOT_STARTED' ||
    Object.keys(dependencyEvidence)
      .filter((field) => field !== 'status')
      .some((field) => dependencyEvidence[field] !== null)
  ) {
    errors.push(
      authoringIntakePath + ': runtime dependency evidence must remain absent',
    );
  }

  const execution = document.executionGate;
  if (
    !checkExactFields(
      execution,
      [
        'authoringMayBegin',
        'blockers',
        'checks',
        'reason',
        'requiredPrerequisiteGateIds',
        'satisfiedPrerequisiteGateIds',
        'schemaEditsAuthorized',
        'status',
      ],
      authoringIntakePath + '.executionGate',
      errors,
    ) ||
    execution.status !== 'BLOCKED' ||
    !sameValues(execution.requiredPrerequisiteGateIds, [
      'PV0-G01',
      'PV0-G03',
    ]) ||
    !sameValues(execution.satisfiedPrerequisiteGateIds, []) ||
    !sameValues(execution.blockers, authoringBlockers) ||
    execution.authoringMayBegin !== false ||
    execution.schemaEditsAuthorized !== false ||
    execution.reason !==
      'Setup-only intake. PV0-G01 and PV0-G03 are open and no named clean participants, approved input packet, constrained workspace, tool context, or environment attestation are bound.'
  ) {
    errors.push(
      authoringIntakePath +
        ': constrained authoring execution gate must remain blocked',
    );
  }
  const expectedCheckFields = [
    'approvedAuthorPacketBound',
    'authorExposureCleared',
    'environmentAttested',
    'freshWorkspaceBound',
    'namedAuthorSelected',
    'namedReviewerSelected',
    'pv0G01Approved',
    'pv0G03Approved',
    'reviewerExposureCleared',
    'toolContextBound',
  ];
  if (
    !checkExactFields(
      execution?.checks,
      expectedCheckFields,
      authoringIntakePath + '.executionGate.checks',
      errors,
    ) ||
    expectedCheckFields.some((field) => execution.checks[field] !== false)
  ) {
    errors.push(
      authoringIntakePath + ': execution prerequisites must remain unsatisfied',
    );
  }

  const closures = Array.isArray(document.gateClosure)
    ? document.gateClosure
    : [];
  if (
    !sameValues(
      closures.map((closure) => closure?.gateId),
      authoringGateScope,
    ) ||
    closures.some(
      (closure) =>
        !checkExactFields(
          closure,
          [
            'eligible',
            'evidenceReferences',
            'gateId',
            'gateRemainsOpen',
            'reason',
          ],
          authoringIntakePath + '.gateClosure.' + closure?.gateId,
          errors,
        ) ||
        closure.eligible !== false ||
        closure.gateRemainsOpen !== true ||
        !sameValues(closure.evidenceReferences, []),
    )
  ) {
    errors.push(authoringIntakePath + ': PV0-G02/G04/G05 must remain open');
  }

  const scopeFields = [
    'codeGenerationAuthorized',
    'conformancePayloadsAuthorized',
    'conformanceRunnersAuthorized',
    'enterpriseOrCloudImplementationAuthorized',
    'gatewayImplementationAuthorized',
    'otherGateClosuresAuthorized',
    'privateImplementationAuthorized',
    'protocolPublicationAuthorized',
    'relicensingAuthorized',
    'schemaAuthoringAuthorized',
    'schemaEditsAuthorized',
    'sdkPublicationAuthorized',
  ];
  if (
    !checkExactFields(
      document.scopeNonAuthorization,
      scopeFields,
      authoringIntakePath + '.scopeNonAuthorization',
      errors,
    ) ||
    scopeFields
      .filter((field) => field !== 'otherGateClosuresAuthorized')
      .some((field) => document.scopeNonAuthorization[field] !== false) ||
    !sameValues(document.scopeNonAuthorization.otherGateClosuresAuthorized, [])
  ) {
    errors.push(
      authoringIntakePath +
        ': prohibited authoring or implementation scope was authorized',
    );
  }
  if (
    !checkExactFields(
      document.signOff,
      ['evidenceReference', 'signedAt', 'signedBy', 'statement'],
      authoringIntakePath + '.signOff',
      errors,
    ) ||
    Object.values(document.signOff).some((value) => value !== null)
  ) {
    errors.push(authoringIntakePath + ': setup intake must remain unsigned');
  }

  const guide = join(root, authoringGuidePath);
  if (!existsSync(guide)) {
    errors.push(authoringGuidePath + ': required guide missing');
    return;
  }
  const guideSource = readFileSync(guide, 'utf8');
  if (digest(guide) !== authoringGuideSha256) {
    errors.push(authoringGuidePath + ': exact setup-only guide content drift');
  }
  checkSetupOnlyGuideClaims(guideSource, authoringGuidePath, errors);
  for (const marker of [
    'setup only; execution blocked; every Protocol v0 gate remains open',
    '374539f98dba20d1aade6208c2834928bf7fa09a',
    'd36c03eab98cd249a2b52fa1bd662869e7a494b3',
    'Unknown exposure is disqualifying',
    'The current author allowlist is empty',
    '`PV0-IN-008` remains RED',
    '`authoringMayBegin` and `schemaEditsAuthorized` remain `false`',
    'Every `PV0-G01` through',
    '`PV0-G10` gate remains open',
    'The setup artifact should remain immutable',
  ]) {
    if (!guideSource.includes(marker)) {
      errors.push(authoringGuidePath + ': missing boundary marker ' + marker);
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
  checkConstrainedAuthoringIntake(root, errors);
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
