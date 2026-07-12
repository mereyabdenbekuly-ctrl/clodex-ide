export const MCP_MAX_CATALOG_ITEMS = 5_000;
export const MCP_MAX_CATALOG_PAGES = 100;

export async function collectMcpCatalogPages<T>(
  loadPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < MCP_MAX_CATALOG_PAGES; pageCount += 1) {
    const page = await loadPage(cursor);
    items.push(...page.items);
    if (items.length > MCP_MAX_CATALOG_ITEMS) {
      throw new Error(
        `MCP context list exceeds ${MCP_MAX_CATALOG_ITEMS} items`,
      );
    }
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('MCP context pagination cursor repeated');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`MCP context list exceeds ${MCP_MAX_CATALOG_PAGES} pages`);
}
