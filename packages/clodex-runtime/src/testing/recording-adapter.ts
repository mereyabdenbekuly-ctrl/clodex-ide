import type {
  SafeCodingAction,
  SafeCodingEvidenceLevel,
} from '@clodex/contracts';
import type { TrustedSafeCodingAdapterBinding } from '@clodex/guardian';
import type {
  PreparedRuntimeEffect,
  SafeCodingRuntimeAdapter,
  SafeCodingRuntimeAdapterPrepareInput,
  SafeCodingRuntimeAdapterResult,
} from '../reference-runtime.js';

export type RecordingAdapterMode = 'success' | 'fail-prepare' | 'fail-execute';

export interface RecordingSafeCodingAdapterOptions {
  readonly binding: TrustedSafeCodingAdapterBinding;
  readonly mode?: RecordingAdapterMode;
  readonly failure?: unknown;
  readonly result?: unknown;
  readonly preStateHash?: string | null;
  readonly postStateHash?: string | null;
  readonly evidenceLevel?: SafeCodingEvidenceLevel;
  readonly duringPrepare?: () => void | Promise<void>;
  readonly beforeExecute?: () => void | Promise<void>;
}

/**
 * Test-only adapter that records a simulated effect counter. It has no host or
 * external-effect capability and exists solely for runtime conformance tests.
 */
export class RecordingSafeCodingAdapter implements SafeCodingRuntimeAdapter {
  public readonly binding: TrustedSafeCodingAdapterBinding;
  public prepareCount = 0;
  public executeCount = 0;
  public effectCount = 0;
  public readonly actions: SafeCodingAction[] = [];

  readonly #options: RecordingSafeCodingAdapterOptions;

  public constructor(options: RecordingSafeCodingAdapterOptions) {
    this.#options = Object.freeze({ ...options });
    this.binding = Object.freeze({ ...options.binding });
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    this.prepareCount += 1;
    this.actions.push(input.action);
    const mode = this.#options.mode ?? 'success';
    await this.#options.duringPrepare?.();
    if (mode === 'fail-prepare') {
      this.throwConfiguredFailure('recording adapter PREPARE failed');
    }

    return Object.freeze({
      execute: async (): Promise<SafeCodingRuntimeAdapterResult> => {
        this.executeCount += 1;
        await this.#options.beforeExecute?.();

        // The only simulated target effect is owned by this prepared closure.
        // Runtime tests prove it remains unreachable until COMMIT_PERMIT.
        this.effectCount += 1;
        if (mode === 'fail-execute') {
          this.throwConfiguredFailure(
            'recording prepared effect failed after COMMIT_PERMIT',
          );
        }
        return this.createResult();
      },
    });
  }

  private createResult(): SafeCodingRuntimeAdapterResult {
    return {
      result: (this.#options.result ?? { ok: true }) as never,
      preStateHash: this.#options.preStateHash ?? null,
      postStateHash: this.#options.postStateHash ?? null,
      evidenceLevel: this.#options.evidenceLevel ?? 'adapter_observed',
    };
  }

  private throwConfiguredFailure(message: string): never {
    if (Object.hasOwn(this.#options, 'failure')) {
      throw this.#options.failure;
    }
    throw new Error(message);
  }
}

export class RecordingSafeCodingAdapterRegistry {
  readonly #adapters = new Map<
    SafeCodingAction['action'],
    SafeCodingRuntimeAdapter
  >();

  public constructor(adapters: readonly SafeCodingRuntimeAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public register(adapter: SafeCodingRuntimeAdapter): void {
    this.#adapters.set(adapter.binding.action, adapter);
  }

  public resolve(action: SafeCodingAction): SafeCodingRuntimeAdapter | null {
    return this.#adapters.get(action.action) ?? null;
  }

  public resolveBinding(
    action: SafeCodingAction,
  ): TrustedSafeCodingAdapterBinding | null {
    return this.resolve(action)?.binding ?? null;
  }
}
