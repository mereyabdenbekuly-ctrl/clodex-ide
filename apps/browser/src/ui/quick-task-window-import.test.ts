import { describe, expect, it } from 'vitest';

describe('Quick Task window renderer isolation', () => {
  it('loads without the main-window Electron/Karton preload bridge', async () => {
    await expect(import('./quick-task-window')).resolves.toMatchObject({
      QuickTaskWindowApp: expect.any(Function),
    });
  });
});
