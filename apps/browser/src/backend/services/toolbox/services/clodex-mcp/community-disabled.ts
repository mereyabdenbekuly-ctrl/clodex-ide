import type { Tool } from 'ai';
import type { ClodexMcpCapabilityStatus } from '@shared/karton-contracts/ui';

/**
 * Compile-time replacement for the managed MCP connector in Free builds.
 *
 * The public Community artifact keeps user-configured MCP available, but it
 * does not bundle a configured hosted connector or managed endpoint.
 */
export class ClodexMcpService {
  public async getTools(
    _agentInstanceId: string,
    _approvalLifecycleEpoch = 0,
  ): Promise<Record<string, Tool>> {
    return {};
  }

  public async getCapabilityStatus(
    _refresh = false,
  ): Promise<ClodexMcpCapabilityStatus> {
    return {
      state: 'unavailable',
      gatewayUrl: '',
      checkedAt: new Date(),
      cacheExpiresAt: null,
      tools: [],
      error: 'Managed tools are not included in this build.',
    };
  }

  public async teardown(): Promise<void> {}
}
