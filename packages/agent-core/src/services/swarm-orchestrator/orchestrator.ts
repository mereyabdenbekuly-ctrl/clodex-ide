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
  ): Promise<DynamicSwarmExecutionResult> {
    const triage = await this.triage(userPrompt);
    if (triage.type === 'direct') {
      return { type: 'direct', triage };
    }

    const run = await this.runner.run(triage.plan);
    return { type: 'swarm', triage, run };
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
