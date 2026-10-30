import { expect, test } from '@playwright/test';
import type { Snapshot } from '../../src/types';
const snapshot = (
  name: string,
  documentId = 1,
  revision = 1,
  source = '# Reader\n\n- [x] Read only',
): Snapshot => ({
  documentId,
  revision,
  name,
  location: `fixture/${name}`,
  format: 'markdown',
  source,
});

test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect(page.getByRole('button', { name: 'Open File…' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(2);
  await expect(page.locator('header .commands')).toHaveCSS('display', 'flex');
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('real shell routes Open, chooser cancel, literal text and empty files through the JS adapter', async ({
  page,
}, info) => {
  const doc = snapshot('reading.md');
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
  }, doc);
  await expect(page.getByRole('button', { name: 'Reload' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open File…' }).click();
  const article = page.getByRole('article', { name: 'reading.md' });
  await expect(article.getByRole('heading', { name: 'Reader' })).toBeVisible();
  await expect(article.getByRole('checkbox')).toBeDisabled();
  await expect(article).toBeFocused();
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([
    { command: 'select_document', payload: { requestId: 1 } },
    { command: 'commit_document', payload: { requestId: 1 } },
  ]);
  await page.screenshot({
    path: info.outputPath('reader-shell-browser.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'cancelled' },
    });
  });
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('status')).toContainText('Open cancelled');
  await expect(article).toBeVisible();
  const literal = {
    ...snapshot('literal.log', 3),
    format: 'text' as const,
    source:
      '# Literal\n<script>not executed</script>\n![not fetched](https://invalid.example/a)',
  };
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
  }, literal);
  await page.getByRole('button', { name: 'Open File…' }).click();
  const textArticle = page.getByRole('article', { name: 'literal.log' });
  await expect(textArticle).toHaveText(literal.source);
  await expect(textArticle.locator('script, img, h1')).toHaveCount(0);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await expect(textArticle).toBeFocused();
  await page.evaluate(
    (value) => {
      window.readerFixture.enqueue('select_document', {
        value: { status: 'ready', snapshot: value },
      });
    },
    snapshot('empty.md', 4, 4, ''),
  );
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('article', { name: 'empty.md' })).toHaveText(
    'This file is empty.',
  );
  await expect(page.getByRole('status')).toContainText('empty file');
});

test('untrusted document markup cannot invoke the native JS bridge from the actual shell', async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      externalRequests.push(request.url());
  });
  const doc = snapshot(
    'untrusted.md',
    1,
    1,
    `# Safe reading\n\n<script>window.__TAURI_INTERNALS__.invoke('select_document', { requestId: 999 })</script>\n\n<img src="https://invalid.example/image" onerror="window.__TAURI_INTERNALS__.invoke('select_document', { requestId: 998 })" alt="Blocked image">\n\n[Inactive](javascript:alert(1))`,
  );
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
  }, doc);
  await page.getByRole('button', { name: 'Open File…' }).click();
  const article = page.getByRole('article', { name: 'untrusted.md' });
  await expect(
    article.getByRole('heading', { name: 'Safe reading' }),
  ).toBeVisible();
  await expect(article).toContainText('[Blocked img: Blocked image]');
  await expect(article.locator('script, img, [href], [onerror]')).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([
    { command: 'select_document', payload: { requestId: 1 } },
    { command: 'commit_document', payload: { requestId: 1 } },
  ]);
  expect(externalRequests).toEqual([]);
});

test('real adapter reload payload and failed replacement preserve the displayed identity and focus', async ({
  page,
}) => {
  const doc = snapshot('current.md');
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
  }, doc);
  await page.getByRole('button', { name: 'Open File…' }).click();
  const article = page.getByRole('article', { name: 'current.md' });
  await expect(article).toBeFocused();
  await page.evaluate(
    (value) => {
      window.readerFixture.enqueue('reload_document', { value });
      return window.readerFixture.menu('reload');
    },
    { ...doc, revision: 2, source: '# Updated\n\nNew contents' },
  );
  await expect(article.getByRole('heading', { name: 'Updated' })).toBeVisible();
  await expect(article).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.readerFixture
        .calls()
        .filter((call) => call.command === 'reload_document'),
    ),
  ).toEqual([
    {
      command: 'reload_document',
      payload: { requestId: 2, documentId: 1, revision: 1 },
    },
  ]);
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: {
        code: 'invalidUtf8',
        message: 'Not valid UTF-8',
        attempted: 'fixture/broken.md',
      },
    });
  });
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('alert')).toContainText('fixture/broken.md');
  await expect(page.getByLabel('Displayed document')).toContainText(
    'current.md',
  );
  await expect(page.getByLabel('Displayed document')).toContainText('Stale');
  await expect(article.getByRole('heading', { name: 'Updated' })).toBeVisible();
  await page.evaluate(() => {
    window.readerFixture.enqueue('reload_document', {
      error: {
        code: 'notFound',
        message: 'The file is missing',
        attempted: 'fixture/current.md',
      },
    });
  });
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('alert')).toContainText('Reload failed');
  await expect(article.getByRole('heading', { name: 'Updated' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .calls()
          .filter((call) => call.command === 'reload_document')
          .at(-1)?.payload,
    ),
  ).toEqual({ requestId: 4, documentId: 1, revision: 2 });
});

test('cancelling a pending backend response ignores its late context without parsing it', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'old-selection' });
  });
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toEqual(['old-selection']);
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operation cancelled');
  await page.evaluate(
    (value) => {
      window.readerFixture.enqueue('select_document', {
        value: { status: 'ready', snapshot: value },
      });
    },
    snapshot('newer.md', 3),
  );
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('article', { name: 'newer.md' })).toBeFocused();
  await page.evaluate((value) => {
    window.readerFixture.release('old-selection', {
      value: { status: 'ready', snapshot: value },
    });
  }, snapshot('obsolete.md'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.readerFixture
            .settled()
            .filter((name) => name === 'select_document').length,
      ),
    )
    .toBe(2);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    await page.evaluate(() =>
      window.readerFixture
        .calls()
        .filter((call) => call.command === 'cancel_operation'),
    ),
  ).toEqual([{ command: 'cancel_operation', payload: { requestId: 1 } }]);
  expect(
    await page.evaluate(() =>
      window.readerFixture
        .calls()
        .filter((call) => call.command === 'commit_document'),
    ),
  ).toEqual([{ command: 'commit_document', payload: { requestId: 3 } }]);
  await expect(page.getByRole('status')).toHaveText('Opened newer.md.');
});

test('an error with a native null attempted target leaves the empty shell recoverable', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: {
        code: 'resourceFailure',
        message: 'The native file chooser failed.',
        attempted: null,
      },
    });
  });
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Open failed: The native file chooser failed.',
  );
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open File…' })).toBeEnabled();
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
  }, snapshot('recovered.md'));
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(
    page.getByRole('article', { name: 'recovered.md' }),
  ).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Opened recovered.md.');
});

test('menu events are once-only, composition-aware and removed on unmount', async ({
  page,
}) => {
  const open = page.getByRole('button', { name: 'Open File…' });
  await open.dispatchEvent('compositionstart', { data: 'reading' });
  await page.evaluate(() => window.readerFixture.menu('open'));
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([]);
  await open.dispatchEvent('compositionend', { data: 'reading' });
  await page.evaluate((value) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot: value },
    });
    return window.readerFixture.menu('open');
  }, snapshot('menu.md'));
  await expect(page.getByRole('article', { name: 'menu.md' })).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .calls()
          .filter((call) => call.command === 'select_document').length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    window.readerFixture.unmount();
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(0);
  await page.evaluate(() => window.readerFixture.menu('open'));
  expect(
    await page.evaluate(
      () =>
        window.readerFixture
          .calls()
          .filter((call) => call.command === 'select_document').length,
    ),
  ).toBe(1);
});
