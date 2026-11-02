import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Snapshot } from '../../src/types';
import packageMetadata from '../../package.json' with { type: 'json' };
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
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  writeFileSync(
    `${path}.json`,
    JSON.stringify(
      {
        engine: info.project.name,
        viewport: page.viewportSize(),
        palette: await page.locator('html').getAttribute('data-palette'),
        zoom: await page.evaluate(
          () =>
            document.querySelector('article')?.getAttribute('data-zoom') ??
            'No document',
        ),
        nativeBackendAndMenus:
          'Explicit browser doubles; not native qualification',
      },
      null,
      2,
    ),
  );
}
async function open(page: Page, doc: Snapshot) {
  await page.evaluate((snapshot) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot },
    });
    return window.readerFixture.menu('open');
  }, doc);
  await expect(page.getByRole('article', { name: doc.name })).toBeFocused();
}
test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect(page.getByRole('main')).toContainText('File → Open File');
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(true);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('renamed About displays taurimd without reading or replacing a document', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.readerFixture.calls());
  await page.evaluate(() => window.readerFixture.menu('about'));
  const about = page.getByRole('dialog', {
    name: 'About taurimd',
    exact: true,
  });
  await expect(about).toContainText(`taurimd ${packageMetadata.version}`);
  await expect(about).toContainText('MIT licensed');
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual(
    before,
  );
  await about.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('main')).toBeFocused();
});

test('quiet menu-first shell routes Open, chooser cancel, literal text and empty files through the JS adapter', async ({
  page,
}, info) => {
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByLabel('Displayed document')).toHaveText(
    'No document openReady',
  );
  await expect(page.getByRole('status')).toBeEmpty();
  await capture(page, info, 'quiet-empty-reader');
  await page.evaluate(() => window.readerFixture.menu('information'));
  await expect(page.getByRole('status')).toContainText('unavailable');
  await open(page, snapshot('reading.md'));
  const article = page.getByRole('article', { name: 'reading.md' });
  await expect(article.getByRole('heading', { name: 'Reader' })).toBeVisible();
  await expect(article.getByRole('checkbox')).toBeDisabled();
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
    return window.readerFixture.menu('open');
  });
  await expect(page.getByRole('status')).toContainText('Open cancelled');
  await expect(article).toBeVisible();
  const literal = {
    ...snapshot('literal.log', 3),
    format: 'text' as const,
    source:
      '# Literal\n<script>not executed</script>\n![not fetched](https://invalid.example/a)',
  };
  await open(page, literal);
  const textArticle = page.getByRole('article', { name: 'literal.log' });
  await expect(textArticle).toHaveText(literal.source);
  await expect(textArticle.locator('script, img, h1')).toHaveCount(0);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await open(page, snapshot('empty.md', 4, 4, ''));
  await expect(page.getByRole('article', { name: 'empty.md' })).toHaveText(
    'This file is empty.',
  );
  await expect(page.getByLabel('Displayed document')).toContainText(
    'Empty file',
  );
});

test('untrusted markup cannot invoke the native JS bridge from the actual shell', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      requests.push(request.url());
  });
  await open(
    page,
    snapshot(
      'untrusted.md',
      1,
      1,
      `# Safe reading\n\n<script>window.__TAURI_INTERNALS__.invoke('select_document', { requestId: 999 })</script>\n\n<img src="https://invalid.example/image" onerror="window.__TAURI_INTERNALS__.invoke('select_document', { requestId: 998 })" alt="Blocked image">\n\n[Inactive](javascript:alert(1))`,
    ),
  );
  const article = page.getByRole('article');
  await expect(
    article.getByRole('heading', { name: 'Safe reading' }),
  ).toBeVisible();
  await expect(article).toContainText('Blocked img');
  await expect(
    article.locator('script, img[src], a[href]:not([href="#"]), [onerror]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([
    { command: 'select_document', payload: { requestId: 1 } },
    { command: 'commit_document', payload: { requestId: 1 } },
  ]);
  expect(requests).toEqual([]);
});

test('hidden status retains failed replacement/reload target recovery and full displayed identity', async ({
  page,
}) => {
  const doc = snapshot('current.md');
  doc.location = `fixture/${'long-directory/'.repeat(20)}current.md`;
  await open(page, doc);
  const article = page.getByRole('article');
  await page.evaluate(
    (value) => {
      window.readerFixture.enqueue('reload_document', { value });
      return window.readerFixture.menu('reload');
    },
    { ...doc, revision: 2, source: '# Updated\n\nNew contents' },
  );
  await expect(article.getByRole('heading', { name: 'Updated' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Document Information…' }).focus();
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await expect(article).toBeFocused();
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: {
        code: 'invalidUtf8',
        message: 'Not valid UTF-8',
        attempted: 'fixture/broken.md',
      },
    });
    return window.readerFixture.menu('open');
  });
  await expect(page.getByRole('alert')).toContainText('fixture/broken.md');
  await expect(page.getByRole('alert')).toContainText(
    'Still showing last loaded current.md',
  );
  await page.evaluate(() => window.readerFixture.menu('information'));
  const info = page.getByRole('dialog', { name: 'Document Information' });
  await expect(info).toContainText(doc.location);
  await expect(info).toContainText('Stale: last loaded content');
  await info.locator('dd').first().click({ clickCount: 3 });
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString().trim()))
    .toBe('current.md');
  await info.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => {
    window.readerFixture.enqueue('reload_document', {
      error: {
        code: 'notFound',
        message: 'The file is missing',
        attempted: 'fixture/current.md',
      },
    });
    return window.readerFixture.menu('reload');
  });
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

test('hidden-status pending Cancel remains reachable; stale modal commands never queue; late selection is ignored', async ({
  page,
}) => {
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'old-selection' });
    return window.readerFixture.menu('open');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toEqual(['old-selection']);
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.readerFixture.menu('guide'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Command unavailable');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Operation cancelled');
  await open(page, snapshot('newer.md', 3));
  await page.evaluate((snapshot) => {
    window.readerFixture.release('old-selection', {
      value: { status: 'ready', snapshot },
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

test('empty-reader native null target errors expose direct recovery', async ({
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
    return window.readerFixture.menu('open');
  });
  await expect(page.getByRole('alert')).toHaveText(
    'Open failed: The native file chooser failed.',
  );
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open File…' })).toBeEnabled();
  await page.evaluate((snapshot) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot },
    });
  }, snapshot('recovered.md'));
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(
    page.getByRole('article', { name: 'recovered.md' }),
  ).toBeFocused();
});

test('menu dispatch once, composition and commit guards, and listener disposal', async ({
  page,
}) => {
  const main = page.getByRole('main');
  await main.dispatchEvent('compositionstart', { data: 'reading' });
  await page.evaluate(() => window.readerFixture.menu('open'));
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([]);
  await main.dispatchEvent('compositionend', { data: 'reading' });
  await page.evaluate(() => {
    window.readerFixture.enqueue('commit_document', { hold: 'commit' });
  });
  await page.evaluate((snapshot) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot },
    });
    return window.readerFixture.menu('open');
  }, snapshot('menu.md'));
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toEqual(['commit']);
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.evaluate(async () => {
    await window.readerFixture.menu('open');
    await window.readerFixture.menu('settings');
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('commit', { value: null });
  });
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
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
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

test('applied unsaved visibility/checkmark, late intent, conflict, Retry, mock rehydration and presentation failure', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.enqueue('update_settings', { hold: 'save' });
    return window.readerFixture.menu('status-bar');
  });
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(false);
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await expect(page.getByLabel('Displayed document')).toBeVisible();
  await page.evaluate(() => {
    window.readerFixture.release('save', {
      error: { code: 'io', message: 'Disk unavailable' },
    });
  });
  await expect(
    page.getByRole('region', { name: 'Preferences status' }),
  ).toContainText('Applied for now');
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Retry preferences' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.readerFixture.settings().settings.statusVisible,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await expect
    .poll(() =>
      page.evaluate(
        () => window.readerFixture.settings().settings.statusVisible,
      ),
    )
    .toBe(false);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(false);
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.enqueue('present_reader', {
      hold: 'old-presentation',
    });
    return window.readerFixture.menu('status-bar');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toEqual(['old-presentation']);
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(false);
  await page.evaluate(() => {
    window.readerFixture.release('old-presentation', { value: null });
  });
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(false);
  await page.evaluate(() => {
    window.readerFixture.enqueue('present_reader', {
      error: { code: 'resourceFailure', message: 'Menu sync unavailable' },
    });
    return window.readerFixture.menu('status-bar');
  });
  await expect(page.getByRole('alert')).toContainText(
    'Menu presentation could not',
  );
  await page
    .getByRole('button', { name: 'Retry menu synchronization' })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.statusVisible),
    )
    .toBe(true);
});

test('bundled Guide is a separate real parsed surface with scoped fragments, complete keyboard focus, modal guards and About', async ({
  page,
}, info) => {
  const nativeBefore = await page.evaluate(() => window.readerFixture.calls());
  await page.evaluate(() => window.readerFixture.menu('guide'));
  const guide = page.getByRole('dialog', { name: 'User Guide' });
  await expect(
    guide.getByRole('heading', { name: 'User Guide', exact: true }).first(),
  ).toBeFocused();
  await expect(
    guide.getByRole('link', { name: 'Opening and recovery', exact: true }),
  ).toBeVisible();
  await expect(guide.locator('[id]')).not.toHaveCount(0);
  expect(
    await guide
      .locator('.guide [id]')
      .evaluateAll((nodes) =>
        nodes.every((node) => node.id.startsWith('reader-guide-')),
      ),
  ).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(guide.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  const firstLink = guide.getByRole('link', {
    name: 'Opening and recovery',
    exact: true,
  });
  await expect(firstLink).toBeFocused();
  const links = guide.getByRole('link');
  const visited = new Set<string>();
  let reachedClose = false;
  // Engines may also tab to their keyboard-scrollable code containers. Check
  // the real order without pretending those native tab stops do not exist.
  for (let index = 0; index < (await links.count()) + 6; index++) {
    const active = await guide.evaluate((node) => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent.slice(0, 60),
      inside: node.contains(document.activeElement),
      link:
        document.activeElement?.tagName === 'A'
          ? document.activeElement.textContent
          : null,
      close:
        document.activeElement?.tagName === 'BUTTON' &&
        document.activeElement.textContent === 'Close',
    }));
    expect(
      active.inside,
      JSON.stringify({ index, active, visited: [...visited] }),
    ).toBe(true);
    if (active.link) visited.add(active.link);
    if (active.close) {
      reachedClose = true;
      break;
    }
    await page.keyboard.press('Tab');
  }
  expect(reachedClose).toBe(true);
  expect([...visited]).toEqual(await links.allTextContents());
  await expect(guide.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    guide.getByRole('heading', { name: 'Opening and recovery', exact: true }),
  ).toBeFocused();
  await firstLink.dispatchEvent('compositionstart', { data: 'guide' });
  await page.keyboard.press('Escape');
  await expect(guide).toBeVisible();
  await firstLink.dispatchEvent('compositionend', { data: 'guide' });
  await page.evaluate(async () => {
    await window.readerFixture.menu('open');
    await window.readerFixture.menu('settings');
  });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual(
    nativeBefore,
  );
  await capture(page, info, 'empty-guide');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('main')).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(0);
  await page.evaluate(() => window.readerFixture.menu('about'));
  const about = page.getByRole('dialog', { name: 'About taurimd' });
  await expect(about).toContainText('MIT licensed');
  await expect(about).toContainText('remain separate checks');
  await capture(page, info, 'about-empty-reader');
  await about.getByRole('button', { name: 'Close' }).click();
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual(
    nativeBefore,
  );
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(0);
});

test('menu subscription transport failure exposes actual direct Open/Settings/Reload recovery with status hidden', async ({
  page,
}) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html?menu-failure`,
  );
  await expect(page.getByRole('alert')).toContainText(
    'Menu commands unavailable',
  );
  await page.evaluate((snapshot) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot },
    });
  }, snapshot('fallback.md'));
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(page.getByRole('article')).toBeFocused();
  await page.getByRole('button', { name: 'Document Information…' }).focus();
  await page.evaluate(() => {
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: { ...record.settings, statusVisible: false },
    });
  });
  await expect(page.getByRole('article')).toBeFocused();
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog.getByLabel('Appearance', { exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Settings…' })).toBeFocused();
  await page.evaluate(
    (value) => {
      window.readerFixture.enqueue('reload_document', { value });
    },
    { ...snapshot('fallback.md'), revision: 2, source: '# Recovered reload' },
  );
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Recovered reload' }),
  ).toBeVisible();
});

test('Guide worker failure has literal fallback; dismissal terminates held work without later publication', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.workerMode('fail');
    return window.readerFixture.menu('guide');
  });
  let guide = page.getByRole('dialog', { name: 'User Guide' });
  await expect(guide).toContainText('Guide formatting unavailable');
  await expect(guide.locator('pre')).toContainText('# User Guide');
  await guide.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => {
    window.readerFixture.workerMode('hold');
    return window.readerFixture.menu('guide');
  });
  guide = page.getByRole('dialog', { name: 'User Guide' });
  await expect(guide).toContainText('Loading guide');
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(1);
  await guide.getByRole('button', { name: 'Close' }).click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(0);
  await page.evaluate(() => window.readerFixture.menu('guide'));
  await expect(
    page
      .getByRole('dialog')
      .getByRole('link', { name: 'Opening and recovery', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([]);
});

test('Guide Close control keeps one position while parsed content replaces loading', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.workerMode('hold');
    return window.readerFixture.menu('guide');
  });
  const guide = page.getByRole('dialog', { name: 'User Guide' });
  await expect(guide).toContainText('Loading guide');
  const loading = await guide
    .getByRole('button', { name: 'Close' })
    .boundingBox();
  await guide.getByRole('button', { name: 'Close' }).click();
  await expect(guide).toBeHidden();
  await page.evaluate(() => window.readerFixture.menu('guide'));
  await expect(
    guide.getByRole('link', { name: 'Opening and recovery', exact: true }),
  ).toBeVisible();
  const parsed = await guide
    .getByRole('button', { name: 'Close' })
    .boundingBox();
  expect(loading).not.toBeNull();
  expect(parsed).not.toBeNull();
  if (!loading || !parsed) throw new Error('The Close control has no box');
  // A control that moves under the pointer when the guide finishes loading
  // cannot be activated by the click that was aimed at it.
  expect(parsed.x).toBeCloseTo(loading.x, 0);
  expect(parsed.y).toBeCloseTo(loading.y, 0);
  expect(parsed.width).toBeCloseTo(loading.width, 0);
  expect(parsed.height).toBeCloseTo(loading.height, 0);
  // The dismissed control stays reachable without scrolling the dialog.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('The page has no viewport');
  expect(parsed.y).toBeGreaterThanOrEqual(0);
  expect(parsed.y + parsed.height).toBeLessThanOrEqual(viewport.height);
});
