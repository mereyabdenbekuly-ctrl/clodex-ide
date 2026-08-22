export type SwarmTaskRole = 'researcher' | 'planner' | 'coder' | 'reviewer';
export type SwarmModelTaskRole = 'analysis' | 'coding' | 'review';
export type SwarmRunStatus = 'running' | 'completed' | 'failed';
export type SwarmPhaseStatus = 'pending' | 'running' | 'completed' | 'failed';
export type SwarmTaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type SwarmTaskLogEntry = {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
};

export type SwarmTaskState = {
  id: string;
  name: string;
  role: SwarmTaskRole;
  modelTaskRole: SwarmModelTaskRole;
  preferredModelId?: string;
  resolvedModelId?: string;
  status: SwarmTaskStatus;
  prompt: string;
  output?: string;
  error?: string;
  logs: SwarmTaskLogEntry[];
  metrics: {
    tokens: number;
    toolsUsed: number;
  };
};

export type SwarmPhaseState = {
  id: string;
  title: string;
  status: SwarmPhaseStatus;
  tasks: SwarmTaskState[];
};

export type SwarmRunState = {
  id: string;
  agentInstanceId: string;
  description: string;
  status: SwarmRunStatus;
  taskComplexity: 'medium' | 'high';
  startedAt: number;
  completedAt?: number;
  error?: string;
  phases: SwarmPhaseState[];
};
