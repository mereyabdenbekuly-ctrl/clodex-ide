export interface IdentifiedMcpConnection<TClient extends object = object> {
  connectionId: string;
  client: TClient;
}

export class StaleMcpConnectionError extends Error {
  public constructor(serverId: string) {
    super(`MCP server "${serverId}" connection is no longer current`);
    this.name = 'StaleMcpConnectionError';
  }
}

export function isExactMcpConnection<
  TClient extends object,
  TConnection extends IdentifiedMcpConnection<TClient>,
>(
  connections: ReadonlyMap<string, TConnection>,
  serverId: string,
  client: TClient,
  connectionId: string,
): boolean {
  const current = connections.get(serverId);
  return current?.client === client && current.connectionId === connectionId;
}

export function requireExactMcpConnection<
  TClient extends object,
  TConnection extends IdentifiedMcpConnection<TClient>,
>(
  connections: ReadonlyMap<string, TConnection>,
  serverId: string,
  client: TClient,
  connectionId: string,
): void {
  if (!isExactMcpConnection(connections, serverId, client, connectionId)) {
    throw new StaleMcpConnectionError(serverId);
  }
}

export function deleteExactMcpConnection<
  TClient extends object,
  TConnection extends IdentifiedMcpConnection<TClient>,
>(
  connections: Map<string, TConnection>,
  serverId: string,
  client: TClient,
  connectionId: string,
): TConnection | undefined {
  if (!isExactMcpConnection(connections, serverId, client, connectionId)) {
    return undefined;
  }
  const current = connections.get(serverId);
  connections.delete(serverId);
  return current;
}
