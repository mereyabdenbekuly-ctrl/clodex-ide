import type { AppState } from '@shared/karton-contracts/ui';

type ContentTabs = AppState['contentTabs'];

/**
 * Ordered tab IDs for an agent context: global (agentInstanceId === null)
 * tabs first, then the agent's own ordered tabs. Stale entries are filtered.
 */
export function getTabOrderForAgent(
  contentTabs: ContentTabs,
  agentInstanceId: string | null,
): string[] {
  const globalIds = contentTabs.globalOrder.filter((id) => {
    const tab = contentTabs.tabs[id];
    return tab && tab.agentInstanceId === null;
  });
  const agentIds = agentInstanceId
    ? (contentTabs.agentOrders[agentInstanceId] ?? []).filter((id) => {
        const tab = contentTabs.tabs[id];
        return tab && tab.agentInstanceId === agentInstanceId;
      })
    : [];
  return [...globalIds, ...agentIds];
}

/** All known tab IDs in deterministic display order (global, then per-agent,
 *  then any remaining tabs sorted by ID). */
export function getAllOrderedTabIds(contentTabs: ContentTabs): string[] {
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const pushIfValid = (id: string) => {
    if (seen.has(id)) return;
    if (!contentTabs.tabs[id]) return;
    seen.add(id);
    orderedIds.push(id);
  };

  for (const id of contentTabs.globalOrder) pushIfValid(id);
  for (const agentId of Object.keys(contentTabs.agentOrders).sort()) {
    for (const id of contentTabs.agentOrders[agentId] ?? []) {
      pushIfValid(id);
    }
  }
  for (const id of Object.keys(contentTabs.tabs).sort()) pushIfValid(id);
  return orderedIds;
}

/** Drops stale/duplicate order entries; optionally removing one tab. */
export function cleanupTabOrders(
  contentTabs: ContentTabs,
  removedTabId?: string,
): void {
  const seen = new Set<string>();
  contentTabs.globalOrder = contentTabs.globalOrder.filter((id) => {
    if (id === removedTabId || seen.has(id)) return false;
    const tab = contentTabs.tabs[id];
    if (!tab || tab.agentInstanceId !== null) return false;
    seen.add(id);
    return true;
  });

  for (const agentId of Object.keys(contentTabs.agentOrders)) {
    const agentSeen = new Set<string>();
    contentTabs.agentOrders[agentId] = contentTabs.agentOrders[agentId]!.filter(
      (id) => {
        if (id === removedTabId || agentSeen.has(id)) return false;
        const tab = contentTabs.tabs[id];
        if (!tab || tab.agentInstanceId !== agentId) return false;
        agentSeen.add(id);
        return true;
      },
    );
    if (contentTabs.agentOrders[agentId]!.length === 0) {
      delete contentTabs.agentOrders[agentId];
    }
  }
}

export function removeFromTabOrders(
  contentTabs: ContentTabs,
  tabId: string,
): void {
  cleanupTabOrders(contentTabs, tabId);
}

export function addToTabOrder(
  contentTabs: ContentTabs,
  tabId: string,
  agentInstanceId: string | null,
  index?: number,
): void {
  removeFromTabOrders(contentTabs, tabId);
  let order = contentTabs.globalOrder;
  if (agentInstanceId) {
    contentTabs.agentOrders[agentInstanceId] ??= [];
    order = contentTabs.agentOrders[agentInstanceId];
  }
  const insertIndex = Math.max(
    0,
    Math.min(index ?? order.length, order.length),
  );
  order.splice(insertIndex, 0, tabId);
}

export function getTabOrderIndex(
  contentTabs: ContentTabs,
  tabId: string,
  agentInstanceId: string | null,
): number {
  const order = agentInstanceId
    ? (contentTabs.agentOrders[agentInstanceId] ?? [])
    : contentTabs.globalOrder;
  return order.indexOf(tabId);
}
