import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import type { FileEntry, FileIndex } from '../../src/navigation/types';
import type { Snapshot } from '../../src/types';
import { palettes } from '../../src/settings/model';
const text =
  '---\nheading: "# Not an outline"\n---\n# Repeat\n### Interleaved\n## Repeat\n## Last section\n\n```md\n# Not a heading\n```\n\n![Not mounted in a preview](image.png)\n\n```mermaid\ngraph LR\n A-->B\n```';
const entries: FileEntry[] = [
  // The native ranks are ascending buckets: a higher dateRank is a later
  // timestamp and a higher sizeRank is a larger file. Equal values share a
  // bucket, and a missing value has no rank at all.
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
    sizeRank: 0,
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
    sizeRank: 2,
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
    sizeRank: 1,
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
    sizeRank: null,
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
    sizeRank: 3,
  },
];
const index = (revision = 1): FileIndex => ({
  scope: 7,
  revision,
  name: 'fixture/authorized folder',
  entries: structuredClone(entries),
  issues: [],
});
// 8,000 root folders each holding one hidden child: the shape the freeze
// investigation measured (every directory invoking a whole-index filter,
// every hidden descendant fully mounted). Mount renders at this scale are
// safe across engines.
const bigIndex = (folders = 8000): FileIndex => {
  const pad = (value: number) => String(value).padStart(4, '0');
  const built: FileEntry[] = [];
  for (let current = 0; current < folders; current += 1) {
    built.push({
      id: current + 1,
      uiId: current + 1,
      parent: null,
      name: `dir-${pad(current)}`,
      relative: `dir-${pad(current)}`,
      kind: 'directory',
      context: current + 1,
      alphaRank: current,
      dateRank: null,
      sizeRank: null,
    });
    built.push({
      id: folders + current + 1,
      uiId: folders + current + 1,
      parent: current + 1,
      name: `note-${pad(current)}.log`,
      relative: `dir-${pad(current)}/note-${pad(current)}.log`,
      kind: 'text',
      context: folders + current + 1,
      alphaRank: current,
      dateRank: null,
      sizeRank: null,
    });
  }
  return {
    scope: 77,
    revision: 1,
    name: 'fixture/large folder',
    entries: built,
    issues: [],
  };
};
const snapshot = (
  name = 'alpha.md',
  contextId = 10,
  source = text,
  revision = 1,
  documentId = contextId,
): Snapshot => ({
  documentId,
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
const keptText: Snapshot = {
  ...snapshot('kept.log', 900, 'kept'),
  format: 'text',
};
async function openRoot(page: Page, doc: Snapshot, root: FileIndex | null) {
  await page.evaluate(
    ({ doc, root }) => {
      window.readerFixture.workingFolder(root);
      window.readerFixture.enqueue('select_document', {
        value: { status: 'ready', snapshot: doc },
      });
      return window.readerFixture.menu('open');
    },
    { doc, root },
  );
  await expect(page.getByRole('article', { name: doc.name })).toBeFocused();
  if (root) {
    await expect(
      page.getByRole('navigation', { name: 'Files', exact: true }),
    ).toContainText(
      root.issues.length ? 'incomplete results' : 'Folder loaded.',
    );
  }
}
// Opening a file establishes the working folder. A plain-text fixture keeps
// the parse count at zero, matching the old chooser-based establishment.
async function choose(page: Page, root = index()) {
  await openRoot(page, keptText, root);
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
  const show = page.getByRole('button', {
    name: `Show headings for ${name}`,
    exact: true,
  });
  const retry = page.getByRole('button', {
    name: 'Retry headings',
    exact: true,
  });
  const headings = page.getByRole('button', {
    name: `Open ${name} at Repeat`,
    exact: true,
  });
  // A disclosed group may already be expanded or may have failed its preview.
  await expect
    .poll(async () => {
      if (await headings.count()) return 'ready';
      if (await show.count()) return 'collapsed';
      if (await retry.count()) return 'failed';
      return 'pending';
    })
    .not.toBe('pending');
  if (await show.count()) await show.click();
  else if (await retry.count()) await retry.click();
  await expect(headings).toHaveCount(2);
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
  // The working folder arrives with its plain-text fixture document; tree
  // exploration adds no reading content of its own.
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'kept.log' })).toBeVisible();
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
  const explorations = (
    await page.evaluate(() => window.readerFixture.calls())
  ).filter(
    (c) => c.command === 'resolve_media' || c.command === 'open_index_entry',
  );
  expect(explorations).toHaveLength(0);
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
  // Computed-style pin: the active row's tint and accent bar must survive
  // the de-boxed row cascade (a specificity regression turns both
  // transparent), at rest and while hovered. The probe resolves --link in
  // the live palette so the comparison stays palette-independent.
  const activeRow = page.getByRole('button', {
    name: 'Open beta.MKDOWN',
    exact: true,
  });
  const activeStyle = () =>
    activeRow.evaluate((node) => {
      const probe = document.createElement('div');
      probe.style.borderInlineStart = '3px solid var(--link)';
      document.body.append(probe);
      const link = getComputedStyle(probe).borderInlineStartColor;
      probe.remove();
      const computed = getComputedStyle(node);
      return {
        background: computed.backgroundColor,
        bar: computed.borderInlineStartColor,
        link,
      };
    });
  const transparent = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
  const resting = await activeStyle();
  expect(transparent.has(resting.background)).toBe(false);
  expect(resting.bar).toBe(resting.link);
  await activeRow.hover();
  const hovered = await activeStyle();
  expect(transparent.has(hovered.background)).toBe(false);
  expect(hovered.bar).toBe(hovered.link);
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
  // Request 1 opened the working-folder fixture document; the tree read
  // follows it.
  expect(call?.payload).toEqual({
    requestId: 2,
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
    .getByLabel('Show File Explorer by default')
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
  await page.evaluate(() => window.readerFixture.menu('sort-modified'));
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

test('empty, partial and denied refresh stay distinct from each other and do not replace last-good reading or grants', async ({
  page,
}) => {
  await choose(page);
  await open(page, snapshot('alpha.md', 10, '# Kept'));
  const article = await page.getByRole('article').elementHandle();
  // Opening from another folder replaces the working folder without a
  // separate chooser step.
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
    await article.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await article.dispose();
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
      'toc',
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
  await page.evaluate(() => window.readerFixture.menu('toc'));
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
    await window.readerFixture.menu('toc');
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

test('a large collapsed tree mounts no hidden descendants and an opened folder restores in place', async ({
  page,
}) => {
  await choose(page);
  const big = bigIndex();
  await page.evaluate((root) => {
    window.readerFixture.workingFolder(root);
    return window.readerFixture.indexEvent(
      window.readerFixture.indexSnapshot(root),
    );
  }, big);
  const files = page.getByRole('navigation', { name: 'Files', exact: true });
  await expect(files).toContainText('Folder loaded.');
  // Direct DOM counting: only the 8,000 root folder rows exist, and the
  // 8,000 hidden children of collapsed folders are not in the DOM at all.
  const shape = () =>
    page.evaluate(() => ({
      rows: document.querySelectorAll('nav[aria-label="Files"] li').length,
      nested: document.querySelectorAll('nav[aria-label="Files"] ul ul').length,
      childVisible: (() => {
        const button = document.querySelector(
          'button[aria-label="Open dir-0000/note-0000.log"]',
        );
        return button ? !button.closest('[hidden]') : null;
      })(),
    }));
  expect(await shape()).toEqual({ rows: 8000, nested: 0, childVisible: null });
  await page.evaluate(() => {
    const button = document.querySelector(
      'button[aria-label="Expand folder dir-0000"]',
    );
    if (!button) throw new Error('Missing folder toggle');
    (button as HTMLButtonElement).click();
  });
  expect(await shape()).toEqual({ rows: 8001, nested: 1, childVisible: true });
  await page.evaluate(() => {
    const button = document.querySelector(
      'button[aria-label="Collapse folder dir-0000"]',
    );
    if (!button) throw new Error('Missing folder toggle');
    (button as HTMLButtonElement).click();
  });
  // The opened folder's rows stay established while hidden, so re-expanding
  // restores them in place instead of remounting the subtree.
  expect(await shape()).toEqual({ rows: 8001, nested: 1, childVisible: false });
});

test('count-only scan progress announcements skip the retained tree render', async ({
  page,
}) => {
  await choose(page);
  // A 4,000-entry tree keeps even a full re-render cheap enough for the
  // development React build the suite runs against; release-mode costs for
  // this scenario were measured by the freeze investigation (four loading
  // announcements over a 16,000-entry retained tree consumed 3.1–3.7 s).
  const big = bigIndex(2000);
  await page.evaluate((root) => {
    window.readerFixture.workingFolder(root);
    return window.readerFixture.indexEvent(
      window.readerFixture.indexSnapshot(root),
    );
  }, big);
  const files = page.getByRole('navigation', { name: 'Files', exact: true });
  await expect(files).toContainText('Folder loaded.');
  // React's development component tracks record one measure per row
  // render. Counting them across count-only announcements pins the
  // mechanism directly: no retained-tree render may happen while only the
  // admitted-entry count moves.
  const rowRenders = () =>
    page.evaluate(() => {
      let rows = 0;
      for (const entry of performance.getEntriesByType('measure'))
        if (entry.name.includes('Row')) rows += 1;
      return rows;
    });
  // The first loading announcement legitimately moves the phase to busy;
  // that render re-establishes the baseline this test measures against.
  await page.evaluate(async () => {
    const snapshot = window.readerFixture.indexSnapshot(
      window.readerFixture.nativeIndex().index,
      'loading',
    );
    snapshot.status.entries += 128;
    await window.readerFixture.indexEvent(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await expect(files).toContainText('Indexing folder…');
  const baseline = await rowRenders();
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(async () => {
      const snapshot = window.readerFixture.indexSnapshot(
        window.readerFixture.nativeIndex().index,
        'loading',
      );
      snapshot.status.entries += 128;
      await window.readerFixture.indexEvent(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(await rowRenders()).toBe(baseline);
  }
  // The counts moved, the message reflects them, and the tree is intact.
  await expect(files).toContainText('Indexing folder…');
  expect(
    await page.evaluate(
      () => document.querySelectorAll('nav[aria-label="Files"] li').length,
    ),
  ).toBe(2000);
  // A settled publication still replaces the tree inputs and the phase.
  // The small replacement tree keeps this update render bounded in the
  // development build.
  await page.evaluate((root) => {
    const next = {
      ...root,
      revision: root.revision + 1,
      entries: root.entries.slice(0, 6),
    };
    return window.readerFixture.indexEvent(
      window.readerFixture.indexSnapshot(next),
    );
  }, big);
  await expect(files).toContainText('Folder loaded.');
  expect(
    await page.evaluate(
      () => document.querySelectorAll('nav[aria-label="Files"] li').length,
    ),
  ).toBe(3);
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
          await article.evaluate(
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
    await article.dispose();
  });
}

for (const code of ['denied', 'notFound'] as const) {
  test(`repair persistent ${code} root outcome survives unrelated feedback and recovers through refresh`, async ({
    page,
  }, info) => {
    await open(page, snapshot('outside.md', 99, '# Kept reader\n## Target'));
    const article = await page.getByRole('article').elementHandle();
    const root = { ...index(), entries: [] };
    // The working folder becomes unavailable through its watcher status, the
    // way a removed or denied folder degrades in production.
    await page.evaluate(
      ({ root, code }) =>
        window.readerFixture.indexEvent(
          window.readerFixture.indexSnapshot(
            root,
            'unavailable',
            `${code} root access`,
          ),
        ),
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
        await article.evaluate(
          (node) => node === document.querySelector('article'),
        ),
      ).toBe(true);
    };
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
      await article.evaluate(
        (node) => node === document.querySelector('article'),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
    await article.dispose();
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
  // The reload applies to the displayed document. Wait for beta.MKDOWN to be
  // shown: while the reader is still opening it, the command is refused.
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    'beta.MKDOWN',
  );
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
      // One fixture commit established the working folder; the open and the
      // endpoint navigation add two more.
      expect(
        await page.evaluate(
          () =>
            window.readerFixture
              .calls()
              .filter((call) => call.command === 'commit_document').length,
        ),
      ).toBe(3);
      await page.screenshot({
        path: info.outputPath('menu-endpoint-focus.png'),
      });
    });
  }

test('opening a Markdown file expands its own heading group once and a deliberate collapse survives reordering', async ({
  page,
}) => {
  await choose(page);
  await siblings(page, 10);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('read_preview', {
        value: {
          documentId: 0,
          contextId: 10,
          revision: 99,
          name: 'alpha.md',
          location: 'fixture/alpha.md',
          format: 'markdown',
          source: '# Alpha\n## Section',
        },
      });
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('alpha.md', 10, '# Alpha\n## Section', 1, 101),
  );
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Hide headings for alpha.md',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('button', { name: 'Open alpha.md at Section', exact: true }),
  ).toHaveCount(1);
  // A deliberate collapse is not undone by reordering the file list.
  await page
    .getByRole('button', { name: 'Hide headings for alpha.md', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Show headings for alpha.md',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'false');
  // The reorder arrives through the Navigate menu path now that the sidebar
  // carries no sort controls of its own.
  await page.evaluate(() => window.readerFixture.menu('sort-modified'));
  await expect(
    page.getByRole('button', {
      name: 'Show headings for alpha.md',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'false');
  // A later explicit open of the same file expands the group again.
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('read_preview', {
        value: {
          documentId: 0,
          contextId: 10,
          revision: 99,
          name: 'alpha.md',
          location: 'fixture/alpha.md',
          format: 'markdown',
          source: '# Alpha\n## Section',
        },
      });
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('alpha.md', 10, '# Alpha\n## Section', 2, 102),
  );
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Hide headings for alpha.md',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'true');
  // A failed open expands nothing new.
  await page.evaluate(() => {
    window.readerFixture.enqueue('open_index_entry', {
      error: {
        code: 'denied',
        message: 'Target denied',
        attempted: 'beta.MKDOWN',
      },
    });
  });
  await page
    .getByRole('button', { name: 'Open beta.MKDOWN', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('beta.MKDOWN');
  await expect(
    page.getByRole('button', {
      name: 'Show headings for beta.MKDOWN',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'false');
  // A hidden sidebar performs no heading preview work for the opened file.
  await page.evaluate(() => window.readerFixture.menu('sort-name'));
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  const previews = await page.evaluate(
    () =>
      window.readerFixture
        .navigationCalls()
        .filter((call) => call.command === 'read_preview').length,
  );
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('beta.MKDOWN', 20, '# Beta', 3, 103),
  );
  // The settled sibling projection names the newly opened file.
  await siblings(page, 20);
  await page.evaluate(() => window.readerFixture.menu('next'));
  await expect(
    page.getByRole('article', { name: 'beta.MKDOWN' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .navigationCalls()
          .filter((call) => call.command === 'read_preview').length,
    ),
  ).toBe(previews);
  // The hidden row is marked expanded without reading its headings.
  await page.evaluate(() => {
    window.readerFixture.enqueue('read_preview', {
      value: {
        documentId: 0,
        contextId: 20,
        revision: 99,
        name: 'beta.MKDOWN',
        location: 'fixture/beta.MKDOWN',
        format: 'markdown',
        source: '# Beta',
      },
    });
  });
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await expect(
    page.getByRole('button', {
      name: 'Hide headings for beta.MKDOWN',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'true');
});

test('a sort-only interaction replaces no reading session', async ({
  page,
}) => {
  await choose(page);
  await siblings(page, 10);
  const reading = `# Reading\n\n## Section\n\n${'Readable words. '.repeat(300)}\n\n\`\`\`mermaid\ngraph LR\n A-->B\n\`\`\`\n\n<audio src="tone.wav"></audio>`;
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('resolve_media', {
        value: { id: '0'.repeat(31) + '2', mime: 'audio/wav' },
      });
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('alpha.md', 10, reading, 1, 101),
  );
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'alpha.md' })).toBeVisible();
  await expect(page.locator('article .diagram svg')).toHaveCount(1);
  await expect(page.locator('article audio')).toHaveCount(1);
  const article = await page.getByRole('article').elementHandle();
  const media = await page.locator('article audio').elementHandle();
  const figure = await page.locator('article .diagram svg').elementHandle();
  await page.evaluate(() => {
    const heading = document.querySelector('article h2');
    if (!heading) throw new Error('Missing reading heading');
    const range = document.createRange();
    range.selectNodeContents(heading);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const main = document.querySelector('main');
    if (main) main.scrollTop = 120;
  });
  const before = await page.evaluate(() => ({
    scroll: document.querySelector('main')?.scrollTop ?? 0,
    selection: window.getSelection()?.toString() ?? '',
    calls: window.readerFixture.calls().length,
    parses: window.readerFixture.parses(),
    siblingScans: window.readerFixture
      .navigationCalls()
      .filter((call) => call.command === 'get_siblings').length,
    playback: (() => {
      const audio = document.querySelector('article audio');
      return audio instanceof HTMLAudioElement
        ? { paused: audio.paused, time: audio.currentTime }
        : null;
    })(),
  }));
  // The Files pane renders no sort controls; they live in the Settings
  // dialog and the Navigate menu only.
  await expect(page.locator('nav[aria-label="Files"] select')).toHaveCount(0);
  await expect(page.locator('#file-sort-key')).toHaveCount(0);
  await expect(page.locator('#file-sort-direction')).toHaveCount(0);
  await page.evaluate(() => window.readerFixture.menu('settings'));
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  const fileOrder = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'nav[aria-label="Files"] .file-row button',
        ),
      ].flatMap((button) => {
        const label = button.getAttribute('aria-label');
        return label && label.startsWith('Open ') ? [label] : [];
      }),
    );
  // Folder rows sort before files, and the never-opened folder's hidden
  // child stays unmaterialized: the root-level file rows carry the order.
  await expect
    .poll(fileOrder)
    .toEqual(['Open alpha.md', 'Open beta.MKDOWN', 'Open literal.log']);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Files"] button')].some(
        (button) => button.getAttribute('aria-label') === 'Open nested/deep.md',
      ),
    ),
  ).toBe(false);
  await dialog
    .getByLabel('Sort files by', { exact: true })
    .selectOption('modified');
  await expect(dialog.getByLabel('Sort files by', { exact: true })).toHaveValue(
    'modified',
  );
  // The dialog change reorders the file tree in place.
  await expect
    .poll(fileOrder)
    .toEqual(['Open beta.MKDOWN', 'Open literal.log', 'Open alpha.md']);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  // With the dialog closed, the Navigate menu writes the same preference,
  // and a reopened dialog renders it.
  await page.evaluate(() => window.readerFixture.menu('sort-size'));
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Sort files by', { exact: true })).toHaveValue(
    'size',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  const after = await page.evaluate(() => ({
    scroll: document.querySelector('main')?.scrollTop ?? 0,
    selection: window.getSelection()?.toString() ?? '',
    calls: window.readerFixture.calls().length,
    parses: window.readerFixture.parses(),
    siblingScans: window.readerFixture
      .navigationCalls()
      .filter((call) => call.command === 'get_siblings').length,
    playback: (() => {
      const audio = document.querySelector('article audio');
      return audio instanceof HTMLAudioElement
        ? { paused: audio.paused, time: audio.currentTime }
        : null;
    })(),
  }));
  expect(after.calls).toBe(before.calls);
  expect(after.parses).toBe(before.parses);
  // The applied order is presentation only: the native siblings are not
  // re-enumerated when the preference changes.
  expect(after.siblingScans).toBe(before.siblingScans);
  expect(after.scroll).toBe(before.scroll);
  expect(after.selection).toBe(before.selection);
  expect(after.playback).toEqual(before.playback);
  expect(
    await article.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(
    await media.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  expect(
    await figure.evaluate(
      (node) => node === document.querySelector('article .diagram svg'),
    ),
  ).toBe(true);
  const calls = await page.evaluate(() => window.readerFixture.calls());
  expect(
    calls.filter((call) => call.command === 'open_index_entry'),
  ).toHaveLength(1);
  // The working-folder fixture document adds the other commit.
  expect(
    calls.filter((call) => call.command === 'commit_document'),
  ).toHaveLength(2);
  expect(calls.filter((call) => call.command === 'resolve_media')).toHaveLength(
    1,
  );
  await article.dispose();
  await media.dispose();
  await figure.dispose();
});

test('opening a file adopts its folder without a picker step; depth and pane preferences are remembered and both-hidden stays readable', async ({
  page,
}, info) => {
  const tree = index();
  // One open: the document commits and its folder becomes the watched
  // working folder. No chooser command exists at all.
  await openRoot(page, snapshot('alpha.md', 10, text), tree);
  await siblings(page, 10);
  const files = page.getByRole('navigation', { name: 'Files', exact: true });
  await expect(
    files.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeHidden();
  await page
    .getByRole('button', { name: 'Expand folder nested', exact: true })
    .click();
  await expect(
    files.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeVisible();
  // Adoption is not an operation: besides the document open, its commit,
  // sibling enumeration and the document's own media resolution, the
  // interaction issued no folder-picking or separate indexing command.
  const interaction = (
    await page.evaluate(() => window.readerFixture.calls())
  ).map((call) => call.command);
  expect(
    interaction.filter(
      (name) =>
        name !== 'select_document' &&
        name !== 'commit_document' &&
        name !== 'get_siblings' &&
        name !== 'resolve_media',
    ),
  ).toEqual([]);
  // The right-hand Table of Contents renders beside the article.
  const outline = page.getByRole('navigation', { name: 'On this page' });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('link', { name: /Repeat/ })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('three-pane.png') });
  // View → Show Table of Contents hides the right pane and remembers it.
  await page.evaluate(() => window.readerFixture.menu('toc'));
  await expect(outline).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.settings().settings.tocVisible),
    )
    .toBe(false);
  await expect(
    page.getByRole('dialog').getByLabel('Show Table of Contents by default'),
  ).toHaveCount(0);
  await page.evaluate(() => window.readerFixture.menu('settings'));
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(
    dialog.getByLabel('Show Table of Contents by default'),
  ).not.toBeChecked();
  await expect(
    dialog.getByLabel('Show File Explorer by default'),
  ).toBeChecked();
  // The indexing depth is offered as a remembered choice.
  await expect(
    dialog.getByLabel('Indexing depth', { exact: true }),
  ).toHaveValue('2');
  await dialog.getByLabel('Indexing depth', { exact: true }).selectOption('6');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.readerFixture.settings().settings.navigationDepth,
      ),
    )
    .toBe(6);
  const calls = await page.evaluate(() => window.readerFixture.settingsCalls());
  // Revision 1 came from the Table of Contents toggle; the depth rides the
  // same revisioned store.
  expect(calls.at(-1)).toEqual({
    command: 'update_settings',
    payload: { expectedRevision: 1, patch: { navigationDepth: 6 } },
  });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // A reload restores the remembered choices: the Table of Contents stays
  // hidden, the File Explorer stays visible.
  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'On this page' }),
  ).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toBeVisible();
  // Hiding the explorer too leaves a quiet reader-only shell, and the
  // outline returns on its own command alone.
  await page.evaluate(() => window.readerFixture.menu('sidebar'));
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'On this page' }),
  ).toBeHidden();
  await page.screenshot({ path: info.outputPath('reader-only.png') });
  await page.evaluate(() => window.readerFixture.menu('toc'));
  await expect(
    page.getByRole('navigation', { name: 'On this page' }),
  ).toBeVisible();
});

test('Cmd/Ctrl+Arrow keys open the first and last sibling on overfilled documents without scrolling', async ({
  page,
}) => {
  const overflow = Array.from(
    { length: 40 },
    (_, section) =>
      `## Overflow section ${String(section)}\n\n${'Filler paragraph for document overflow. '.repeat(24)}\n`,
  ).join('\n');
  // Active beta.MKDOWN (20): alpha.md (10) is first, literal.log (30) is last.
  await siblings(page, 20);
  await open(page, snapshot('beta.MKDOWN', 20, overflow));
  // The settled sibling projection enables both neighbors, so first and last
  // targets exist; they stay disabled until the projection lands.
  await expect(
    page.getByRole('button', { name: 'Previous File', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Next File', exact: true }),
  ).toBeEnabled();
  // A mid-document scroll position proves the document overflows the scroller;
  // a short document would clamp the assignment to 0.
  const scrolled = await page.evaluate(() => {
    const scroller = document.querySelector('main');
    if (!scroller) throw new Error('Missing reading scroller');
    scroller.scrollTop = 200;
    return scroller.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(100);
  // The primary modifier follows the platform, mirroring the accelerators the
  // native menu no longer claims for these items.
  const primary = await page.evaluate(() =>
    /Mac/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('alpha.md', 10, overflow),
  );
  await page.keyboard.press(`${primary}+ArrowUp`);
  await expect(page.getByRole('article', { name: 'alpha.md' })).toBeVisible();
  // The key was consumed: neither the WebKit scroll-to-top default nor any
  // engine scroll moved the reading position while the sibling opened.
  expect(
    Math.abs(
      scrolled -
        (await page.evaluate(
          () => document.querySelector('main')?.scrollTop ?? -1,
        )),
    ),
  ).toBeLessThanOrEqual(1);
  await page.evaluate(
    (doc) => {
      window.readerFixture.enqueue('open_index_entry', { value: doc });
    },
    snapshot('literal.log', 30, overflow),
  );
  await page.keyboard.press(`${primary}+ArrowDown`);
  await expect(
    page.getByRole('article', { name: 'literal.log' }),
  ).toBeVisible();
  expect(
    Math.abs(
      scrolled -
        (await page.evaluate(
          () => document.querySelector('main')?.scrollTop ?? -1,
        )),
    ),
  ).toBeLessThanOrEqual(1);
  // One keypress, one navigation: the frontend owns the keys alone.
  const calls = await page.evaluate(() => window.readerFixture.calls());
  expect(
    calls.filter((call) => call.command === 'open_index_entry'),
  ).toHaveLength(2);
});

test('a folder row toggles expansion in one click and the chevron tracks aria-expanded', async ({
  page,
}) => {
  await choose(page);
  const files = page.getByRole('navigation', { name: 'Files', exact: true });
  const row = files.getByRole('button', {
    name: 'Expand folder nested',
    exact: true,
  });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.chevron')).toHaveCSS('transform', 'none');
  // The folder name is the toggle: one control per row, no separate
  // Expand/Collapse button and no inert label.
  await row.click();
  const expanded = files.getByRole('button', {
    name: 'Collapse folder nested',
    exact: true,
  });
  await expect(expanded).toHaveAttribute('aria-expanded', 'true');
  await expect(expanded.locator('.chevron')).toHaveCSS(
    'transform',
    'matrix(0, 1, -1, 0, 0, 0)',
  );
  await expect(
    files.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeVisible();
  await expanded.click();
  await expect(
    files.getByRole('button', { name: 'Expand folder nested', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    files.getByRole('button', { name: 'Open nested/deep.md', exact: true }),
  ).toBeHidden();
});
