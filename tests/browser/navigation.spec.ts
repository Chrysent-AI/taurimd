import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import type { FileEntry, FileIndex } from '../../src/navigation/types';
import type { Snapshot } from '../../src/types';
import { palettes } from '../../src/settings/model';
const text =
  '---\nheading: "# Not an outline"\n---\n# Repeat\n### Interleaved\n## Repeat\n## Last section\n\n```md\n# Not a heading\n```\n\n![Not mounted in a preview](image.png)\n\n```mermaid\ngraph LR\n A-->B\n```';
const entries: FileEntry[] = [
  {
    id: 10,
    uiId: 10,
    parent: null,
    name: 'alpha.md',
    relative: 'alpha.md',
    kind: 'markdown',
    context: 10,
    alphaRank: 0,
    dateRank: 2,
  },
  {
    id: 20,
    uiId: 20,
    parent: null,
    name: 'beta.MKDOWN',
    relative: 'beta.MKDOWN',
    kind: 'markdown',
    context: 20,
    alphaRank: 1,
    dateRank: 0,
  },
  {
    id: 30,
    uiId: 30,
    parent: null,
    name: 'literal.log',
    relative: 'literal.log',
    kind: 'text',
    context: 30,
    alphaRank: 2,
    dateRank: 1,
  },
  {
    id: 40,
    uiId: 40,
    parent: null,
    name: 'nested',
    relative: 'nested',
    kind: 'directory',
    context: 40,
    alphaRank: 3,
    dateRank: 3,
  },
  {
    id: 50,
    uiId: 50,
    parent: 40,
    name: 'deep.md',
    relative: 'nested/deep.md',
    kind: 'markdown',
    context: 50,
    alphaRank: 4,
    dateRank: 4,
  },
];
const index = (revision = 1): FileIndex => ({
  scope: 7,
  revision,
  name: 'fixture/authorized folder',
  entries: structuredClone(entries),
  issues: [],
});
const snapshot = (
  name = 'alpha.md',
  contextId = 10,
  source = text,
  revision = 1,
): Snapshot => ({
  documentId: contextId,
  contextId,
  revision,
  name,
  location: `fixture/${name}`,
  format: 'markdown',
  source,
});
async function siblings(page: Page, active = 10, root = index()) {
  await page.evaluate(
    ({ active, root }) => {
      window.readerFixture.setSiblings({
        index: {
          ...root,
          entries: root.entries.filter(
            (e) => e.parent === null && e.kind !== 'directory',
          ),
        },
        active: active < 0 ? null : active,
        inRoot: active >= 0,
        rootActive: active < 0 ? null : active,
      });
    },
    { active, root },
  );
}
async function choose(page: Page, root = index()) {
  await page.evaluate((root) => {
    window.readerFixture.enqueue('select_root', {
      value: {
        status: 'ready',
        snapshot: window.readerFixture.indexSnapshot(root),
      },
    });
    return window.readerFixture.menu('open-folder');
  }, root);
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText(root.issues.length ? 'incomplete results' : 'Folder loaded.');
}
async function open(page: Page, doc = snapshot()) {
  await page.evaluate((doc) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: doc },
    });
    return window.readerFixture.menu('open');
  }, doc);
  await expect(page.getByRole('article', { name: doc.name })).toBeFocused();
}
async function preview(
  page: Page,
  name = 'beta.MKDOWN',
  context = 20,
  source = text,
) {
  await page.evaluate(
    ({ name, context, source }) => {
      window.readerFixture.enqueue('read_preview', {
        value: {
          documentId: 0,
          contextId: context,
          revision: 99,
          name,
          location: `fixture/${name}`,
          format: 'markdown',
          source,
        },
      });
    },
    { name, context, source },
  );
  await page
    .getByRole('button', { name: `Show headings for ${name}`, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: `Open ${name} at Repeat`, exact: true }),
  ).toHaveCount(2);
}
test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
  expect(await page.evaluate(() => window.readerFixture.activeWorkers())).toBe(
    0,
  );
});

test('recursive folder disclosure and lazy shared-worker headings open the exact duplicate destination', async ({
  page,
}, info) => {
  await choose(page);
  expect(await page.evaluate(() => window.readerFixture.workerParses())).toBe(
    0,
  );
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeHidden();
  await page
    .getByRole('button', { name: 'Expand folder nested', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show headings for literal.log' }),
  ).toHaveCount(0);
  await preview(page);
  expect(await page.evaluate(() => window.readerFixture.workerParses())).toBe(
    1,
  );
  expect(
    await page.evaluate(() => window.readerFixture.diagrams().renders.length),
  ).toBe(0);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).some(
      (c) => c.command === 'resolve_media' || c.command === 'commit_document',
    ),
  ).toBe(false);
  await siblings(page, 20);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
      window.readerFixture.enqueue('resolve_media', {
        error: { code: 'notFound', message: 'Image missing' },
      });
    },
    snapshot('beta.MKDOWN', 20),
  );
  await page
    .getByRole('button', { name: 'Open beta.MKDOWN at Repeat', exact: true })
    .nth(1)
    .press('Enter');
  const article = page.getByRole('article', { name: 'beta.MKDOWN' });
  await expect(
    article.getByRole('heading', { name: 'Repeat', exact: true }).nth(1),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Open beta.MKDOWN', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page
      .getByRole('navigation', { name: 'On this page' })
      .getByRole('link', { name: /Repeat/ }),
  ).toHaveCount(2);
  await expect(
    page.getByRole('navigation', { name: 'On this page' }),
  ).not.toContainText('Not a heading');
  const call = (await page.evaluate(() => window.readerFixture.calls())).find(
    (c) => c.command === 'open_index_entry',
  );
  expect(call?.payload).toEqual({
    requestId: 1,
    binding: { scope: 7, revision: 1, entry: 20 },
    newWindow: false,
  });
  expect(
    (await page.evaluate(() => window.readerFixture.navigationCalls())).filter(
      (call) => call.command === 'read_preview',
    ),
  ).toHaveLength(1);
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).not.toContainText('Could not read headings');
  await expect(article.locator('.diagram svg')).toHaveCount(1);
  await expect(
    article.getByRole('heading', { name: 'Repeat', exact: true }).nth(1),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath('nested-exact-heading.png') });
});

test('same-current-source jumps without a read; changed preview bytes open fresh content without guessing an ordinal', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  const source = '# Repeat\n### Between\n## Repeat';
  await open(page, snapshot('alpha.md', 10, source));
  await preview(page, 'alpha.md', 10, source);
  const before = await page.evaluate(() => window.readerFixture.calls().length);
  await page
    .getByRole('button', { name: 'Open alpha.md at Repeat', exact: true })
    .nth(1)
    .click();
  await expect(
    page
      .getByRole('article')
      .getByRole('heading', { name: 'Repeat', exact: true })
      .nth(1),
  ).toBeFocused();
  expect(await page.evaluate(() => window.readerFixture.calls().length)).toBe(
    before,
  );
  await preview(page, 'beta.MKDOWN', 20, source);
  const fresh = source.replace('## Repeat', '## Other!');
  expect(fresh.length).toBe(source.length);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('beta.MKDOWN', 20, fresh, 2),
  );
  await siblings(page, 20);
  await page
    .getByRole('button', { name: 'Open beta.MKDOWN at Repeat', exact: true })
    .nth(1)
    .click();
  await expect(page.getByRole('article')).toContainText('Other!');
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('File changed; choose a heading again.');
  await expect(
    page
      .getByRole('region', { name: 'Reader status', exact: true })
      .getByText('File changed; choose a heading again.', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'Other!' }),
  ).not.toBeFocused();
  const outline = page.getByRole('navigation', { name: 'On this page' });
  await outline.getByRole('link', { name: /Other!/ }).click();
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'Other!' }),
  ).toBeFocused();
  await page
    .getByRole('article')
    .getByRole('heading', { name: 'Other!' })
    .evaluate((node) => {
      node.remove();
    });
  await outline.getByRole('link', { name: /Other!/ }).click();
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('This section is no longer present.');
});

test('retains established disclosure nodes, cancels only hidden preview work, and refresh removal restores nearest folder focus', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  await open(page, snapshot('alpha.md', 10, '# Article'));
  await page
    .getByRole('button', { name: 'Expand folder nested', exact: true })
    .click();
  await preview(page, 'nested/deep.md', 50);
  const retained = await page
    .getByRole('button', { name: 'Open nested/deep.md at Repeat', exact: true })
    .nth(1)
    .evaluateHandle((node) => node);
  await page
    .getByRole('button', { name: 'Open nested/deep.md at Repeat', exact: true })
    .nth(1)
    .focus();
  await page
    .getByRole('button', { name: 'Collapse folder nested', exact: true })
    .evaluate((node: HTMLButtonElement) => {
      node.click();
    });
  await expect(
    page.getByRole('button', { name: 'Expand folder nested', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Expand folder nested', exact: true })
    .click();
  expect(
    await retained.evaluate(
      (node) =>
        node ===
        document.querySelectorAll(
          '[aria-label="Open nested/deep.md at Repeat"]',
        )[1],
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Open nested/deep.md at Repeat', exact: true })
    .nth(1)
    .focus();
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await expect(page.getByRole('article')).toBeFocused();
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await expect(
    page.getByRole('button', {
      name: 'Hide headings for nested/deep.md',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
  await page
    .getByRole('button', { name: 'Open nested/deep.md at Repeat', exact: true })
    .nth(1)
    .focus();
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await page
    .getByRole('dialog')
    .getByLabel('Show sidebar by default')
    .uncheck();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.getByRole('article')).toBeFocused();
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await page.evaluate(() => {
    window.readerFixture.workerMode('hold');
    window.readerFixture.enqueue('read_preview', {
      value: {
        documentId: 0,
        contextId: 20,
        revision: 1,
        name: 'beta.MKDOWN',
        location: 'fixture/beta.MKDOWN',
        format: 'markdown',
        source: '# Pending',
      },
    });
  });
  await page
    .getByRole('button', { name: 'Show headings for beta.MKDOWN', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(1);
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(0);
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await page
    .getByRole('button', { name: 'Open nested/deep.md', exact: true })
    .focus();
  const refreshed = index(2);
  refreshed.entries = refreshed.entries
    .filter((e) => e.id !== 50)
    .map((e) => ({
      ...e,
      id: e.id + 100,
      parent: e.parent === null ? null : e.parent + 100,
    }));
  await siblings(page, 110, refreshed);
  await page.evaluate((root) => {
    window.readerFixture.enqueue('refresh_index', {
      value: window.readerFixture.indexSnapshot(root),
    });
    return window.readerFixture.menu('refresh-folder');
  }, refreshed);
  await expect(
    page.getByRole('button', { name: 'Collapse folder nested', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toHaveCount(0);
  await retained.dispose();
});

test('native-ranked immediate siblings stop at endpoints and retain persistent control focus; outside and failed targets stay truthful', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  await open(page, snapshot('alpha.md', 10, '# Alpha'));
  const previous = page.getByRole('button', {
    name: 'Previous File',
    exact: true,
  });
  const next = page.getByRole('button', { name: 'Next File', exact: true });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await siblings(page, 20);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('beta.MKDOWN', 20, '# Beta', 2),
  );
  await next.click();
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    'beta.MKDOWN',
  );
  await expect(next).toBeFocused();
  const literal = {
    ...snapshot('literal.log', 30, '# Literal', 3),
    format: 'text' as const,
  };
  await siblings(page, 30);
  await page.evaluate((doc) => {
    window.readerFixture.enqueue('open_index_entry', { value: doc });
  }, literal);
  await next.press('Enter');
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await expect(
    page.getByRole('navigation', { name: 'On this page' }),
  ).toContainText('Outline unavailable for plain text');
  await page.getByLabel('Sibling order', { exact: true }).selectOption('date');
  await expect(next).toBeEnabled();
  await siblings(page, 10);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('alpha.md', 10, '# Alpha', 4),
  );
  await next.click();
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await siblings(page, -1);
  await open(page, snapshot('outside.md', 99, '# Outside', 5));
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('outside this folder');
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await page.evaluate(() => {
    window.readerFixture.enqueue('reveal_document', {
      error: { code: 'notFound', message: 'File no longer exists' },
    });
    return window.readerFixture.menu('reveal');
  });
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('File no longer exists');
  expect(await page.evaluate(() => window.readerFixture.state().stale)).toBe(
    false,
  );
  await page.evaluate(() => {
    window.readerFixture.enqueue('open_index_entry', {
      error: {
        code: 'denied',
        message: 'Target denied',
        attempted: 'alpha.md',
      },
    });
  });
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('alpha.md');
  await expect(page.getByRole('article', { name: 'outside.md' })).toContainText(
    'Outside',
  );
  expect(await page.evaluate(() => window.readerFixture.state().stale)).toBe(
    true,
  );
});

test('folder cancel, empty, partial and denied refresh remain distinct and do not replace last-good reading or grants', async ({
  page,
}) => {
  await choose(page);
  await open(page, snapshot('alpha.md', 10, '# Kept'));
  const article = await page.getByRole('article').elementHandle();
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_root', {
      value: { status: 'cancelled' },
    });
    return window.readerFixture.menu('open-folder');
  });
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('folder unchanged');
  const empty = {
    ...index(),
    scope: 8,
    name: 'fixture/empty',
    entries: entries.filter((entry) => entry.kind === 'directory'),
  };
  await choose(page, empty);
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('No supported files.');
  const partial = {
    ...index(),
    scope: 9,
    issues: [
      { relative: 'denied', code: 'denied', message: 'Subfolder denied' },
    ],
  };
  await choose(page, partial);
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('Subfolder denied');
  await page.evaluate(() => {
    window.readerFixture.enqueue('refresh_index', {
      error: { code: 'denied', message: 'Folder access denied' },
    });
    return window.readerFixture.menu('refresh-folder');
  });
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('last known');
  expect(await page.evaluate(() => window.readerFixture.state().stale)).toBe(
    false,
  );
  expect(
    await article?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await article?.dispose();
});

test('manual failed reload invalidates requested previews even when native source bytes are unchanged', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  await open(page, snapshot('alpha.md', 10, '# Kept'));
  await preview(page, 'beta.MKDOWN', 20, '# Repeat\n## Repeat');
  const count = await page.evaluate(() => window.readerFixture.workerParses());
  await page.evaluate(() => {
    window.readerFixture.enqueue('reload_document', {
      error: { code: 'notFound', message: 'Reload missing' },
    });
    window.readerFixture.enqueue('read_preview', {
      value: {
        documentId: 0,
        contextId: 20,
        revision: 100,
        name: 'beta.MKDOWN',
        location: 'fixture/beta.MKDOWN',
        format: 'markdown',
        source: '# Repeat\n## Repeat',
      },
    });
    return window.readerFixture.menu('reload');
  });
  await expect(page.getByRole('alert')).toContainText('Reload failed');
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.workerParses()))
    .toBe(count + 1);
  await expect(
    page.getByRole('button', {
      name: 'Open beta.MKDOWN at Repeat',
      exact: true,
    }),
  ).toHaveCount(2);
});

test('all navigation entry points reject composition, pending document commit and logical native Save ownership without queuing', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  await open(
    page,
    snapshot('alpha.md', 10, '# Export\n\n```mermaid\ngraph LR\n A-->B\n```'),
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', {
      hold: 'navigation-native-save',
    });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('navigation-native-save');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before = await page.evaluate(() => window.readerFixture.calls().length);
  await page.evaluate(async () => {
    for (const action of [
      'open-folder',
      'refresh-folder',
      'reveal',
      'previous',
      'next',
      'sidebar',
      'reload',
      'open',
    ] as const)
      await window.readerFixture.menu(action);
  });
  await expect(
    page.getByRole('button', { name: 'Open beta.MKDOWN', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {
      name: 'Show headings for beta.MKDOWN',
      exact: true,
    }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.readerFixture.calls().length)).toBe(
    before,
  );
  await page.evaluate(() => {
    window.readerFixture.release('navigation-native-save', {
      value: { status: 'cancelled' },
    });
  });
  await expect(
    page.getByText('Export cancelled.', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.readerFixture.calls().length)).toBe(
    before,
  );
  await page.locator('.shell').dispatchEvent('compositionstart');
  await page.evaluate(() => window.readerFixture.menu('open-folder'));
  expect(await page.evaluate(() => window.readerFixture.calls().length)).toBe(
    before,
  );
  await page.locator('.shell').dispatchEvent('compositionend');
  await page.evaluate(() => {
    window.readerFixture.enqueue('open_index_entry', {
      value: {
        documentId: 20,
        contextId: 20,
        revision: 2,
        name: 'beta.MKDOWN',
        location: 'fixture/beta.MKDOWN',
        source: '# Pending',
        format: 'markdown',
      },
    });
    window.readerFixture.enqueue('commit_document', {
      hold: 'navigation-commit',
    });
  });
  await page
    .getByRole('button', { name: 'Open beta.MKDOWN', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('navigation-commit');
  const committing = await page.evaluate(
    () => window.readerFixture.calls().length,
  );
  await page.evaluate(async () => {
    await window.readerFixture.menu('open-folder');
    await window.readerFixture.menu('reveal');
  });
  expect(await page.evaluate(() => window.readerFixture.calls().length)).toBe(
    committing,
  );
  await page.evaluate(() => {
    window.readerFixture.release('navigation-commit', { value: null });
  });
  await expect(
    page.getByRole('article', { name: 'beta.MKDOWN' }),
  ).toBeVisible();
});

for (const [palette] of palettes) {
  test(`navigation geometry keeps controls independent of 50–300% reading zoom in both ${palette} palette slots`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 640, height: 720 });
    const root = index();
    root.entries[0].name = 'long-filename-that-wraps-without-a-layout-quota.md';
    root.entries[0].relative = root.entries[0].name;
    await choose(page, root);
    await siblings(page, 10, root);
    await open(
      page,
      snapshot(
        root.entries[0].name,
        10,
        `# Document\n\n${'Readable words. '.repeat(500)}\n\n## Final heading`,
      ),
    );
    await page.evaluate(() => window.readerFixture.menu('status-bar'));
    const article = await page.getByRole('article').elementHandle();
    const geometry: unknown[] = [];
    for (const mode of ['light', 'dark'] as const)
      for (const zoom of [50, 100, 300]) {
        await page.evaluate(
          ({ mode, palette, zoom }) => {
            const record = window.readerFixture.settings();
            return window.readerFixture.settingsEvent({
              ...record,
              revision: record.revision + 1,
              settings: {
                ...record.settings,
                mode,
                lightPalette: palette,
                darkPalette: palette,
                pageZoom: zoom,
              },
            });
          },
          { mode, palette, zoom },
        );
        await expect(page.locator('html')).toHaveAttribute(
          'data-palette',
          palette,
        );
        await expect(page.getByRole('article')).toHaveAttribute(
          'data-zoom',
          String(zoom),
        );
        const value = await page.evaluate(() => {
          const sidebar = document.querySelector('.navigation');
          if (!sidebar) throw new Error('Missing sidebar geometry');
          return {
            viewport: innerWidth,
            shell: document.documentElement.scrollWidth,
            sidebar: document
              .querySelector('.navigation')
              ?.getBoundingClientRect().width,
            font: getComputedStyle(sidebar).fontSize,
            main: document.querySelector('main')?.getBoundingClientRect().width,
          };
        });
        expect(value.shell).toBeLessThanOrEqual(value.viewport + 1);
        expect(value.sidebar).toBeGreaterThan(0);
        expect(value.main).toBeGreaterThan(0);
        expect(Number.parseFloat(value.font)).toBeLessThan(20);
        geometry.push({ mode, palette, zoom, ...value });
        expect(
          await article?.evaluate(
            (node) => node === document.querySelector('article'),
          ),
        ).toBe(true);
      }
    expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
    await page.screenshot({ path: info.outputPath('navigation-geometry.png') });
    writeFileSync(
      info.outputPath('geometry.json'),
      JSON.stringify(
        {
          engine: info.project.name,
          boundary: 'Browser native transport double; not native qualification',
          geometry,
        },
        null,
        2,
      ),
    );
    await article?.dispose();
  });
}

for (const code of ['denied', 'notFound'] as const) {
  test(`repair persistent ${code} root outcome survives chooser cancellation/error and reveal/jump feedback`, async ({
    page,
  }, info) => {
    await open(page, snapshot('outside.md', 99, '# Kept reader\n## Target'));
    const article = await page.getByRole('article').elementHandle();
    const root = { ...index(), entries: [] };
    await page.evaluate(
      ({ root, code }) => {
        window.readerFixture.enqueue('select_root', {
          value: {
            status: 'ready',
            snapshot: window.readerFixture.indexSnapshot(
              root,
              'unavailable',
              `${code} root access`,
            ),
          },
        });
        return window.readerFixture.menu('open-folder');
      },
      { root, code },
    );
    const files = page.getByRole('navigation', { name: 'Files', exact: true });
    const unavailable = async () => {
      await expect(files).toContainText(
        `Folder unavailable (${code} root access)`,
      );
      await expect(files).toContainText('Retained entries are last known');
      await expect(files).not.toContainText('No supported files.');
      await expect(files).not.toContainText('Displayed file is outside');
      expect(
        await page.evaluate(() => window.readerFixture.state().stale),
      ).toBe(false);
      expect(
        await article?.evaluate(
          (node) => node === document.querySelector('article'),
        ),
      ).toBe(true);
    };
    await unavailable();
    await page.evaluate(() => {
      window.readerFixture.enqueue('select_root', {
        value: { status: 'cancelled' },
      });
      return window.readerFixture.menu('open-folder');
    });
    await expect(files).toContainText('Folder selection cancelled');
    await unavailable();
    await page.evaluate(() => {
      window.readerFixture.enqueue('select_root', {
        error: { code: 'io', message: 'Chooser failed' },
      });
      return window.readerFixture.menu('open-folder');
    });
    await expect(files).toContainText('Could not choose folder');
    await unavailable();
    await page.evaluate(() => window.readerFixture.menu('reveal'));
    await expect(files).toContainText('Sent outside.md to the file manager');
    await unavailable();
    await page.evaluate(() => {
      window.readerFixture.enqueue('reveal_document', {
        error: { code: 'io', message: 'Reveal failed' },
      });
      return window.readerFixture.menu('reveal');
    });
    await expect(files).toContainText('Could not reveal');
    await unavailable();
    await page
      .getByRole('article')
      .getByRole('heading', { name: 'Target', exact: true })
      .evaluate((node) => {
        node.remove();
      });
    await page
      .getByRole('navigation', { name: 'On this page' })
      .getByRole('link', { name: /Target/ })
      .click();
    await expect(files).toContainText('This section is no longer present');
    await unavailable();
    await page.screenshot({
      path: info.outputPath('unavailable-after-feedback.png'),
    });
    await page.evaluate(() => window.readerFixture.menu('sidebar'));
    await expect(page.getByLabel('Reader recovery')).toContainText(
      `Folder unavailable (${code} root access)`,
    );
    await expect(page.getByLabel('Folder status')).toBeEmpty();
    await page.evaluate(() => window.readerFixture.menu('sidebar'));
    await page.evaluate(
      (root) => {
        window.readerFixture.enqueue('refresh_index', {
          value: window.readerFixture.indexSnapshot(root),
        });
        return window.readerFixture.menu('refresh-folder');
      },
      { ...root, revision: 2 },
    );
    await expect(files).toContainText('No supported files.');
    await expect(files).not.toContainText('Folder unavailable');
    const partial = {
      ...index(3),
      issues: [
        {
          relative: 'sub',
          code: 'denied',
          message: 'Partial subfolder access',
        },
      ],
    };
    await page.evaluate((root) => {
      window.readerFixture.enqueue('refresh_index', {
        value: window.readerFixture.indexSnapshot(root),
      });
      return window.readerFixture.menu('refresh-folder');
    }, partial);
    await expect(files).toContainText('incomplete results');
    await page.evaluate(() => window.readerFixture.menu('reveal'));
    await expect(files).toContainText('Sent outside.md');
    await expect(files).toContainText('incomplete results');
    await expect(files).toContainText('Partial subfolder access');
    await expect(files).not.toContainText('No supported files.');
    await page.screenshot({
      path: info.outputPath('partial-after-feedback.png'),
    });
    expect(
      await article?.evaluate(
        (node) => node === document.querySelector('article'),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
    await article?.dispose();
  });
}

for (const terminal of ['success', 'error', 'cancel'] as const) {
  test(`repair root completion defers parent sibling reprojection until ${terminal} of its enrolled transaction`, async ({
    page,
  }) => {
    await choose(page);
    const parent = {
      ...index(),
      scope: 90,
      entries: entries
        .filter((entry) => entry.kind !== 'directory' && entry.parent === null)
        .map((entry) => ({
          ...entry,
          id: entry.id + 1000,
          uiId: entry.uiId + 1000,
          context: entry.context + 1000,
          name: `outside-${entry.name}`,
          relative: `outside-${entry.relative}`,
        })),
    };
    await page.evaluate((parent) => {
      window.readerFixture.setSiblings({
        index: parent,
        active: 1010,
        rootActive: null,
        inRoot: false,
      });
    }, parent);
    await open(page, snapshot('outside-alpha.md', 1010, '# Outside alpha'));
    const next = page.getByRole('button', { name: 'Next File', exact: true });
    await expect(next).toBeEnabled();
    await page.evaluate(() => {
      window.readerFixture.enqueue('refresh_index', { hold: 'overlap-root' });
      return window.readerFixture.menu('refresh-folder');
    });
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.pending()))
      .toContain('overlap-root');
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.presentation()))
      .toMatchObject({ hasRoot: false, busy: false });
    await expect(next).toBeEnabled();
    const parentGets = await page.evaluate(
      () =>
        window.readerFixture
          .navigationCalls()
          .filter((call) => call.command === 'get_siblings').length,
    );
    await page.evaluate(() => {
      window.readerFixture.enqueue('open_index_entry', {
        hold: 'overlap-entry',
      });
    });
    await next.click();
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.pending()))
      .toContain('overlap-entry');
    await page.evaluate((root) => {
      window.readerFixture.release('overlap-root', {
        value: window.readerFixture.indexSnapshot(root),
      });
    }, index(2));
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.presentation()))
      .toMatchObject({ hasRoot: true, busy: true });
    expect(
      await page.evaluate(
        () =>
          window.readerFixture
            .navigationCalls()
            .filter((call) => call.command === 'get_siblings').length,
      ),
    ).toBe(parentGets);
    if (terminal === 'success') {
      await page.evaluate(
        ({ parent, doc }) => {
          window.readerFixture.setSiblings({
            index: { ...parent, revision: 2 },
            active: 1020,
            rootActive: null,
            inRoot: false,
          });
          window.readerFixture.enqueue('commit_document', {
            hold: 'overlap-commit',
          });
          window.readerFixture.release('overlap-entry', { value: doc });
        },
        {
          parent,
          doc: snapshot('outside-beta.MKDOWN', 1020, '# Outside beta', 2),
        },
      );
      await expect
        .poll(() => page.evaluate(() => window.readerFixture.pending()))
        .toContain('overlap-commit');
      expect(
        await page.evaluate(() => window.readerFixture.state().phase),
      ).toBe('committing');
      expect(
        await page.evaluate(
          () =>
            window.readerFixture
              .navigationCalls()
              .filter((call) => call.command === 'get_siblings').length,
        ),
      ).toBe(parentGets);
      await page.evaluate(() => {
        window.readerFixture.release('overlap-commit', { value: null });
      });
      await expect(
        page.getByRole('article', { name: 'outside-beta.MKDOWN' }),
      ).toBeVisible();
    } else if (terminal === 'error') {
      await page.evaluate(() => {
        window.readerFixture.release('overlap-entry', {
          error: { code: 'denied', message: 'Deliberate entry failure' },
        });
      });
      await expect(page.getByRole('alert')).toContainText(
        'Deliberate entry failure',
      );
    } else {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => {
        window.readerFixture.release('overlap-entry', {
          error: { code: 'stale', message: 'Cancelled native read' },
        });
      });
      await expect(page.getByRole('status')).toContainText(
        'Operation cancelled',
      );
    }
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.presentation()))
      .toMatchObject({ hasRoot: true, busy: false });
    await expect(next).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          window.readerFixture
            .navigationCalls()
            .filter((call) => call.command === 'get_siblings').length,
      ),
    ).toBe(parentGets + 1);
    expect(
      await page.evaluate(
        () =>
          window.readerFixture
            .calls()
            .filter((call) => call.command === 'open_index_entry').length,
      ),
    ).toBe(1);
    expect(await page.evaluate(() => window.readerFixture.state().stale)).toBe(
      terminal === 'error',
    );
    await expect(
      page.getByRole('navigation', { name: 'Files', exact: true }),
    ).toContainText('outside this folder');
    await expect(page.getByRole('article')).toHaveAttribute(
      'aria-label',
      terminal === 'success' ? 'outside-beta.MKDOWN' : 'outside-alpha.md',
    );
  });
}

test('repair reload consumes its own reading origin instead of prior filename or sibling anchors', async ({
  page,
}) => {
  await choose(page);
  await siblings(page);
  const first = snapshot('alpha.md', 10, '# Alpha\n## Reading position');
  await page.evaluate((doc) => {
    window.readerFixture.enqueue('open_index_entry', { value: doc });
  }, first);
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .click();
  await expect(page.getByRole('article')).toBeFocused();
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: /Reading position/ })
    .click();
  await expect(
    page
      .getByRole('article')
      .getByRole('heading', { name: 'Reading position' }),
  ).toBeFocused();
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('reload_document', { value: doc });
      return window.readerFixture.menu('reload');
    },
    { ...first, revision: 2 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { phase, displayed } = window.readerFixture.state();
        return {
          phase,
          documentId: displayed?.snapshot.documentId,
          revision: displayed?.snapshot.revision,
        };
      }),
    )
    .toEqual({ phase: 'ready', documentId: 10, revision: 2 });
  await expect(page.getByRole('article')).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Open alpha.md', exact: true }),
  ).not.toBeFocused();
  const next = page.getByRole('button', { name: 'Next File', exact: true });
  await expect(next).toBeEnabled();
  const second = snapshot('beta.MKDOWN', 20, '# Beta\n## Current reading', 3);
  await siblings(page, 20);
  await page.evaluate((doc) => {
    window.readerFixture.enqueue('open_index_entry', { value: doc });
  }, second);
  await next.click();
  await expect(next).toBeFocused();
  await page.getByRole('article').focus();
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('reload_document', { value: doc });
      return window.readerFixture.menu('reload');
    },
    { ...second, revision: 4 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { phase, displayed } = window.readerFixture.state();
        return {
          phase,
          documentId: displayed?.snapshot.documentId,
          revision: displayed?.snapshot.revision,
        };
      }),
    )
    .toEqual({ phase: 'ready', documentId: 20, revision: 4 });
  await expect(page.getByRole('article')).toBeFocused();
  await expect(next).not.toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .calls()
          .filter((call) => call.command === 'open_index_entry').length,
    ),
  ).toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .calls()
          .filter((call) => call.command === 'reload_document').length,
    ),
  ).toBe(2);
});

for (const direction of ['previous', 'next'] as const)
  for (const origin of ['button', 'reading'] as const) {
    test(`repair menu ${direction} endpoint restores its request-owned ${origin} origin without an extra activation`, async ({
      page,
    }, info) => {
      await choose(page);
      await siblings(page, 20);
      await open(
        page,
        snapshot(
          'beta.MKDOWN',
          20,
          '# Middle\n\n' + 'Reading context. '.repeat(80),
        ),
      );
      const invoking = page.getByRole('button', {
        name: direction === 'next' ? 'Next File' : 'Previous File',
        exact: true,
      });
      if (origin === 'button') await invoking.focus();
      else await page.getByRole('article').focus();
      const id = direction === 'next' ? 30 : 10;
      const doc = {
        ...snapshot(
          direction === 'next' ? 'literal.log' : 'alpha.md',
          id,
          'Endpoint reading',
          2,
        ),
        format:
          direction === 'next' ? ('text' as const) : ('markdown' as const),
      };
      await siblings(page, id);
      await page.evaluate(
        ({ direction, doc }) => {
          window.readerFixture.enqueue('open_index_entry', { value: doc });
          return window.readerFixture.menu(direction);
        },
        { direction, doc },
      );
      await expect(page.getByRole('article', { name: doc.name })).toBeVisible();
      const remaining = page.getByRole('button', {
        name: direction === 'next' ? 'Previous File' : 'Next File',
        exact: true,
      });
      await expect(invoking).toBeDisabled();
      await expect(remaining).toBeEnabled();
      if (origin === 'button') await expect(remaining).toBeFocused();
      else await expect(page.getByRole('article')).toBeFocused();
      expect(
        await page.evaluate(
          () =>
            window.readerFixture
              .calls()
              .filter((call) => call.command === 'open_index_entry').length,
        ),
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            window.readerFixture
              .calls()
              .filter((call) => call.command === 'commit_document').length,
        ),
      ).toBe(2);
      await page.screenshot({
        path: info.outputPath('menu-endpoint-focus.png'),
      });
    });
  }
