import { expect, test, type Page } from '@playwright/test';

const FIXED_NOW = Date.parse('2026-07-10T12:00:00.000Z');

type VisualTheme = 'light' | 'dark';

type SurfaceFixture = {
  name: string;
  storyId: string;
  viewport: {
    width: number;
    height: number;
  };
  readyText: string;
};

const surfaces: SurfaceFixture[] = [
  {
    name: 'settings',
    storyId: 'visual-regression-codex-surfaces--settings',
    viewport: { width: 1440, height: 1000 },
    readyText: 'General settings',
  },
  {
    name: 'projects',
    storyId: 'visual-regression-codex-surfaces--projects',
    viewport: { width: 1440, height: 1000 },
    readyText: 'Finish the Codex UI visual regression pass',
  },
  {
    name: 'hosted-pull-request',
    storyId: 'visual-regression-codex-surfaces--hosted-pull-request',
    viewport: { width: 1440, height: 900 },
    readyText:
      'Add stable visual regression coverage for core desktop surfaces',
  },
  {
    name: 'quick-task',
    storyId: 'visual-regression-codex-surfaces--quick-task',
    viewport: { width: 720, height: 520 },
    readyText: 'Quick task',
  },
  {
    name: 'generated-apps',
    storyId: 'visual-regression-codex-surfaces--generated-apps',
    viewport: { width: 1440, height: 1000 },
    readyText: 'Analytics Pulse',
  },
  {
    name: 'plugin-library',
    storyId: 'visual-regression-codex-surfaces--plugin-library',
    viewport: { width: 1440, height: 1000 },
    readyText: 'GitHub Workflow Assistant',
  },
];

const themes: VisualTheme[] = ['light', 'dark'];

async function installDeterministicBrowserState(page: Page) {
  await page.addInitScript(
    ({ fixedNow }) => {
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(value?: string | number | Date) {
          super(
            value === undefined
              ? fixedNow
              : value instanceof NativeDate
                ? value.getTime()
                : value,
          );
        }

        static override now() {
          return fixedNow;
        }
      }

      Object.defineProperty(window, 'Date', {
        configurable: true,
        value: FixedDate,
      });
      window.localStorage.setItem('clodex-sidebar-collapsed', '0');
    },
    { fixedNow: FIXED_NOW },
  );
}

async function settleVisualFixture(page: Page, theme: VisualTheme) {
  await page.evaluate(async (visualTheme) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(visualTheme);
    document.documentElement.style.colorScheme = visualTheme;

    const style = document.createElement('style');
    style.dataset.visualRegression = 'true';
    style.textContent = `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `;
    document.head.append(style);

    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, theme);
}

for (const surface of surfaces) {
  for (const theme of themes) {
    test(`${surface.name} · ${theme}`, async ({ page }) => {
      const runtimeErrors: string[] = [];
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') runtimeErrors.push(message.text());
      });

      await page.setViewportSize(surface.viewport);
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await installDeterministicBrowserState(page);
      await page.goto(`/iframe.html?id=${surface.storyId}&viewMode=story`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(
        page.locator(`[data-visual-fixture="${surface.name}"]`),
      ).toBeVisible();
      await expect(page.getByText(surface.readyText).first()).toBeVisible();
      await settleVisualFixture(page, theme);
      await expect(runtimeErrors).toEqual([]);

      await expect(page).toHaveScreenshot(`${surface.name}-${theme}.png`, {
        fullPage: false,
      });
    });
  }
}

test('hosted pull request review interactions', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await installDeterministicBrowserState(page);
  await page.goto(
    '/iframe.html?id=visual-regression-codex-surfaces--hosted-pull-request&viewMode=story',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(
    page.locator('[data-visual-fixture="hosted-pull-request"]'),
  ).toBeVisible();
  await settleVisualFixture(page, 'light');

  const addInlineComment = page
    .getByRole('button', {
      name: /Add comment on .* line 1/,
    })
    .first();
  await addInlineComment.click({ force: true });
  await page
    .getByRole('textbox', { name: /Comment on .* line 1/ })
    .fill('Please keep this fixture covered by the visual test.');
  await page.getByRole('button', { name: 'Save comment' }).click();
  await expect(page.getByText('1 pending inline comment')).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Review summary' })
    .fill('The implementation is close, but this coverage should stay.');
  await page
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();

  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByText('Request changes?')).toBeVisible();
  await expect(
    confirmation.getByText(
      'This submits a changes-requested review on GitHub and includes the current summary and pending inline comments.',
    ),
  ).toBeVisible();
  await confirmation
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();

  await expect(page.getByText('Changes requested on GitHub.')).toBeVisible();
  await expect(page.getByText('No pending inline comments')).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Review summary' }),
  ).toHaveValue('');

  await page
    .getByRole('button', { name: 'Protected merge', exact: true })
    .click();
  const mergeDialog = page.getByRole('dialog');
  await expect(
    mergeDialog.getByRole('heading', { name: 'Protected merge' }),
  ).toBeVisible();
  await expect(
    mergeDialog.getByText('Required status checks', { exact: true }),
  ).toBeVisible();
  await expect(mergeDialog).toHaveScreenshot(
    'hosted-pull-request-merge-dialog-light.png',
  );
  await mergeDialog
    .getByRole('combobox', { name: 'Merge method' })
    .selectOption('rebase');
  await mergeDialog
    .getByRole('textbox', { name: 'Protected merge confirmation' })
    .fill('openai/clodex#418');
  await mergeDialog
    .getByRole('button', { name: 'Merge pull request', exact: true })
    .click();

  await expect(page.getByText('Pull request merged on GitHub.')).toBeVisible();
  await expect(page.getByText('f49c2de')).toBeVisible();
  await expect(runtimeErrors).toEqual([]);
});

test('generated app library interactions', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await installDeterministicBrowserState(page);
  await page.goto(
    '/iframe.html?id=visual-regression-codex-surfaces--generated-apps&viewMode=story',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(
    page.locator('[data-visual-fixture="generated-apps"]'),
  ).toBeVisible();
  await settleVisualFixture(page, 'light');

  const search = page.getByRole('textbox', { name: 'Search generated apps' });
  await search.fill('onboarding');
  await expect(page.getByText('Onboarding Map').first()).toBeVisible();
  await expect(page.getByText('Analytics Pulse')).toHaveCount(0);
  await search.fill('');

  await page
    .getByRole('button', { name: 'Analytics Pulse', exact: true })
    .click();
  await expect(page.getByText('Ownership boundary')).toBeVisible();
  await expect(page.getByText('Live preview')).toBeVisible();
  await page.getByRole('button', { name: 'Generated apps' }).click();

  await page.getByRole('button', { name: 'Delete Onboarding Map' }).click();
  const deleteDialog = page.getByRole('dialog');
  await expect(deleteDialog.getByText('Delete generated app?')).toBeVisible();
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click();

  const analyticsCard = page
    .getByRole('button', { name: 'Analytics Pulse', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"group/app")]');
  await analyticsCard.getByRole('button', { name: 'Regenerate' }).click();
  const regenerateDialog = page.getByRole('dialog');
  await expect(
    regenerateDialog.getByText('Regenerate this app?'),
  ).toBeVisible();
  await regenerateDialog
    .getByRole('button', { name: 'Regenerate', exact: true })
    .click();
  await expect(
    page.getByText(
      'Regeneration was sent to the owner task. Existing files stay available until replacements are ready.',
    ),
  ).toBeVisible();
  await expect(analyticsCard.getByText('Regenerating')).toBeVisible();
  await expect(runtimeErrors).toEqual([]);
});

test('plugin library interactions', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await installDeterministicBrowserState(page);
  await page.goto(
    '/iframe.html?id=visual-regression-codex-surfaces--plugin-library&viewMode=story',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(
    page.locator('[data-visual-fixture="plugin-library"]'),
  ).toBeVisible();
  await settleVisualFixture(page, 'light');

  const search = page.getByRole('searchbox', { name: 'Search plugins' });
  await search.fill('deployment');
  await expect(
    page.getByRole('button', { name: 'Deployment Pilot', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'GitHub Workflow Assistant',
      exact: true,
    }),
  ).toHaveCount(0);
  await search.fill('');

  await page
    .getByRole('combobox', { name: 'Plugin status' })
    .selectOption('incompatible');
  await expect(page.getByText('Requires Clodex 2.0.0 or newer.')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Plugin status' })
    .selectOption('all');

  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByText('Review CI failures')).toBeVisible();
  await page.getByText('Review CI failures').click();
  await expect(
    page.getByRole('heading', { name: 'Permissions' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Credentials', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/GitHub Personal Access Token/i)).toBeVisible();
  await expect(page).toHaveScreenshot('plugin-library-detail-light.png', {
    fullPage: false,
  });

  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(
    page.getByText(
      'Updated GitHub Workflow Assistant to the latest signed version.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const uninstallDialog = page.getByRole('dialog');
  await expect(
    uninstallDialog.getByText('Uninstall GitHub Workflow Assistant?'),
  ).toBeVisible();
  await expect(uninstallDialog).toHaveScreenshot(
    'plugin-library-uninstall-dialog-light.png',
  );
  await uninstallDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(runtimeErrors).toEqual([]);
});
