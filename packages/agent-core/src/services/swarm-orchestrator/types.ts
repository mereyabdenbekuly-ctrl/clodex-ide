import { z } from 'zod';
import type { ModelTaskRole } from '../../host/models';

export const taskComplexitySchema = z.enum(['low', 'medium', 'high']);
export type TaskComplexity = z.infer<typeof taskComplexitySchema>;

export const swarmTaskRoleSchema = z.enum([
  'researcher',
  'planner',
  'coder',
  'reviewer',
]);
export type SwarmTaskRole = z.infer<typeof swarmTaskRoleSchema>;

export const modelTaskRoleSchema = z.enum(['analysis', 'coding', 'review']);

export const swarmTaskSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  role: swarmTaskRoleSchema,
  modelTaskRole: modelTaskRoleSchema.optional(),
  preferredModelId: z.string().min(1).optional(),
  prompt: z.string().min(1),
});
export type SwarmTask = z.infer<typeof swarmTaskSchema>;

export const swarmPhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  failureMode: z.enum(['hard', 'soft']).optional(),
  tasks: z.array(swarmTaskSchema).min(1),
});
export type SwarmPhase = z.infer<typeof swarmPhaseSchema>;

export const swarmWorkflowSchema = z.object({
  description: z.string().min(1),
  phases: z.array(swarmPhaseSchema).min(1),
});
export type SwarmWorkflow = z.infer<typeof swarmWorkflowSchema>;

export const swarmPlanSchema = z.object({
  task_complexity: z.enum(['medium', 'high']),
  workflow: swarmWorkflowSchema,
});
export type SwarmPlan = z.infer<typeof swarmPlanSchema>;

export const directTriageSchema = z.object({
  type: z.literal('direct'),
  task_complexity: z.literal('low'),
  reason: z.string().optional(),
});

export const swarmTriageSchema = swarmPlanSchema.extend({
  type: z.literal('swarm').optional(),
});

export const triageResultSchema = z.union([
  directTriageSchema,
  swarmTriageSchema,
]);
export type RawTriageResult = z.infer<typeof triageResultSchema>;

export type DynamicTriageResult =
  | {
      type: 'direct';
      taskComplexity: 'low';
      reason?: string;
    }
  | {
      type: 'swarm';
      taskComplexity: 'medium' | 'high';
      plan: SwarmPlan;
    };

export type SwarmTaskMetrics = {
  newTokens?: number;
  toolsUsed?: number;
  resolvedModelId?: string;
  log?: SwarmTaskLogEntry;
};

export type SwarmTaskLogEntry = {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp?: number;
};

export type SwarmTaskResult = {
  taskId: string;
  taskName: string;
  role: SwarmTaskRole;
  modelTaskRole: ModelTaskRole;
  preferredModelId?: string;
  resolvedModelId?: string;
  output: string;
  metrics?: SwarmTaskMetrics;
};

export type SwarmRunResult = {
  runId: string;
  plan: SwarmPlan;
  results: SwarmTaskResult[];
};

export type SwarmRunEvent =
  | {
      type: 'workflow_started';
      runId: string;
      plan: SwarmPlan;
    }
  | {
      type: 'phase_started';
      runId: string;
      phaseId: string;
      phaseTitle: string;
      phaseIndex: number;
    }
  | {
      type: 'task_started';
      runId: string;
      phaseId: string;
      taskId: string;
      taskName: string;
      role: SwarmTaskRole;
      modelTaskRole: ModelTaskRole;
      preferredModelId?: string;
    }
  | {
      type: 'task_progress';
      runId: string;
      phaseId: string;
      taskId: string;
      metrics: SwarmTaskMetrics;
    }
  | {
      type: 'task_completed';
      runId: string;
      phaseId: string;
      taskId: string;
      result: SwarmTaskResult;
      sharedContext: string;
    }
  | {
      type: 'task_failed';
      runId: string;
      phaseId: string;
      taskId: string;
      error: Error;
    }
  | {
      type: 'phase_completed';
      runId: string;
      phaseId: string;
      results: SwarmTaskResult[];
      sharedContext: string;
    }
  | {
      type: 'workflow_completed';
      runId: string;
      results: SwarmTaskResult[];
      sharedContext: string;
    }
  | {
      type: 'workflow_failed';
      runId: string;
      error: Error;
      partialResults: SwarmTaskResult[];
      sharedContext: string;
    };

export type SwarmEventListener = (event: SwarmRunEvent) => void;

export type SwarmTaskExecutionContext = {
  runId: string;
  plan: SwarmPlan;
  phase: SwarmPhase;
  task: SwarmTask & { id: string };
  phaseIndex: number;
  taskIndex: number;
  modelTaskRole: ModelTaskRole;
  previousResults: readonly SwarmTaskResult[];
  sharedContext: string;
  emitProgress(metrics: SwarmTaskMetrics): void;
};

export type SwarmTaskExecutor = (
  context: SwarmTaskExecutionContext,
) => Promise<
  | string
  | Omit<SwarmTaskResult, 'taskId' | 'taskName' | 'role' | 'preferredModelId'>
>;
