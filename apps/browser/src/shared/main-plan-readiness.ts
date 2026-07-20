import {
  FEATURE_GATES,
  getFeatureGateDefault,
  type AppReleaseChannel,
  type FeatureGateId,
} from './feature-gates';

export const mainPlanEpicIds = [
  'evidence-memory',
  'model-fabric',
  'session-teleporter',
  'decoupled-execution',
  'generated-app-capability-bridge',
] as const;

export type MainPlanEpicId = (typeof mainPlanEpicIds)[number];

export type MainPlanPromotionContract =
  | 'signed-release-evidence'
  | 'authenticated-policy-publication'
  | 'release-readiness-evidence'
  | 'trusted-paired-replay-evidence'
  | 'linked-evaluation-evidence'
  | 'not-yet-defined';

export type MainPlanPromotionState =
  | 'absent'
  | 'ready'
  | 'not-ready'
  | 'invalid'
  | 'unsupported';

export interface MainPlanPromotionAssessment {
  state: MainPlanPromotionState;
  source: string;
  evidencePath?: string;
  blockers: string[];
  details?: Record<string, string | number | boolean | null>;
}

export interface MainPlanGateState {
  id: FeatureGateId;
  available: boolean;
  defaultEnabled: boolean;
}

export interface MainPlanSourceState {
  commitSha: string;
  clean: boolean;
}

export interface MainPlanEpicDefinition {
  id: MainPlanEpicId;
  name: string;
  implementationVersion: number;
  implementationComplete: boolean;
  featureGates: readonly FeatureGateId[];
  promotionContract: MainPlanPromotionContract;
  postV1: readonly string[];
}

export interface MainPlanEpicReadiness {
  id: MainPlanEpicId;
  name: string;
  implementationVersion: number;
  implementationComplete: boolean;
  promotionContract: MainPlanPromotionContract;
  promotionState: MainPlanPromotionState;
  promotionSource: string;
  promotionDetails: Record<string, string | number | boolean | null>;
  promotionRequired: boolean;
  promotionReady: boolean;
  releaseSafe: boolean;
  status: 'incomplete' | 'blocked' | 'implemented-gated' | 'promotion-ready';
  featureGates: MainPlanGateState[];
  blockers: string[];
  postV1: string[];
}

export interface MainPlanReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  channel: AppReleaseChannel;
  source: MainPlanSourceState;
  requireCleanSource: boolean;
  requiredPromotions: MainPlanEpicId[];
  codeComplete: boolean;
  buildReady: boolean;
  promotionReady: boolean;
  requiredPromotionReady: boolean;
  ready: boolean;
  promotedEpicCount: number;
  promotableEpicCount: number;
  blockers: string[];
  epics: MainPlanEpicReadiness[];
}

export const mainPlanEpicDefinitions: readonly MainPlanEpicDefinition[] = [
  {
    id: 'evidence-memory',
    name: 'Evidence Graph Memory',
    implementationVersion: 1,
    implementationComplete: true,
    featureGates: [
      'evidence-memory-shadow',
      'evidence-memory-inspector',
      'evidence-memory-prompt-injection',
      'evidence-memory-hybrid-retrieval',
      'evidence-memory-model-summaries',
    ],
    promotionContract: 'signed-release-evidence',
    postV1: ['default-on rollout beyond approved canary stages'],
  },
  {
    id: 'model-fabric',
    name: 'Provider-Neutral Model Fabric',
    implementationVersion: 1,
    implementationComplete: true,
    featureGates: [
      'model-fabric-usage-ledger',
      'model-fabric-shadow-routing',
      'model-fabric-active-routing',
      'model-fabric-budget-policy',
      'model-fabric-evaluation-priors',
      'model-fabric-control-plane-refresh',
      'model-fabric-inspector',
    ],
    // The former public release wrapper trusted caller-supplied roots and was
    // quarantined. A managed promotion contract may be added only after the
    // public protocol and private implementation gates are independently met.
    promotionContract: 'not-yet-defined',
    postV1: [
      'external HSM/KMS signing adapters',
      'organization-wide audit receipt export',
      'provider remaining-token quota headers',
    ],
  },
  {
    id: 'session-teleporter',
    name: 'Session Teleporter',
    implementationVersion: 1,
    implementationComplete: true,
    featureGates: ['session-continuity', 'cloud-tasks'],
    promotionContract: 'release-readiness-evidence',
    postV1: ['release default-on before cross-platform dogfood sign-off'],
  },
  {
    id: 'decoupled-execution',
    name: 'Decoupled Execution',
    implementationVersion: 1,
    implementationComplete: true,
    featureGates: [
      'runner-abstraction',
      'ssh-runner',
      'ssh-heavyweight-cache',
      'ssh-multiplexed-protocol',
      'docker-runner',
      'runner-shadow-routing',
      'runner-paired-replay',
      'runner-automatic-routing',
      'byo-runner-sdk',
    ],
    promotionContract: 'trusted-paired-replay-evidence',
    postV1: [
      'automatic routing default-on',
      'runner environment attestation',
      'out-of-process signed runner discovery',
    ],
  },
  {
    id: 'generated-app-capability-bridge',
    name: 'Generated App Capability Bridge',
    implementationVersion: 1,
    implementationComplete: true,
    featureGates: [
      'artifact-bridge',
      'artifact-bridge-writes',
      'artifact-bridge-runtime-quotas',
      'artifact-bridge-lifecycle-events',
      'artifact-bridge-ephemeral-grants',
      'artifact-bridge-sensitive-egress',
      'artifact-bridge-async-operations',
      'artifact-bridge-runtime-inspector',
      'generated-app-packages',
      'generated-app-package-capabilities',
    ],
    promotionContract: 'linked-evaluation-evidence',
    postV1: ['release default-on before signed promotion evidence'],
  },
] as const;

export function createMainPlanGateSnapshot(
  channel: AppReleaseChannel,
): Partial<Record<FeatureGateId, MainPlanGateState>> {
  return Object.fromEntries(
    mainPlanEpicDefinitions.flatMap((epic) =>
      epic.featureGates.map((id) => {
        const definition = FEATURE_GATES[id];
        return [
          id,
          {
            id,
            available: definition.availableIn.includes(channel),
            defaultEnabled: getFeatureGateDefault(id, channel),
          } satisfies MainPlanGateState,
        ];
      }),
    ),
  );
}

export function evaluateMainPlanReadiness(input: {
  generatedAt: string;
  channel: AppReleaseChannel;
  source: MainPlanSourceState;
  requireCleanSource?: boolean;
  requiredPromotions?: readonly MainPlanEpicId[];
  promotions?: Partial<Record<MainPlanEpicId, MainPlanPromotionAssessment>>;
  gateStates?: Partial<Record<FeatureGateId, MainPlanGateState>>;
}): MainPlanReadinessReport {
  const requiredPromotions = uniqueEpicIds(input.requiredPromotions ?? []);
  const requiredPromotionSet = new Set(requiredPromotions);
  const gateStates =
    input.gateStates ?? createMainPlanGateSnapshot(input.channel);
  const epics = mainPlanEpicDefinitions.map((definition) => {
    const featureGates = definition.featureGates.flatMap((id) => {
      const state = gateStates[id];
      return state ? [state] : [];
    });
    const missingGates = definition.featureGates.filter(
      (id) => gateStates[id] === undefined,
    );
    const promotion =
      definition.promotionContract === 'not-yet-defined'
        ? defaultPromotionAssessment(definition)
        : (input.promotions?.[definition.id] ??
          defaultPromotionAssessment(definition));
    const promotionRequired = requiredPromotionSet.has(definition.id);
    const promotionReady = promotion.state === 'ready';
    const blockers = [...promotion.blockers];

    if (!definition.implementationComplete) {
      blockers.push('implementation-incomplete');
    }
    if (missingGates.length > 0) {
      blockers.push(...missingGates.map((id) => `missing-feature-gate:${id}`));
    }
    if (promotion.state === 'invalid' || promotion.state === 'not-ready') {
      blockers.push(`promotion-evidence-${promotion.state}`);
    }
    if (promotionRequired && !promotionReady) {
      blockers.push('required-promotion-not-ready');
    }
    if (input.channel === 'release' && !promotionReady) {
      blockers.push(
        ...featureGates
          .filter((gate) => gate.available && gate.defaultEnabled)
          .map(
            (gate) => `release-default-enabled-without-promotion:${gate.id}`,
          ),
      );
    }

    const uniqueBlockers = Array.from(new Set(blockers)).sort();
    const implementationComplete =
      definition.implementationComplete && missingGates.length === 0;
    const releaseSafe = uniqueBlockers.length === 0;
    const status: MainPlanEpicReadiness['status'] = !implementationComplete
      ? 'incomplete'
      : !releaseSafe
        ? 'blocked'
        : promotionReady
          ? 'promotion-ready'
          : 'implemented-gated';

    return {
      id: definition.id,
      name: definition.name,
      implementationVersion: definition.implementationVersion,
      implementationComplete,
      promotionContract: definition.promotionContract,
      promotionState: promotion.state,
      promotionSource: promotion.source,
      promotionDetails: { ...(promotion.details ?? {}) },
      promotionRequired,
      promotionReady,
      releaseSafe,
      status,
      featureGates,
      blockers: uniqueBlockers,
      postV1: [...definition.postV1],
    } satisfies MainPlanEpicReadiness;
  });

  const globalBlockers = epics.flatMap((epic) =>
    epic.blockers.map((blocker) => `${epic.id}:${blocker}`),
  );
  const requireCleanSource = input.requireCleanSource ?? false;
  if (requireCleanSource && !input.source.clean) {
    globalBlockers.push('source:working-tree-not-clean');
  }
  const blockers = Array.from(new Set(globalBlockers)).sort();
  const codeComplete = epics.every((epic) => epic.implementationComplete);
  const buildReady = codeComplete && blockers.length === 0;
  const requiredPromotionReady = requiredPromotions.every(
    (id) => epics.find((epic) => epic.id === id)?.promotionReady === true,
  );
  const promotableEpics = epics.filter(
    (epic) => epic.promotionContract !== 'not-yet-defined',
  );
  const promotedEpicCount = epics.filter((epic) => epic.promotionReady).length;
  const promotionReady = promotableEpics.every((epic) => epic.promotionReady);

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    channel: input.channel,
    source: input.source,
    requireCleanSource,
    requiredPromotions,
    codeComplete,
    buildReady,
    promotionReady,
    requiredPromotionReady,
    ready: buildReady && requiredPromotionReady,
    promotedEpicCount,
    promotableEpicCount: promotableEpics.length,
    blockers,
    epics,
  };
}

function defaultPromotionAssessment(
  definition: MainPlanEpicDefinition,
): MainPlanPromotionAssessment {
  return definition.promotionContract === 'not-yet-defined'
    ? {
        state: 'unsupported',
        source: 'no-release-promotion-contract',
        blockers: [],
      }
    : {
        state: 'absent',
        source: 'release-evidence-not-present',
        blockers: [],
      };
}

function uniqueEpicIds(values: readonly MainPlanEpicId[]): MainPlanEpicId[] {
  return Array.from(new Set(values)).sort(
    (left, right) =>
      mainPlanEpicIds.indexOf(left) - mainPlanEpicIds.indexOf(right),
  );
}
