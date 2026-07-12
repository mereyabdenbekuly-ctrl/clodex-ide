import {
  type ExecuteSandboxJsToolInput,
  executeSandboxJsToolInputSchema,
} from '@shared/karton-contracts/ui/agent/tools/types';
import { tool } from 'ai';
import { rethrowCappedToolOutputError } from '../../utils';
import { capToolOutput } from '../../utils';
import type { SandboxService } from '@/services/sandbox';
import type {
  GuardianAssessment,
  GuardianPolicyChecker,
} from '@shared/guardian';
import { createSandboxGuardianRequest } from '@/services/guardian/requests';

export const DESCRIPTION = `Execute JavaScript in your persistent, sandboxed Node.js VM context.
`;

export interface SandboxGuardianDeps {
  assess: GuardianPolicyChecker;
  recordPendingApproval: (toolCallId: string, explanation: string) => void;
}

export const executeSandboxJs = (
  sandboxService: SandboxService,
  agentInstanceId: string,
  guardian?: SandboxGuardianDeps,
) => {
  return tool({
    description: DESCRIPTION,
    inputSchema: executeSandboxJsToolInputSchema,
    strict: false,
    needsApproval: async (params, { toolCallId }) => {
      if (!guardian) return false;

      let assessment: GuardianAssessment | null;
      try {
        assessment = await guardian.assess(
          createSandboxGuardianRequest(params.script),
        );
      } catch {
        guardian.recordPendingApproval(
          toolCallId,
          'Guardian assessment failed. Approving manually to stay safe.',
        );
        return true;
      }
      if (!assessment) return false;
      if (assessment.decision === 'deny') {
        throw new Error(`Guardian denied action: ${assessment.explanation}`);
      }
      if (assessment.irreversible || assessment.decision === 'escalate') {
        guardian.recordPendingApproval(toolCallId, assessment.explanation);
        return true;
      }
      return false;
    },
    execute: async (params, options) => {
      const { toolCallId } = options as { toolCallId: string };
      sandboxService.setAgentToolCallId(agentInstanceId, toolCallId);
      try {
        const result = await executeSandboxJsToolExecute(
          params,
          agentInstanceId,
          sandboxService,
        );
        const fileWriteCount =
          sandboxService.getAndClearFileWriteCount(agentInstanceId);
        if (fileWriteCount > 0)
          return { ...result, _hasFileWrites: true as const };

        return result;
      } finally {
        sandboxService.clearPendingOutputs(agentInstanceId, toolCallId);
        sandboxService.clearAgentToolCallId(agentInstanceId);
      }
    },
  });
};

async function executeSandboxJsToolExecute(
  params: ExecuteSandboxJsToolInput,
  agentInstanceId: string,
  sandboxService: SandboxService,
) {
  try {
    const { value, outputs } = await sandboxService.execute(
      agentInstanceId,
      params.script,
    );

    const parts: string[] = [...outputs];
    if (value !== undefined && value !== null) {
      parts.push(typeof value === 'string' ? value : JSON.stringify(value));
    }
    const scriptResult = parts.join('\n');

    return {
      message: 'Successfully executed sandbox JavaScript',
      result: capToolOutput(scriptResult),
    };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}
