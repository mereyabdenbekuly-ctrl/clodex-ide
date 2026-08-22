import type { MountEntry } from '@clodex/agent-core/types/metadata';
import type { QuestionField, QuestionAnswerValue } from './agent/tools/types';

export const EMPTY_MOUNTS: MountEntry[] = [];

export type PendingUserQuestion = {
  id: string;
  title: string;
  description?: string;
  steps: Array<{
    title?: string;
    description?: string;
    fields: QuestionField[];
  }>;
  currentStep: number;
  answers: Record<string, QuestionAnswerValue>;
};

export type ClodexMcpCapabilityTool = {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
  requiresApproval: boolean;
  destructive: boolean;
  inputFields: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
};

export type ClodexMcpCapabilityStatus = {
  state: 'connected' | 'signed-out' | 'unavailable';
  gatewayUrl: string;
  checkedAt: Date;
  cacheExpiresAt: Date | null;
  tools: ClodexMcpCapabilityTool[];
  error?: string;
};
