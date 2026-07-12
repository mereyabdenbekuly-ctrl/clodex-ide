import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '@/services/karton';
import type { HostAgentStateMutations } from '@/services/agent-core-bridge/state/agent-instances';
import {
  advanceOrCompleteQuestion,
  requestStructuredUserQuestions,
} from './ask-user-questions';

function createHarness(agentInstanceId: string) {
  const state = {
    toolbox: {} as Record<
      string,
      {
        workspace: { mounts: never[] };
        pendingFileDiffs: never[];
        pendingProposedEdits: never[];
        editSummary: never[];
        pendingUserQuestion: {
          id: string;
          title: string;
          description?: string;
          steps: Array<{
            fields: Array<{
              type: 'input';
              questionId: string;
              label: string;
              required?: boolean;
            }>;
          }>;
          currentStep: number;
          answers: Record<string, string | number | boolean | string[]>;
        } | null;
      }
    >,
  };
  const karton = {
    state,
    setState: (mutate: (draft: typeof state) => void) => mutate(state),
  } as unknown as KartonService;
  const mutations = {
    setUnread: vi.fn(),
  } as unknown as HostAgentStateMutations;
  const request = (signal?: AbortSignal) =>
    requestStructuredUserQuestions({
      uiKarton: karton,
      hostAgentStateMutations: mutations,
      agentInstanceId,
      signal,
      params: {
        title: 'MCP request',
        steps: [
          {
            fields: [
              {
                type: 'input',
                questionId: 'environment',
                label: 'Environment',
                required: true,
              },
            ],
          },
        ],
      },
    });
  return { state, karton, mutations, request };
}

describe('structured user question broker', () => {
  it('resolves submitted answers for external callers', async () => {
    const harness = createHarness('agent-elicitation-complete');
    const resultPromise = harness.request();
    const pending =
      harness.state.toolbox['agent-elicitation-complete']?.pendingUserQuestion;
    expect(pending).not.toBeNull();

    advanceOrCompleteQuestion(
      pending!.id,
      { environment: 'staging' },
      harness.karton,
      'agent-elicitation-complete',
    );

    await expect(resultPromise).resolves.toMatchObject({
      completed: true,
      cancelled: false,
      answers: { environment: 'staging' },
    });
    expect(harness.mutations.setUnread).toHaveBeenCalledWith(
      'agent-elicitation-complete',
      true,
    );
  });

  it('cancels and clears the dialog when the originating request aborts', async () => {
    const harness = createHarness('agent-elicitation-abort');
    const controller = new AbortController();
    const resultPromise = harness.request(controller.signal);

    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      completed: false,
      cancelled: true,
      cancelReason: 'agent_stopped',
    });
    expect(
      harness.state.toolbox['agent-elicitation-abort']?.pendingUserQuestion,
    ).toBeNull();
  });
});
