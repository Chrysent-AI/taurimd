import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Snapshot } from '../../src/types';
const url = `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`;
const owned = new Set<Page>();
const snapshot = (name: string, source: string, id = 1): Snapshot => ({
  documentId: id,
  revision: id,
  name,
  location: `fixture/${name}`,
  format: 'markdown',
  source,
});
async function ready(page: Page, suffix = '') {
  owned.add(page);
  await page.goto(url + suffix);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
}
async function open(page: Page, snapshot: Snapshot) {
  await page.evaluate((snapshot) => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'ready', snapshot },
    });
    return window.readerFixture.menu('open');
  }, snapshot);
  await expect(
    page.getByRole('article', { name: snapshot.name }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('ready');
}
async function incoming(page: Page, snapshot: Snapshot, token = 1) {
  await page.evaluate(
    ({ snapshot, token }) =>
      window.readerFixture.documentRequest({ kind: 'open', token }, snapshot),
    { snapshot, token },
  );
  await expect(
    page.getByRole('article', { name: snapshot.name }),
  ).toBeVisible();
}
async function section(page: Page, token: number, id = 1) {
  await page.evaluate(
    ({ token, id }) =>
      window.readerFixture.documentRequest({
        kind: 'focus',
        token,
        document_id: id,
        revision: id,
        fragment: 'section',
      }),
    { token, id },
  );
  await expect
    .poll(() =>
      page.evaluate(
        (token) =>
          window.readerFixture
            .documentCalls()
            .some(
              (call) =>
                call.command === 'dismiss_document' &&
                (call.payload as { token: number }).token === token,
            ),
        token,
      ),
    )
    .toBe(true);
}
test.afterEach(async ({ page, context }) => {
  for (const reader of owned) {
    await reader.evaluate(() => {
      window.readerFixture.cleanup();
    });
    expect(
      await reader.evaluate(() => window.readerFixture.listenerCount()),
    ).toBe(0);
    expect(
      await reader.evaluate(() => window.readerFixture.activeWorkers()),
    ).toBe(0);
    if (reader !== page) {
      await reader.close();
      expect(context.pages().includes(reader)).toBe(false);
    }
  }
  owned.clear();
});

test('originless invalid native items show attempted-target recovery without dropping a later valid item', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    window.readerFixture.documentRequest({
      kind: 'error',
      token: 80,
      error: {
        code: 'notFound',
        attempted: 'fixture/missing.md',
        message: 'File missing',
      },
    }),
  );
  await expect(page.getByRole('alert')).toContainText('fixture/missing.md');
  await expect(
    page.getByRole('button', { name: 'Open File…', exact: true }),
  ).toBeEnabled();
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).some(
      (call) =>
        call.command === 'receive_document' ||
        call.command === 'commit_document',
    ),
  ).toBe(false);
  await incoming(page, snapshot('valid.md', '# Valid item'), 81);
  await expect(page.getByRole('article', { name: 'valid.md' })).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Valid item', exact: true }),
  ).toBeVisible();
});

test('cold request retained before React listeners uses native receive, real worker, matching commit and fragment', async ({
  page,
}) => {
  await ready(page, '?cold-document');
  await expect(
    page.getByRole('heading', { name: 'Section', exact: true }),
  ).toBeFocused();
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  expect(await page.evaluate(() => window.readerFixture.workerParses())).toBe(
    1,
  );
  const calls = await page.evaluate(() => window.readerFixture.calls());
  expect(calls.filter((call) => call.command === 'receive_document')).toEqual([
    { command: 'receive_document', payload: { token: 1, requestId: 1 } },
  ]);
  expect(calls.filter((call) => call.command === 'commit_document')).toEqual([
    { command: 'commit_document', payload: { requestId: 1 } },
  ]);
  expect(
    calls.some(
      (call) =>
        call.command === 'select_document' ||
        call.command === 'reload_document',
    ),
  ).toBe(false);
  await page.evaluate(() => window.readerFixture.menu('information'));
  await expect(page.getByRole('dialog')).toContainText('fixture/cold.md');
});

test('two actual readers hand off a contained link without replacing origin media, selection, scroll, root or diagram ownership', async ({
  page,
  context,
}) => {
  await ready(page);
  const tone = readFileSync(new URL('./media/tone.wav', import.meta.url));
  await page.route('http://reader-media.localhost/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: tone }),
  );
  await page.evaluate(() => {
    window.readerFixture.enqueue('resolve_media', {
      value: { id: '0'.repeat(31) + '1', mime: 'audio/wav' },
    });
  });
  await open(
    page,
    snapshot(
      'origin.md',
      '# Origin\n\nPreserved selection.\n\n[Related](target.md#section)\n\n<audio src="tone.wav"></audio>\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n<details><summary>Disclosure</summary>Kept body</details>\n\n' +
        'Long paragraph. '.repeat(1200),
    ),
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await page
    .locator('article audio')
    .evaluate(async (audio: HTMLAudioElement) => {
      audio.loop = true;
      audio.muted = true;
      await audio.play();
    });
  await page.getByText('Disclosure', { exact: true }).click();
  const article = await page.getByRole('article').elementHandle();
  const audio = await page.locator('article audio').elementHandle();
  const figure = await page.locator('.diagram').elementHandle();
  await page.evaluate(() => {
    const paragraph = document.querySelector('article p');
    if (!paragraph) throw new Error('Missing reading paragraph');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.querySelector('main')?.scrollTo(0, 500);
    const link = document.querySelector<HTMLAnchorElement>('article a');
    link?.focus({ preventScroll: true });
    window.readerFixture.enqueue('activate_link', {
      value: { status: 'handedOff' },
    });
  });
  const before = await page.evaluate(() => ({
    scroll: document.querySelector('main')?.scrollTop,
    selection: getSelection()?.toString(),
    parses: window.readerFixture.parses(),
  }));
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Reading link status')).toHaveText(
    'Opened in another reader.',
  );
  const target = await context.newPage();
  await ready(target);
  await incoming(
    target,
    snapshot(
      'target.md',
      '---\ntitle: Receiving metadata\n---\n# Target\n\n## Section\n\n```mermaid\nflowchart LR\n X --> Y\n```',
    ),
  );
  await expect(target.locator('.diagram svg')).toHaveCount(1);
  await section(target, 2);
  await expect(
    target.getByRole('heading', { name: 'Section', exact: true }),
  ).toBeFocused();
  expect(
    await article?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(
    await audio?.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  expect(
    await figure?.evaluate(
      (node) => node === document.querySelector('.diagram'),
    ),
  ).toBe(true);
  expect(
    await page
      .locator('article audio')
      .evaluate((audio: HTMLAudioElement) => audio.paused),
  ).toBe(false);
  await expect(
    page.locator('article details').filter({ hasText: 'Kept body' }),
  ).toHaveAttribute('open', '');
  expect(
    await page.evaluate(() => ({
      scroll: document.querySelector('main')?.scrollTop,
      selection: getSelection()?.toString(),
      parses: window.readerFixture.parses(),
    })),
  ).toEqual(before);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'commit_document',
    ),
  ).toHaveLength(1);
  expect(
    (await target.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'receive_document',
    ),
  ).toHaveLength(1);
  // A new native Open collision acknowledges activation without another source commit.
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      value: { status: 'handedOff' },
    });
    return window.readerFixture.menu('open');
  });
  await expect(page.getByLabel('Reading link status')).toHaveText(
    'Activated the existing reader.',
  );
  expect(await page.evaluate(() => window.readerFixture.state().stale)).toBe(
    false,
  );
  expect(
    await article?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  await article?.dispose();
  await audio?.dispose();
  await figure?.dispose();
});

test('existing target fragments respect modal, composition, native Save without DOM, and replaced-document bindings without queued actions', async ({
  page,
}) => {
  await ready(page);
  await open(
    page,
    snapshot(
      'target.md',
      '# Target\n\n[This file](target.md#section)\n\n## Section\n\n```mermaid\nflowchart LR\n A --> B\n```',
    ),
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  const heading = page.getByRole('heading', { name: 'Section', exact: true });
  await page.evaluate(() => window.readerFixture.menu('settings'));
  const mode = page.getByRole('combobox', { name: 'Appearance', exact: true });
  await section(page, 10);
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
  ).toContainText('Incoming document or section unavailable');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('article').dispatchEvent('compositionstart');
  await section(page, 11);
  await page.getByRole('article').dispatchEvent('compositionend');
  await expect(heading).not.toBeFocused();
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', { hold: 'save' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('save');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await section(page, 12);
  await expect(heading).not.toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('save');
  await page.evaluate(() => {
    window.readerFixture.release('save', { value: { status: 'cancelled' } });
  });
  await expect(page.getByLabel('Reader recovery')).toContainText('cancelled');
  await expect(heading).not.toBeFocused();
  await page.evaluate(() => window.readerFixture.menu('find'));
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('Section');
  await section(page, 13);
  await expect(heading).toBeFocused();
  await expect(
    page.getByRole('region', { name: 'Find in document', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.enqueue('activate_link', {
      value: { status: 'anchor', fragment: 'section' },
    });
  });
  await page.getByRole('link', { name: 'This file', exact: true }).click();
  await expect(heading).toBeFocused();
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'commit_document',
    ),
  ).toHaveLength(1);
  await open(
    page,
    snapshot('replacement.md', '# Replacement\n\n## Section', 2),
  );
  await section(page, 14, 1);
  await expect(
    page.getByRole('heading', { name: 'Section', exact: true }),
  ).not.toBeFocused();
  await expect(page.getByLabel('Reading link status')).toContainText(
    'replaced document',
  );
  expect(await mode.count()).toBe(0);
});

test('incoming parsing cancels through the existing worker and does not publish late content or queue a blocked replacement', async ({
  page,
}) => {
  await ready(page);
  await open(page, snapshot('kept.md', '# Kept'));
  await page.evaluate(
    (snapshot) => {
      window.readerFixture.workerMode('hold');
      return window.readerFixture.documentRequest(
        { kind: 'open', token: 30 },
        snapshot,
      );
    },
    snapshot('pending.md', '# Must not commit', 2),
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('parsing');
  await page.evaluate(
    (snapshot) =>
      window.readerFixture.documentRequest(
        { kind: 'open', token: 31 },
        snapshot,
      ),
    snapshot('blocked.md', '# Must not queue', 3),
  );
  await expect(page.getByLabel('Reading link status')).toContainText(
    'Incoming document or section unavailable',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(0);
  await expect(
    page.getByRole('heading', { name: 'Kept', exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'commit_document',
    ),
  ).toHaveLength(1);
  await incoming(page, snapshot('explicit.md', '# Explicit retry', 4), 32);
  await expect(
    page.getByRole('article', { name: 'explicit.md' }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Explicit retry', exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'receive_document',
    ),
  ).toHaveLength(2);
});

test('stable menu subscription deduplicates per-reader sequences and shared committed settings preserve failed local intent and reading nodes', async ({
  page,
  context,
}) => {
  await ready(page);
  const target = await context.newPage();
  await ready(target);
  await open(page, snapshot('one.md', '# One'));
  await open(target, snapshot('two.md', '# Two'));
  const article = await page.getByRole('article').elementHandle();
  const otherArticle = await target.getByRole('article').elementHandle();
  await page.evaluate(async () => {
    window.readerFixture.enqueue('update_settings', {
      error: { code: 'io', message: 'Preferences disk unavailable' },
    });
    await window.readerFixture.menuEnvelope('status-bar', 100);
    await window.readerFixture.menuEnvelope('status-bar', 100);
    await window.readerFixture.menuEnvelope('status-bar', 99);
  });
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await expect(target.getByLabel('Displayed document')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry preferences', exact: true }),
  ).toBeVisible();
  await target.evaluate(() => window.readerFixture.menu('appearance-dark'));
  await expect
    .poll(() =>
      target.evaluate(() => window.readerFixture.settings().settings.mode),
    )
    .toBe('dark');
  const committed = await target.evaluate(() =>
    window.readerFixture.settings(),
  );
  await page.evaluate(
    (record) => window.readerFixture.settingsEvent(record),
    committed,
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.appearance),
    )
    .toBe('dark');
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await expect(target.getByLabel('Displayed document')).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry preferences', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry preferences', exact: true }),
  ).toHaveCount(0);
  const saved = await page.evaluate(() => window.readerFixture.settings());
  await target.evaluate(
    (record) => window.readerFixture.settingsEvent(record),
    saved,
  );
  await expect(target.getByLabel('Displayed document')).toHaveCount(0);
  await page.evaluate(() =>
    window.readerFixture.menuEnvelope('fit-diagrams', 101),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.fitDiagrams),
    )
    .toBe(false);
  expect(await page.evaluate(() => window.readerFixture.listenerCount())).toBe(
    5,
  );
  expect(
    await target.evaluate(() => window.readerFixture.listenerCount()),
  ).toBe(5);
  expect(
    await article?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(
    await otherArticle?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(await target.evaluate(() => window.readerFixture.parses())).toBe(1);
  await article?.dispose();
  await otherArticle?.dispose();
});
