import { randomUUID } from 'node:crypto';

export type ModelBudgetScopeKind = 'global' | 'task' | 'workspace' | 'provider';
export type ModelBudgetPolicyMode = 'soft' | 'hard';
export type ModelBudgetEventStatus =
  | 'reserved'
  | 'committed'
  | 'released'
  | 'denied';

export interface ModelBudgetPolicy {
  id: string;
  scope: ModelBudgetScopeKind;
  /** Exact scope value or `*` to apply independently to every scope value. */
  scopeRef: string;
  windowMs: number;
  limitUsd: number;
  mode: ModelBudgetPolicyMode;
}

export interface ModelBudgetRequest {
  taskId: string;
  workspaceId?: string | null;
  providerId: string;
  estimatedCostUsd: number;
}

export interface ModelBudgetPolicyEvaluation {
  policyId: string;
  scope: ModelBudgetScopeKind;
  scopeRef: string;
  mode: ModelBudgetPolicyMode;
  windowMs: number;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  requestedUsd: number;
  projectedUsd: number;
  exceeded: boolean;
}

export interface ModelBudgetReservation {
  id: string;
  request: ModelBudgetRequest;
  policyIds: string[];
  amountUsd: number;
  createdAt: number;
  expiresAt: number;
}

export interface ModelBudgetDecision {
  allowed: boolean;
  reservation: ModelBudgetReservation | null;
  evaluations: ModelBudgetPolicyEvaluation[];
  warningPolicyIds: string[];
  deniedPolicyIds: string[];
}

export interface ModelBudgetEvent {
  id: string;
  reservationId: string | null;
  policyIds: string[];
  taskId: string;
  workspaceId: string | null;
  providerId: string;
  amountUsd: number;
  status: ModelBudgetEventStatus;
  createdAt: number;
  expiresAt: number | null;
}

export interface ModelBudgetHistoricalSpend {
  policyId: string;
  scopeRef: string;
  taskId?: string;
  amountUsd: number;
  createdAt: number;
}

export interface ModelBudgetPolicyEngineOptions {
  policies?: readonly ModelBudgetPolicy[];
  reservationTtlMs?: number;
  now?: () => number;
  idGenerator?: () => string;
  onEvent?: (event: ModelBudgetEvent) => void;
}

interface CommittedSpend {
  policyId: string;
  scopeRef: string;
  taskId?: string;
  amountUsd: number;
  createdAt: number;
}

/**
 * Deterministic, content-free rolling-window budget controller.
 *
 * It reserves estimated cost before endpoint admission and settles exactly
 * once at the terminal execution boundary. Prompts, responses, tool payloads,
 * API keys, and endpoint secrets never enter the engine or its event stream.
 */
export class ModelBudgetPolicyEngine {
  private policies: ModelBudgetPolicy[];
  private readonly reservations = new Map<string, ModelBudgetReservation>();
  private readonly committed: CommittedSpend[] = [];
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly onEvent?: (event: ModelBudgetEvent) => void;

  public constructor(options: ModelBudgetPolicyEngineOptions = {}) {
    this.policies = normalizePolicies(options.policies ?? []);
    this.reservationTtlMs = normalizePositiveInteger(
      options.reservationTtlMs ?? 5 * 60_000,
      'reservationTtlMs',
    );
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.onEvent = options.onEvent;
  }

  public setPolicies(policies: readonly ModelBudgetPolicy[]): void {
    this.policies = normalizePolicies(policies);
  }

  public seedCommittedSpend(
    records: readonly ModelBudgetHistoricalSpend[],
  ): void {
    for (const record of records) {
      const policy = this.policies.find((item) => item.id === record.policyId);
      if (!policy) continue;
      this.committed.push({
        policyId: policy.id,
        scopeRef: normalizeScopeRef(record.scopeRef),
        taskId:
          record.taskId === undefined
            ? undefined
            : normalizeId(record.taskId, 'taskId'),
        amountUsd: normalizeMoney(record.amountUsd, 'amountUsd'),
        createdAt: normalizeTimestamp(record.createdAt),
      });
    }
    this.prune(this.now());
  }

  public seedCommittedEvents(events: readonly ModelBudgetEvent[]): void {
    const records: ModelBudgetHistoricalSpend[] = [];
    for (const event of events) {
      if (event.status !== 'committed') continue;
      const request: ModelBudgetRequest = {
        taskId: event.taskId,
        workspaceId: event.workspaceId,
        providerId: event.providerId,
        estimatedCostUsd: event.amountUsd,
      };
      for (const policyId of event.policyIds) {
        const policy = this.policies.find((item) => item.id === policyId);
        if (!policy) continue;
        const scopeRef = resolveRequestScope(policy.scope, request);
        if (scopeRef === null) continue;
        records.push({
          policyId,
          scopeRef,
          taskId: event.taskId,
          amountUsd: event.amountUsd,
          createdAt: event.createdAt,
        });
      }
    }
    this.seedCommittedSpend(records);
  }

  public reserve(request: ModelBudgetRequest): ModelBudgetDecision {
    const normalized = normalizeRequest(request);
    const now = this.now();
    this.prune(now);
    const matching = this.policies
      .map((policy) => ({
        policy,
        scopeRef: resolveRequestScope(policy.scope, normalized),
      }))
      .filter(
        (item): item is { policy: ModelBudgetPolicy; scopeRef: string } =>
          item.scopeRef !== null &&
          (item.policy.scopeRef === '*' ||
            item.policy.scopeRef === item.scopeRef),
      );
    const evaluations = matching.map(({ policy, scopeRef }) =>
      this.evaluatePolicy(policy, scopeRef, normalized.estimatedCostUsd, now),
    );
    const warningPolicyIds = evaluations
      .filter((evaluation) => evaluation.exceeded)
      .map((evaluation) => evaluation.policyId);
    const deniedPolicyIds = evaluations
      .filter((evaluation) => evaluation.exceeded && evaluation.mode === 'hard')
      .map((evaluation) => evaluation.policyId);
    if (evaluations.length === 0 || normalized.estimatedCostUsd === 0) {
      return {
        allowed: true,
        reservation: null,
        evaluations,
        warningPolicyIds,
        deniedPolicyIds: [],
      };
    }
    if (deniedPolicyIds.length > 0) {
      this.emit({
        id: this.idGenerator(),
        reservationId: null,
        policyIds: deniedPolicyIds,
        taskId: normalized.taskId,
        workspaceId: normalized.workspaceId ?? null,
        providerId: normalized.providerId,
        amountUsd: normalized.estimatedCostUsd,
        status: 'denied',
        createdAt: now,
        expiresAt: null,
      });
      return {
        allowed: false,
        reservation: null,
        evaluations,
        warningPolicyIds,
        deniedPolicyIds,
      };
    }

    const reservation: ModelBudgetReservation = {
      id: this.idGenerator(),
      request: normalized,
      policyIds: evaluations.map((evaluation) => evaluation.policyId),
      amountUsd: normalized.estimatedCostUsd,
      createdAt: now,
      expiresAt: now + this.reservationTtlMs,
    };
    this.reservations.set(reservation.id, reservation);
    this.emit({
      id: this.idGenerator(),
      reservationId: reservation.id,
      policyIds: reservation.policyIds,
      taskId: normalized.taskId,
      workspaceId: normalized.workspaceId ?? null,
      providerId: normalized.providerId,
      amountUsd: reservation.amountUsd,
      status: 'reserved',
      createdAt: now,
      expiresAt: reservation.expiresAt,
    });
    return {
      allowed: true,
      reservation,
      evaluations,
      warningPolicyIds,
      deniedPolicyIds: [],
    };
  }

  public commit(
    reservationId: string,
    actualCostUsd?: number,
  ): ModelBudgetEvent | null {
    const reservation = this.takeReservation(reservationId);
    if (!reservation) return null;
    const now = this.now();
    const amountUsd = normalizeMoney(
      actualCostUsd ?? reservation.amountUsd,
      'actualCostUsd',
    );
    for (const policyId of reservation.policyIds) {
      const policy = this.policies.find((item) => item.id === policyId);
      if (!policy) continue;
      const scopeRef = resolveRequestScope(policy.scope, reservation.request);
      if (scopeRef === null) continue;
      this.committed.push({
        policyId,
        scopeRef,
        taskId: reservation.request.taskId,
        amountUsd,
        createdAt: now,
      });
    }
    const event: ModelBudgetEvent = {
      id: this.idGenerator(),
      reservationId,
      policyIds: reservation.policyIds,
      taskId: reservation.request.taskId,
      workspaceId: reservation.request.workspaceId ?? null,
      providerId: reservation.request.providerId,
      amountUsd,
      status: 'committed',
      createdAt: now,
      expiresAt: null,
    };
    this.emit(event);
    this.prune(now);
    return event;
  }

  public release(reservationId: string): ModelBudgetEvent | null {
    const reservation = this.takeReservation(reservationId);
    if (!reservation) return null;
    const event: ModelBudgetEvent = {
      id: this.idGenerator(),
      reservationId,
      policyIds: reservation.policyIds,
      taskId: reservation.request.taskId,
      workspaceId: reservation.request.workspaceId ?? null,
      providerId: reservation.request.providerId,
      amountUsd: reservation.amountUsd,
      status: 'released',
      createdAt: this.now(),
      expiresAt: null,
    };
    this.emit(event);
    return event;
  }

  public clearTask(taskIdValue: string): void {
    const taskId = normalizeId(taskIdValue, 'taskId');
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.request.taskId === taskId) {
        this.release(reservation.id);
      }
    }
    let writeIndex = 0;
    for (const record of this.committed) {
      if (record.taskId === taskId) continue;
      this.committed[writeIndex++] = record;
    }
    this.committed.length = writeIndex;
  }

  private evaluatePolicy(
    policy: ModelBudgetPolicy,
    scopeRef: string,
    requestedUsd: number,
    now: number,
  ): ModelBudgetPolicyEvaluation {
    const windowStart = now - policy.windowMs;
    const spentUsd = this.committed
      .filter(
        (record) =>
          record.policyId === policy.id &&
          record.scopeRef === scopeRef &&
          record.createdAt >= windowStart,
      )
      .reduce((total, record) => total + record.amountUsd, 0);
    const reservedUsd = [...this.reservations.values()]
      .filter((reservation) => {
        if (!reservation.policyIds.includes(policy.id)) return false;
        return (
          resolveRequestScope(policy.scope, reservation.request) === scopeRef
        );
      })
      .reduce((total, reservation) => total + reservation.amountUsd, 0);
    const projectedUsd = spentUsd + reservedUsd + requestedUsd;
    return {
      policyId: policy.id,
      scope: policy.scope,
      scopeRef,
      mode: policy.mode,
      windowMs: policy.windowMs,
      limitUsd: policy.limitUsd,
      spentUsd,
      reservedUsd,
      requestedUsd,
      projectedUsd,
      exceeded: projectedUsd > policy.limitUsd,
    };
  }

  private takeReservation(id: string): ModelBudgetReservation | null {
    const normalized = normalizeId(id, 'reservationId');
    const reservation = this.reservations.get(normalized);
    if (!reservation) return null;
    this.reservations.delete(normalized);
    return reservation;
  }

  private prune(now: number): void {
    for (const reservation of this.reservations.values()) {
      if (reservation.expiresAt > now) continue;
      this.reservations.delete(reservation.id);
      this.emit({
        id: this.idGenerator(),
        reservationId: reservation.id,
        policyIds: reservation.policyIds,
        taskId: reservation.request.taskId,
        workspaceId: reservation.request.workspaceId ?? null,
        providerId: reservation.request.providerId,
        amountUsd: reservation.amountUsd,
        status: 'released',
        createdAt: now,
        expiresAt: null,
      });
    }
    const maximumWindow = Math.max(
      0,
      ...this.policies.map((policy) => policy.windowMs),
    );
    const oldestRelevant = now - maximumWindow;
    let writeIndex = 0;
    for (const record of this.committed) {
      if (record.createdAt < oldestRelevant) continue;
      this.committed[writeIndex++] = record;
    }
    this.committed.length = writeIndex;
  }

  private emit(event: ModelBudgetEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Accounting/audit failures must not corrupt the deterministic engine.
    }
  }
}

function normalizePolicies(
  policies: readonly ModelBudgetPolicy[],
): ModelBudgetPolicy[] {
  const seen = new Set<string>();
  return policies.map((policy) => {
    const id = normalizeId(policy.id, 'policy.id');
    if (seen.has(id)) throw new Error(`Duplicate model budget policy: ${id}`);
    seen.add(id);
    if (
      policy.scope !== 'global' &&
      policy.scope !== 'task' &&
      policy.scope !== 'workspace' &&
      policy.scope !== 'provider'
    ) {
      throw new Error(`Invalid model budget scope: ${String(policy.scope)}`);
    }
    if (policy.mode !== 'soft' && policy.mode !== 'hard') {
      throw new Error(`Invalid model budget mode: ${String(policy.mode)}`);
    }
    return {
      id,
      scope: policy.scope,
      scopeRef: normalizeScopeRef(policy.scopeRef),
      windowMs: normalizePositiveInteger(policy.windowMs, 'policy.windowMs'),
      limitUsd: normalizeMoney(policy.limitUsd, 'policy.limitUsd'),
      mode: policy.mode,
    };
  });
}

function normalizeRequest(request: ModelBudgetRequest): ModelBudgetRequest {
  return {
    taskId: normalizeId(request.taskId, 'taskId'),
    workspaceId:
      request.workspaceId == null
        ? null
        : normalizeScopeRef(request.workspaceId),
    providerId: normalizeId(request.providerId, 'providerId'),
    estimatedCostUsd: normalizeMoney(
      request.estimatedCostUsd,
      'estimatedCostUsd',
    ),
  };
}

function resolveRequestScope(
  scope: ModelBudgetScopeKind,
  request: ModelBudgetRequest,
): string | null {
  if (scope === 'global') return 'global';
  if (scope === 'task') return request.taskId;
  if (scope === 'provider') return request.providerId;
  return request.workspaceId ?? null;
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096 || normalized.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function normalizeScopeRef(value: string): string {
  if (value === '*') return value;
  return normalizeId(value, 'scopeRef');
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('createdAt must be a non-negative safe integer');
  }
  return value;
}

function normalizeMoney(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} must be a finite non-negative USD amount`);
  }
  return value;
}
