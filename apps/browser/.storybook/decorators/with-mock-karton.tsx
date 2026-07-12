import type { Decorator } from '@storybook/react';
import { MockKartonProvider, MockOpenAgentProvider } from '../mocks/mock-hooks';
import type { MockKartonProcedures } from '../mocks/mock-hooks';
import type { AppState } from '@shared/karton-contracts/ui';
import { DEFAULT_STORY_AGENT_ID } from './scenarios/shared-utilities';

/**
 * Storybook decorator that provides mock Karton state to components.
 *
 * Usage in stories:
 * ```tsx
 * export default {
 *   decorators: [withMockKarton],
 *   parameters: {
 *     mockKartonState: {
 *       workspace: { ... }
 *     },
 *     agentInstanceId: 'my-agent-id' // Optional, defaults to DEFAULT_STORY_AGENT_ID
 *   }
 * }
 * ```
 */
export const withMockKarton: Decorator = (Story, context) => {
  const mockState = context.parameters.mockKartonState as
    | Partial<AppState>
    | undefined;
  const mockProcedures = context.parameters.mockKartonProcedures as
    | MockKartonProcedures
    | undefined;
  const agentInstanceId =
    (context.parameters.agentInstanceId as string) ?? DEFAULT_STORY_AGENT_ID;

  return (
    <MockKartonProvider mockState={mockState} mockProcedures={mockProcedures}>
      <MockOpenAgentProvider agentInstanceId={agentInstanceId}>
        <Story />
      </MockOpenAgentProvider>
    </MockKartonProvider>
  );
};
