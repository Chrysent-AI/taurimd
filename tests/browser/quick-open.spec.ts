import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import type {
  FileEntry,
  FileIndex,
  QueryRequest,
} from '../../src/navigation/types';
import { palettes } from '../../src/settings/model';
const entry = (
  id: number,
  relative: string,
  kind: FileEntry['kind'] = 'markdown',
): FileEntry => ({
  id,
  uiId: id,
  parent: null,
  name: relative.split('/').at(-1) ?? relative,
  relative,
  kind,
  context: id,
  alphaRank: id,
  dateRank: id,
  sizeRank: id,
});
const index = (revision = 1): FileIndex => ({
  scope: 7,
  revision,
  name: 'fixture/authorized',
  entries: [
    entry(1, 'folder', 'directory'),
    entry(2, 'alpha.md'),
    entry(3, 'folder/beta.log', 'text'),
    entry(4, '😀İ.md'),
  ],
  issues: [],
});
// The derived Quick Open scope fixture: the displayed file's folder subtree
// with supported files at every depth through four.
const subtree = (): FileIndex => ({
  scope: 20,
  revision: 3,
  name: 'fixture/displayed-folder',
  entries: [
    entry(11, 'top.md'),
    entry(12, 'subjects/nested.md'),
    entry(13, 'subjects/deeper/wide.md'),
    entry(14, 'subjects/deeper/wider/four-leaf.md'),
  ],
  issues: [],
});
async function choose(page: Page, root = index(), notify = true) {
  await page.evaluate((root) => {
    window.readerFixture.workingFolder(root);
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 900,
          revision: 1,
          name: 'kept.log',
          location: 'fixture/kept.log',
          format: 'text',
          source: 'kept',
        },
      },
    });
    return window.readerFixture.menu('open');
  }, root);
  await expect(page.getByRole('article', { name: 'kept.log' })).toBeFocused();
  if (!notify) {
    // The index subscription is down; the documented recovery is focus.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  }
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('Folder loaded');
}
async function picker(page: Page) {
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  const input = page.getByRole('combobox', { name: 'File name or path' });
  await expect(input).toBeFocused();
  return input;
}
const options = (page: Page) =>
  page.getByRole('listbox', { name: 'Files and folders' }).getByRole('option');
async function tick(page: Page) {
  await page.clock.runFor(200);
}
async function open(
  page: Page,
  source = '# Kept\n\n<details><summary>Details</summary>Kept body</details>',
  folder: FileIndex | null = null,
) {
  await page.evaluate(
    ({ source, folder }) => {
      window.readerFixture.workingFolder(folder);
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: 1,
            revision: 1,
            name: 'kept.md',
            location: 'fixture/kept.md',
            format: 'markdown',
            source,
          },
        },
      });
      return window.readerFixture.menu('open');
    },
    { source, folder },
  );
  await expect(page.getByRole('article', { name: 'kept.md' })).toBeFocused();
}
test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
  expect(await page.evaluate(() => window.readerFixture.listenerCount())).toBe(
    0,
  );
  expect(await page.evaluate(() => window.readerFixture.activeWorkers())).toBe(
    0,
  );
});
test('manual refresh settles through cached getters when only index notifications fail, without focus or duplicate scans', async ({
  page,
}) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html?index-failure`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(4);
  await choose(page, index(), false);
  await open(page);
  const article = await page.getByRole('article').elementHandle();
  const input = await picker(page);
  await input.fill('alpha');
  await tick(page);
  await expect(options(page)).toHaveCount(1);
  const before = await page.evaluate(() => window.readerFixture.indexGets());
  await page.evaluate((root) => {
    window.readerFixture.enqueue('refresh_index', {
      value: window.readerFixture.indexSnapshot(root, 'loading'),
    });
  }, index());
  const refresh = page.getByRole('button', {
    name: 'Refresh folder',
    exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(options(page)).toHaveCount(0);
  await expect(input).toHaveValue('alpha');
  const loadingFocus = await page.evaluateHandle(() => document.activeElement);
  const usableFocus = await loadingFocus.evaluate(
    (node) =>
      !!node?.closest('dialog') &&
      !node.matches(':disabled') &&
      !node.closest('[hidden]'),
  );
  await page.clock.runFor(499);
  expect(await page.evaluate(() => window.readerFixture.indexGets())).toBe(
    before,
  );
  const current = { ...index(2), entries: [entry(22, 'alpha-latest.md')] };
  // This updates the backend double; its event has no subscribed index handler.
  await page.evaluate(
    (root) =>
      window.readerFixture.indexEvent(window.readerFixture.indexSnapshot(root)),
    current,
  );
  await page.clock.runFor(1);
  await expect(refresh).toBeEnabled();
  await tick(page);
  await expect(options(page)).toContainText('alpha-latest.md');
  await expect(input).toHaveValue('alpha');
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('dialog')),
    )
    .toBe(true);
  if (usableFocus)
    expect(
      await loadingFocus.evaluate((node) => node === document.activeElement),
    ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.indexGets())).toBe(
    before + 1,
  );
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'refresh_index',
    ),
  ).toHaveLength(1);
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.readerFixture.indexGets())).toBe(
    before + 1,
  );
  expect(
    await article.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await loadingFocus.dispose();
  await article.dispose();
});
test('Ctrl+K and Ctrl+O open from the keyboard off macOS and are never claimed on macOS', async ({
  page,
}) => {
  await open(page);
  // The capture listener reads the platform per keypress, so one page pins
  // both sides of the ownership matrix in every engine: WebView2 consumes
  // Ctrl-combinations on Windows and the GTK delivery gap deadens them on
  // Linux, so the frontend must answer these keys itself, while macOS
  // accelerators keep owning them.
  const setPlatform = (platform: string) =>
    page.evaluate((value) => {
      Object.defineProperty(Navigator.prototype, 'platform', {
        value,
        configurable: true,
      });
    }, platform);
  await setPlatform('Windows NT 10.0');
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'File name or path' });
  await expect(input).toBeFocused();
  // Already open: the repeated chord re-enters the same surface instead of
  // stacking another one.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Quick Open' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  // Ctrl+O routes through the same Open File entry as the menu item.
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 2,
          revision: 1,
          name: 'opened.md',
          location: 'fixture/opened.md',
          format: 'markdown',
          source: '# Opened by the keyboard\n',
        },
      },
    });
  });
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('article', { name: 'opened.md' })).toBeVisible();
  // macOS: the frontend claims neither chord under any modifier arrangement.
  await setPlatform('MacIntel');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Quick Open' })).toBeHidden();
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: 'Quick Open' })).toBeHidden();
  await page.keyboard.press('Meta+o');
  // One initial menu open plus exactly one keyboard open: no duplicate
  // Open File requests from a repeated claim.
  const opens = (
    await page.evaluate(() => window.readerFixture.calls())
  ).filter((call) => call.command === 'select_document');
  expect(opens).toHaveLength(2);
});
test('native action focuses once, debounces cache queries, file Tab hands off after dismissal exactly once', async ({
  page,
}) => {
  await choose(page);
  await open(page);
  await page
    .getByRole('button', { name: 'Open alpha.md', exact: true })
    .focus();
  const input = await picker(page);
  await input.fill('a');
  await input.fill('alph');
  await page.clock.runFor(199);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'query_index',
    ),
  ).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(options(page)).toHaveCount(1);
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await expect(input).toHaveValue('alph');
  await expect(input).toBeFocused();
  await input.press('Tab');
  await expect(options(page).filter({ hasText: 'alpha.md' })).toBeFocused();
  await page.evaluate(() => {
    window.readerFixture.enqueue('open_index_entry', {
      hold: 'picker-handoff',
    });
  });
  await options(page).filter({ hasText: 'alpha.md' }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('picker-handoff');
  await expect(page.getByLabel('Reader recovery')).toContainText(
    'Opening alpha.md in another reader',
  );
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'open_index_entry',
    ),
  ).toHaveLength(1);
  expect(
    (await page.evaluate(() => window.readerFixture.openings())).at(-1),
  ).toMatchObject({
    command: 'open_index_entry',
    dialog: false,
    focused: 'kept.md',
  });
  await page.evaluate(() => {
    window.readerFixture.release('picker-handoff', {
      value: { status: 'handedOff' },
    });
  });
  await expect(page.getByRole('article', { name: 'kept.md' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'kept.md' })).toBeFocused();
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  // One fixture commit established the working folder, one opened kept.md.
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'commit_document',
    ),
  ).toHaveLength(2);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).find(
      (call) => call.command === 'open_index_entry',
    )?.payload,
  ).toMatchObject({ newWindow: true });
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'refresh_index',
    ),
  ).toHaveLength(0);
});
test('directory Tab changes only picker location; ordinary Tab and Shift+Tab reach actions; composition and 229 never activate or dismiss', async ({
  page,
}) => {
  await choose(page);
  await open(page);
  const input = await picker(page);
  await tick(page);
  await expect(options(page).first()).toContainText('Folder');
  await input.press('Tab');
  await expect(input).toHaveValue('folder/');
  await expect(input).toBeFocused();
  await tick(page);
  await expect(options(page)).toContainText('Plain text file');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.press('Escape');
  await input.press('Tab');
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await expect(page.getByRole('dialog', { name: 'Quick Open' })).toBeVisible();
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await input.dispatchEvent('keydown', { key: 'Escape', keyCode: 229 });
  expect(
    await page
      .getByRole('button', { name: 'Close', exact: true })
      .evaluate((button) => {
        const event = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          keyCode: 229,
        });
        return !button.dispatchEvent(event);
      }),
  ).toBe(true);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'open_index_entry',
    ),
  ).toHaveLength(0);
  await input.focus();
  await input.press('Tab');
  await expect(options(page)).toBeFocused();
  await options(page).press('Tab');
  await expect(
    page.getByRole('button', { name: 'Refresh folder', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Refresh folder', exact: true })
    .press('Shift+Tab');
  await expect(options(page)).toBeFocused();
  await input.focus();
  await input.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Close', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Close', exact: true })
    .press('Escape');
  await expect(page.getByRole('article', { name: 'kept.md' })).toBeFocused();
});
test('no-document and outside typing grant nothing; native chooser cancellation retains text and explicit file choice really commits', async ({
  page,
}) => {
  let input = await picker(page);
  await input.fill('~/outside/');
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText(
    'Open a file to search its folder.',
  );
  await expect(
    page.getByRole('button', { name: 'Choose Folder…' }),
  ).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'query_index',
    ),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await choose(page);
  input = await picker(page);
  await input.fill('/outside/');
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText(
    'This location needs permission',
  );
  // Typing never opens anything; the one select_document call is the
  // working-folder fixture document opened by choose().
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'select_document',
    ),
  ).toHaveLength(1);
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'chooser' });
  });
  await page.getByRole('button', { name: 'Choose File…', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('chooser');
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('chooser', { value: { status: 'cancelled' } });
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('/outside/');
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 3,
          revision: 3,
          name: 'explicit.log',
          location: 'fixture/explicit.log',
          format: 'text',
          source: '<literal>',
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Choose File…', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'explicit.log' }),
  ).toBeFocused();
  await expect(page.getByRole('article')).toContainText('<literal>');
  expect(
    (await page.evaluate(() => window.readerFixture.openings())).every(
      (call) => !call.dialog,
    ),
  ).toBe(true);
});
test('a settled adoption failure says the folder is gone instead of claiming an indexing pass forever', async ({
  page,
}) => {
  // The document committed but its folder could not be adopted (deleted,
  // renamed or no longer grantable between the read and the adoption): the
  // native side marks the status unavailable with no root to retain.
  await open(page);
  await page.evaluate(() =>
    window.readerFixture.indexEvent(
      window.readerFixture.indexSnapshot(
        null,
        'unavailable',
        'folder vanished',
      ),
    ),
  );
  await picker(page);
  await expect(page.getByRole('dialog')).toContainText(
    'Folder unavailable (folder vanished)',
  );
  await expect(page.getByRole('dialog')).not.toContainText(
    'Indexing this folder',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // The explorer carries the same honest degradation instead of the
  // no-document hint.
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('Folder unavailable (folder vanished)');
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).not.toContainText('Open a document to browse its folder.');
  await expect(page.getByRole('article', { name: 'kept.md' })).toBeVisible();
});
test('opening a file indexes its folder for Quick Open with no separate indexing step, and Enter opens a nested match', async ({
  page,
}) => {
  await open(page, undefined, subtree());
  const input = await picker(page);
  await expect(page.getByRole('dialog')).toContainText(
    'fixture/displayed-folder',
  );
  // The working folder exists as soon as the document committed: no derived
  // scope command and no indexing error can occur. Only sibling enumeration
  // of the fixture document has run.
  const nav = await page.evaluate(() => window.readerFixture.navigationCalls());
  expect(nav.every((call) => call.command === 'get_siblings')).toBe(true);
  await input.fill('four');
  await tick(page);
  const leaf = options(page).filter({ hasText: 'four-leaf.md' });
  await expect(leaf).toHaveCount(1);
  await expect(leaf).toContainText('Markdown file');
  await page.evaluate(() => {
    window.readerFixture.enqueue('open_index_entry', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 2,
          revision: 1,
          name: 'four-leaf.md',
          location:
            'fixture/displayed-folder/subjects/deeper/wider/four-leaf.md',
          format: 'markdown',
          source: '# Four',
        },
      },
    });
  });
  await input.press('Enter');
  await expect(
    page.getByRole('article', { name: 'four-leaf.md' }),
  ).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).find(
      (call) => call.command === 'open_index_entry',
    )?.payload,
  ).toMatchObject({ binding: { scope: 20, revision: 3 } });
});
test('the working folder covers its indexed subtree and the picker reads the root index directly', async ({
  page,
}) => {
  await choose(page, {
    ...index(),
    entries: [
      entry(1, 'folder', 'directory'),
      entry(2, 'alpha.md'),
      entry(3, 'folder/beta.log', 'text'),
      entry(9, 'one/two/three/four/deep-leaf.md'),
    ],
  });
  const input = await picker(page);
  await input.fill('deep-leaf');
  await tick(page);
  await expect(
    options(page).filter({ hasText: 'one/two/three/four/deep-leaf.md' }),
  ).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('fixture/authorized');
  // The searched scope is the already-published working folder; no
  // additional indexing call exists at all.
  const nav = await page.evaluate(() => window.readerFixture.navigationCalls());
  expect(nav.every((call) => call.command === 'get_siblings')).toBe(true);
});
test('a new working folder published while the picker is open replaces the searched scope without reading a document', async ({
  page,
}) => {
  await choose(page);
  const input = await picker(page);
  await input.fill('alpha');
  await tick(page);
  const next = {
    ...index(2),
    scope: 40,
    name: 'fixture/new-root',
    entries: [entry(22, 'alpha-new.md')],
  };
  await page.evaluate(
    (next) =>
      window.readerFixture.indexEvent(window.readerFixture.indexSnapshot(next)),
    next,
  );
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('alpha');
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText('fixture/new-root');
  await expect(options(page)).toContainText('alpha-new.md');
  // No index entry was read to replace the displayed document; the single
  // select_document call is the working-folder fixture document.
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'open_index_entry',
    ),
  ).toHaveLength(0);
});
test('held old query cannot overwrite latest revision, Unicode highlights and 100-cap are announced; cache events retain article nodes', async ({
  page,
}) => {
  await choose(page);
  await open(page);
  const article = await page.getByRole('article').elementHandle();
  await page.getByText('Details', { exact: true }).click();
  const input = await picker(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('query_index', { hold: 'old-query' });
  });
  await input.fill('old');
  await tick(page);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('old-query');
  await input.fill('😀');
  await tick(page);
  await expect(page.locator('.quick-match')).toHaveText('😀');
  const next = { ...index(2), entries: [entry(50, '😀new.md')] };
  await page.evaluate(
    (next) =>
      window.readerFixture.indexEvent(window.readerFixture.indexSnapshot(next)),
    next,
  );
  await expect(options(page)).toHaveCount(0);
  await tick(page);
  await expect(options(page)).toContainText('😀new.md');
  await page.evaluate(() => {
    const call = window.readerFixture
      .calls()
      .find((call) => call.command === 'query_index');
    const request = (call?.payload as { request: QueryRequest }).request;
    window.readerFixture.release('old-query', {
      value: window.readerFixture.queryReply(request),
    });
  });
  await expect(input).toHaveValue('😀');
  await expect(options(page)).toContainText('😀new.md');
  expect(
    await article.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  const many = {
    ...index(3),
    entries: Array.from({ length: 120 }, (_, number) =>
      entry(number + 100, `file-${String(number)}.md`),
    ),
  };
  await page.evaluate(
    (many) =>
      window.readerFixture.indexEvent(window.readerFixture.indexSnapshot(many)),
    many,
  );
  await input.fill('file');
  await tick(page);
  await expect(options(page)).toHaveCount(100);
  await expect(page.getByRole('dialog')).toContainText(
    'Showing first 100 results of 120',
  );
  const active = await input.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  expect(await page.locator(`[id="${active ?? ''}"]`).count()).toBe(1);
  await input.press('Escape');
  await expect(page.locator('article details')).toHaveAttribute('open', '');
  await article.dispose();
});
test('indexing, empty, no-match, partial, degraded and unavailable stay distinct with no active document reload', async ({
  page,
}) => {
  await choose(page);
  const input = await picker(page);
  const empty = { ...index(2), entries: [] };
  await page.evaluate(
    (empty) =>
      window.readerFixture.indexEvent(
        window.readerFixture.indexSnapshot(empty, 'loading'),
      ),
    empty,
  );
  await expect(page.getByRole('dialog')).toContainText('Indexing folder');
  await expect(options(page)).toHaveCount(0);
  await page.evaluate(
    (empty) =>
      window.readerFixture.indexEvent(
        window.readerFixture.indexSnapshot(empty),
      ),
    empty,
  );
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText(
    'No supported files in this folder',
  );
  await input.fill('missing');
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText(
    'No files match missing',
  );
  await page.evaluate(
    (root) => {
      const snapshot = window.readerFixture.indexSnapshot(root, 'partial');
      snapshot.status.degraded = true;
      return window.readerFixture.indexEvent(snapshot);
    },
    {
      ...index(3),
      issues: [
        { relative: 'denied', code: 'denied', message: 'Subfolder denied' },
      ],
    },
  );
  await tick(page);
  await expect(page.getByRole('dialog')).toContainText(
    'results are incomplete',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Live updates unavailable; periodic refresh continues',
  );
  await page.evaluate(
    (root) =>
      window.readerFixture.indexEvent(
        window.readerFixture.indexSnapshot(
          root,
          'unavailable',
          'Folder removed',
        ),
      ),
    index(4),
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Folder unavailable (Folder removed)',
  );
  // No index entry was read to replace the displayed document; the single
  // select_document call is the working-folder fixture document.
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'open_index_entry',
    ),
  ).toHaveLength(0);
});
test('query and watch-only publications retain playing media, diagram controls, selection, disclosures and reading scroll', async ({
  page,
}) => {
  await page.clock.resume();
  const tone = readFileSync(new URL('./media/tone.wav', import.meta.url));
  await page.route('http://reader-media.localhost/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: tone });
  });
  await choose(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('resolve_media', {
      value: { id: '0'.repeat(31) + '2', mime: 'audio/wav' },
    });
  });
  await open(
    page,
    '# Kept\n\nPreserved selection text.\n\n<audio src="tone.wav"></audio>\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n<details><summary>Details</summary>Kept body</details>\n\n' +
      'Long reading paragraph. '.repeat(1000),
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  const article = await page.getByRole('article').elementHandle();
  const figure = await page.locator('.diagram').elementHandle();
  const control = await page
    .getByRole('button', { name: 'Interact with diagram 1' })
    .elementHandle();
  const audio = await page.locator('article audio').elementHandle();
  await page
    .locator('article audio')
    .evaluate(async (node: HTMLAudioElement) => {
      node.loop = true;
      node.muted = true;
      await node.play();
    });
  await page.getByText('Details', { exact: true }).click();
  await page.evaluate(() => {
    const paragraph = document.querySelector('article p');
    if (!paragraph) throw new Error('Selection paragraph missing');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.querySelector('main')?.scrollTo(0, 600);
  });
  const before = await page.evaluate(() => ({
    selection: getSelection()?.toString(),
    scroll: document.querySelector('main')?.scrollTop,
  }));
  // A fixed future virtual boundary avoids racing the running clock across IPC.
  await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
  const input = await picker(page);
  await input.fill('alpha');
  await tick(page);
  await page.evaluate(
    (root) =>
      window.readerFixture.indexEvent(window.readerFixture.indexSnapshot(root)),
    index(2),
  );
  await tick(page);
  await input.press('Escape');
  expect(
    await article.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(
    await figure.evaluate(
      (node) => node === document.querySelector('.diagram'),
    ),
  ).toBe(true);
  expect(await control.evaluate((node) => node.isConnected)).toBe(true);
  expect(
    await audio.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  expect(
    await page
      .locator('article audio')
      .evaluate((node: HTMLAudioElement) => node.paused),
  ).toBe(false);
  await expect(
    page.locator('article details').filter({ hasText: 'Kept body' }),
  ).toHaveAttribute('open', '');
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    before.selection,
  );
  expect(
    await page.evaluate(() => document.querySelector('main')?.scrollTop),
  ).toBe(before.scroll);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'resolve_media',
    ),
  ).toHaveLength(1);
  await article.dispose();
  await figure.dispose();
  await control.dispose();
  await audio.dispose();
});
test('logical native Save without a DOM surface rejects Quick Open and queues nothing', async ({
  page,
}) => {
  await page.clock.resume();
  await open(page, '# Diagram\n\n```mermaid\nflowchart LR\n A --> B\n```');
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', { hold: 'native-save' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('native-save');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('native-save', {
      value: { status: 'cancelled' },
    });
  });
  await expect(page.getByLabel('Reader recovery')).toContainText('cancelled');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('all palettes in both slots keep narrow/short full paths, input, match and focus independent of article zoom', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 640, height: 520 });
  const long = {
    ...index(),
    entries: [entry(2, `${'nested-long-path/'.repeat(8)}alpha.md`)],
  };
  await choose(page, long);
  await open(page);
  const input = await picker(page);
  await input.fill('alpha');
  await tick(page);
  const geometry: unknown[] = [];
  let revision = 10;
  for (const mode of ['light', 'dark'] as const)
    for (const [palette] of palettes) {
      const zoom = mode === 'light' ? 50 : 300;
      await page.evaluate(
        ({ revision, mode, palette, zoom }) => {
          const current = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...current,
            revision,
            settings: {
              ...current.settings,
              mode,
              lightPalette: palette,
              darkPalette: palette,
              pageZoom: zoom,
            },
          });
        },
        { revision: revision++, mode, palette, zoom },
      );
      await expect(page.locator('html')).toHaveAttribute(
        'data-palette',
        palette,
      );
      await expect(input).toBeFocused();
      const bounds = await input.boundingBox();
      expect(bounds?.width).toBeGreaterThan(300);
      expect(bounds?.height).toBeGreaterThan(25);
      const value = await page.evaluate(() => {
        const input = document.querySelector('#quick-query');
        const row = document.querySelector('[role="option"]');
        const dialog = document.querySelector('dialog');
        const match = document.querySelector('.quick-match');
        const box = (element: Element | null) => {
          if (!element) return null;
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          inputFont: input && getComputedStyle(input).fontSize,
          row: box(row),
          dialog: box(dialog),
          matchedWeight: match && getComputedStyle(match).fontWeight,
          matchedDecoration:
            match && getComputedStyle(match).textDecorationLine,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(value.overflow).toBe(false);
      expect(value.matchedDecoration).toContain('underline');
      expect(Number.parseFloat(value.inputFont ?? '0')).toBeLessThan(20);
      geometry.push({ mode, palette, zoom, bounds, ...value });
      await page.screenshot({
        path: info.outputPath(`quick-${mode}-${palette}.png`),
      });
    }
  writeFileSync(
    info.outputPath('quick-geometry.json'),
    JSON.stringify(
      {
        boundary:
          'Browser App/native transport double; not system-webview certification',
        engine: info.project.name,
        geometry,
      },
      null,
      2,
    ),
  );
});
