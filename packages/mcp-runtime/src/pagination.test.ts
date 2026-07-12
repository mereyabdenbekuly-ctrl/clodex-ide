import { describe, expect, it, vi } from 'vitest';
import {
  collectMcpCatalogPages,
  MCP_MAX_CATALOG_ITEMS,
  MCP_MAX_CATALOG_PAGES,
} from './pagination';

describe('MCP catalog pagination', () => {
  it('aggregates pages and rejects repeated cursors', async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ items: ['one'], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: ['two'] });

    await expect(collectMcpCatalogPages(loadPage)).resolves.toEqual([
      'one',
      'two',
    ]);
    expect(loadPage).toHaveBeenNthCalledWith(2, 'page-2');

    await expect(
      collectMcpCatalogPages(
        vi
          .fn()
          .mockResolvedValueOnce({ items: [], nextCursor: 'repeat' })
          .mockResolvedValueOnce({ items: [], nextCursor: 'repeat' }),
      ),
    ).rejects.toThrow('pagination cursor repeated');
  });

  it('enforces item and page caps', async () => {
    await expect(
      collectMcpCatalogPages(async () => ({
        items: Array.from(
          { length: MCP_MAX_CATALOG_ITEMS + 1 },
          (_, index) => index,
        ),
      })),
    ).rejects.toThrow(`exceeds ${MCP_MAX_CATALOG_ITEMS} items`);

    let page = 0;
    await expect(
      collectMcpCatalogPages(async () => {
        page += 1;
        return { items: [page], nextCursor: `page-${page + 1}` };
      }),
    ).rejects.toThrow(`exceeds ${MCP_MAX_CATALOG_PAGES} pages`);
    expect(page).toBe(MCP_MAX_CATALOG_PAGES);
  });
});
