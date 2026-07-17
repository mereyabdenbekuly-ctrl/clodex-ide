import {
  buildTriagePrompt,
  createFallbackSwarmPlan,
  estimateTaskComplexity,
  parseTriageResult,
} from './planner';
import { SwarmRunner } from './runner';
import type {
  DynamicTriageResult,
  SwarmEventListener,
  SwarmPlan,
  SwarmRunResult,
  SwarmTaskExecutor,
} from './types';

export type SwarmTriageProvider = (prompt: string) => Promise<unknown>;

export interface DynamicSwarmOrchestratorOptions {
  triage: SwarmTriageProvider;
  executor: SwarmTaskExecutor;
  idGenerator?: () => string;
  onTriageError?: (error: Error) => void;
}

export interface DynamicSwarmExecuteOptions {
  /**
   * Ultra-style orchestration must never replace the normal model turn with
   * a status-only direct triage result. When enabled, a direct result is
   * promoted to the deterministic medium Swarm plan.
   */
  forceSwarmOnDirect?: boolean;
}

export type DynamicSwarmExecutionResult =
  | {
      type: 'direct';
      triage: Extract<DynamicTriageResult, { type: 'direct' }>;
    }
  | {
      type: 'swarm';
      triage: Extract<DynamicTriageResult, { type: 'swarm' }>;
      run: SwarmRunResult;
    };

export class DynamicSwarmOrchestrator {
  private readonly triageProvider: SwarmTriageProvider;
  private readonly runner: SwarmRunner;
  private readonly onTriageError?: ((error: Error) => void) | undefined;

  constructor(options: DynamicSwarmOrchestratorOptions) {
    this.triageProvider = options.triage;
    this.runner = new SwarmRunner({
      executor: options.executor,
      idGenerator: options.idGenerator,
    });
    this.onTriageError = options.onTriageError;
  }

  public on(listener: SwarmEventListener): () => void {
    return this.runner.on(listener);
  }

  public async triage(userPrompt: string): Promise<DynamicTriageResult> {
    try {
      const raw = await this.triageProvider(buildTriagePrompt(userPrompt));
      return parseTriageResult(raw);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onTriageError?.(err);
      return this.createFallbackTriage(userPrompt);
    }
  }

  public async execute(
    userPrompt: string,
    options: DynamicSwarmExecuteOptions = {},
  ): Promise<DynamicSwarmExecutionResult> {
    const triageResult = await this.triage(userPrompt);
    if (triageResult.type === 'direct') {
      if (!options.forceSwarmOnDirect) {
        return { type: 'direct', triage: triageResult };
      }
      const plan = createFallbackSwarmPlan(userPrompt, 'medium');
      const triage: Extract<DynamicTriageResult, { type: 'swarm' }> = {
        type: 'swarm',
        taskComplexity: 'medium',
        plan,
      };
      const run = await this.runner.run(plan);
      return { type: 'swarm', triage, run };
    }

    const run = await this.runner.run(triageResult.plan);
    return { type: 'swarm', triage: triageResult, run };
  }

  private createFallbackTriage(userPrompt: string): DynamicTriageResult {
    const complexity = estimateTaskComplexity(userPrompt);
    if (complexity === 'low') {
      return {
        type: 'direct',
        taskComplexity: 'low',
        reason: 'Fallback heuristic classified this as a small direct task.',
      };
    }

    const plan: SwarmPlan = createFallbackSwarmPlan(userPrompt, complexity);
    return {
      type: 'swarm',
      taskComplexity: complexity,
      plan,
    };
  }
}
