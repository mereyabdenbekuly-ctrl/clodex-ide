import {
  PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND,
  PRODUCTION_AUTHORITY_VERSION,
  bootstrapProductionAuthority,
  type ProductionAuthorityBootstrapInput,
  type ProductionAuthorityDescriptor,
  type ProductionAuthorityDiagnostic,
  type ProductionAuthorityHandle,
} from '@clodex/production';
import { DisposableService } from '../disposable';
import type { Logger } from '../logger';

export interface SafeCodingProductionBootstrapProvider {
  /**
   * Returns only trusted constructor ports selected by deployment code. Model,
   * renderer, request, environment-prompt, or plugin input must never implement
   * this provider.
   */
  load(): Promise<ProductionAuthorityBootstrapInput | null>;
}

export interface SafeCodingProductionAuthoritySnapshot {
  diagnostic: ProductionAuthorityDiagnostic;
  descriptor: ProductionAuthorityDescriptor | null;
}

type ControlPlaneCallbacks = ProductionAuthorityHandle['controlPlane'];
type AdapterCallbacks = ProductionAuthorityHandle['adapters'];

/**
 * Browser-side fail-closed composition boundary for `@clodex/production`.
 *
 * The service never exposes the raw authority handle, registry ports, adapter
 * port, feature-gate mutator, or caller-injected effect callback. It publishes
 * only the fixed operations already closed by `@clodex/production`. If no
 * trusted bootstrap provider is installed, the service remains authority-null.
 */
export class SafeCodingProductionAuthorityService extends DisposableService {
  private authority: ProductionAuthorityHandle | null = null;
  private diagnostic: ProductionAuthorityDiagnostic;
  private acceptingOperations = true;
  private activeOperations = 0;
  private readonly idleWaiters = new Set<() => void>();

  private constructor(private readonly logger: Pick<Logger, 'warn'>) {
    super();
    this.diagnostic = createProviderUnavailableDiagnostic();
  }

  public static async create(options: {
    logger: Pick<Logger, 'warn'>;
    provider?: SafeCodingProductionBootstrapProvider | null;
  }): Promise<SafeCodingProductionAuthorityService> {
    const service = new SafeCodingProductionAuthorityService(options.logger);
    const provider = options.provider;
    if (!provider) return service;

    let input: ProductionAuthorityBootstrapInput | null;
    try {
      input = await provider.load();
    } catch (error) {
      service.logger.warn(
        '[SafeCodingProductionAuthority] Trusted bootstrap input is unavailable',
        error,
      );
      service.diagnostic = createUnexpectedFailureDiagnostic();
      return service;
    }
    if (!input) return service;

    const result = await bootstrapProductionAuthority(input);
    service.authority = result.authority;
    service.diagnostic = structuredClone(result.diagnostic);
    return service;
  }

  public snapshot(): SafeCodingProductionAuthoritySnapshot {
    return {
      diagnostic: structuredClone(this.diagnostic),
      descriptor: this.authority
        ? structuredClone(this.authority.descriptor)
        : null,
    };
  }

  public prepare(
    input: Parameters<ControlPlaneCallbacks['prepare']>[0],
  ): ReturnType<ControlPlaneCallbacks['prepare']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.prepare(input),
    );
  }

  public consumeCommitPermit(
    input: Parameters<ControlPlaneCallbacks['consumeCommitPermit']>[0],
  ): ReturnType<ControlPlaneCallbacks['consumeCommitPermit']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.consumeCommitPermit(input),
    );
  }

  public executeOnce(
    input: Parameters<ControlPlaneCallbacks['executeOnce']>[0],
  ): ReturnType<ControlPlaneCallbacks['executeOnce']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.executeOnce(input),
    );
  }

  public abortPrepared(
    input: Parameters<ControlPlaneCallbacks['abortPrepared']>[0],
  ): ReturnType<ControlPlaneCallbacks['abortPrepared']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.abortPrepared(input),
    );
  }

  public deliverEvidence(
    input: Parameters<ControlPlaneCallbacks['deliverEvidence']>[0],
  ): ReturnType<ControlPlaneCallbacks['deliverEvidence']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.deliverEvidence(input),
    );
  }

  public get(transactionId: string): ReturnType<ControlPlaneCallbacks['get']> {
    return this.withAuthority((authority) =>
      authority.controlPlane.get(transactionId),
    );
  }

  public pendingEvidence(): ReturnType<
    ControlPlaneCallbacks['pendingEvidence']
  > {
    return this.withAuthority((authority) =>
      authority.controlPlane.pendingEvidence(),
    );
  }

  public resolveAuthorizationBinding(
    action: Parameters<AdapterCallbacks['resolveAuthorizationBinding']>[0],
  ): ReturnType<AdapterCallbacks['resolveAuthorizationBinding']> {
    return this.withAuthority((authority) =>
      authority.adapters.resolveAuthorizationBinding(action),
    );
  }

  public prepareAuthorization(
    action: Parameters<AdapterCallbacks['prepareAuthorization']>[0],
    binding: Parameters<AdapterCallbacks['prepareAuthorization']>[1],
  ): ReturnType<AdapterCallbacks['prepareAuthorization']> {
    return this.withAuthority((authority) =>
      authority.adapters.prepareAuthorization(action, binding),
    );
  }

  private async withAuthority<T>(
    operation: (authority: ProductionAuthorityHandle) => Promise<T>,
  ): Promise<T> {
    this.assertNotDisposed();
    if (!this.acceptingOperations) {
      throw new Error('Safe Coding production authority is shutting down');
    }
    const authority = this.authority;
    if (!authority) {
      throw new Error(
        `Safe Coding production authority is disabled (${this.diagnostic.blockerCode ?? 'authority-unavailable'})`,
      );
    }

    authority.assertCurrentSynchronously();
    this.activeOperations += 1;
    try {
      return await operation(authority);
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  protected async onTeardown(): Promise<void> {
    this.acceptingOperations = false;
    if (this.activeOperations > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    this.authority = null;
    this.diagnostic = createProviderUnavailableDiagnostic();
  }
}

function createProviderUnavailableDiagnostic(): ProductionAuthorityDiagnostic {
  return {
    kind: PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    status: 'disabled',
    authorityPublished: false,
    authorityGateDefault: 'off',
    automaticPromotion: false,
    stage: 'input',
    blockerCode: 'input-invalid',
    blockerName: 'trusted-bootstrap-provider-unavailable',
    deploymentId: null,
    authorityId: null,
    promotionEligibility: null,
    recoveryRecordCount: null,
    recoveryUnresolvedCount: null,
  };
}

function createUnexpectedFailureDiagnostic(): ProductionAuthorityDiagnostic {
  return {
    ...createProviderUnavailableDiagnostic(),
    blockerCode: 'unexpected-failure',
    blockerName: 'trusted-bootstrap-provider-failed',
  };
}
