import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { palettes } from '../../src/settings/model';
import type { Snapshot } from '../../src/types';

const bar = (page: Page) =>
  page.getByRole('region', { name: 'Find in document', exact: true });
const input = (page: Page) =>
  page.getByRole('textbox', { name: 'Find in document', exact: true });
async function find(page: Page, query?: string) {
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(input(page)).toBeFocused();
  if (query !== undefined) await input(page).fill(query);
  return input(page);
}
async function open(
  page: Page,
  source: string,
  format: Snapshot['format'] = 'markdown',
  id = 1,
) {
  await page.evaluate(
    ({ source, format, id }) => {
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: id,
            revision: id,
            name: format === 'text' ? 'find.log' : 'find.md',
            location: 'fixture/find',
            format,
            source,
          },
        },
      });
      return window.readerFixture.menu('open');
    },
    { source, format, id },
  );
  await expect(page.getByRole('article')).toBeFocused();
}
async function result(page: Page, value: string) {
  await expect(bar(page).getByRole('status')).toHaveText(value);
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
  expect(await page.evaluate(() => window.readerFixture.listenerCount())).toBe(
    0,
  );
  expect(await page.evaluate(() => window.readerFixture.activeWorkers())).toBe(
    0,
  );
});

test('one literal Unicode map counts cross-inline matches once and wraps exactly with native, query and button keys', async ({
  page,
}) => {
  await open(
    page,
    '---\nkey: "Needle . [x]*"\n---\n# Needle\n\nab**cd**[ef](#needle) needle . [x]* İ😀 K ſ\n\n```js\nconst needle = ". [x]*";\n```\n\n<details><summary>Needle summary</summary>hiddenneedle</details>',
  );
  const query = await find(page, 'needle');
  await result(page, '1 of 5');
  await query.press('Shift+Enter');
  await result(page, '5 of 5');
  await query.press('Enter');
  await result(page, '1 of 5');
  await page.evaluate(() => window.readerFixture.menu('find-previous'));
  await result(page, '5 of 5');
  await page.evaluate(() => window.readerFixture.menu('find-next'));
  await result(page, '1 of 5');
  await page
    .getByRole('button', { name: 'Next match', exact: true })
    .press('Enter');
  await result(page, '2 of 5');
  await page
    .getByRole('button', { name: 'Previous match', exact: true })
    .click();
  await result(page, '1 of 5');
  await find(page);
  await expect(query).toHaveValue('needle');
  expect(
    await query.evaluate((node: HTMLInputElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([0, 6]);
  await query.fill('abcdef');
  await result(page, '1 of 1');
  await expect(page.locator('article .find-match')).toHaveCount(3);
  await expect(page.locator('article .find-current')).toHaveCount(3);
  for (const [text, count] of [
    ['.', 3],
    ['[x]*', 3],
    ['😀', 1],
    ['k', 2],
    ['ss', 0],
  ] as const) {
    await query.fill(text);
    await result(page, count ? `1 of ${String(count)}` : 'No matches');
  }
  await query.fill('');
  await result(page, 'Type to find in this document');
  await expect(page.locator('article .find-match')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Next match', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    await page.evaluate(() => window.readerFixture.presentation()),
  ).toMatchObject({ findAvailable: true, findMatches: false, modal: 'none' });
});

test('actual computed visibility, details, display contents and whitespace rebuild together without phantom block matches', async ({
  page,
}) => {
  await open(
    page,
    '<p>ab<strong>cd</strong>  \n ef</p><p>gh</p><p>ij<br>kl</p><ul><li>mn</li><li>op</li></ul><table><tr><td>qr</td><td>st</td></tr></table><p><span>visiblechild</span></p><p>displaycontents</p><p>hiddenword</p><p>inertword</p><details><summary>summaryword</summary><p>detailword</p></details>\n\n```text\npre  space\nline\n```',
  );
  // Author CSS stays forbidden. These controlled DOM changes test the real
  // browser visibility seam that trusted generated CSS/layout can also change.
  await page.evaluate(() => {
    const ps = [...document.querySelectorAll<HTMLElement>('article p')];
    const child = ps.find((p) => p.textContent === 'visiblechild');
    if (child) {
      child.style.visibility = 'hidden';
      const span = child.querySelector('span');
      if (span) span.style.visibility = 'visible';
    }
    const contents = ps.find((p) => p.textContent === 'displaycontents');
    if (contents) contents.style.display = 'contents';
    const hidden = ps.find((p) => p.textContent === 'hiddenword');
    if (hidden) hidden.style.display = 'none';
    const inert = ps.find((p) => p.textContent === 'inertword');
    inert?.setAttribute('inert', '');
  });
  const query = await find(page);
  for (const text of [
    'abcd ef',
    'visiblechild',
    'displaycontents',
    'summaryword',
    'pre  space',
  ]) {
    await query.fill(text);
    await result(page, '1 of 1');
  }
  for (const text of [
    'efgh',
    'ghij',
    'ijkl',
    'mnop',
    'qrst',
    'pre space',
    'hiddenword',
    'inertword',
    'detailword',
  ]) {
    await query.fill(text);
    await result(page, 'No matches');
  }
  const before = await page.evaluate(
    () => document.querySelector('main')?.scrollTop,
  );
  await page.locator('article details').evaluate((node: HTMLDetailsElement) => {
    node.open = true;
  });
  await result(page, '1 of 1');
  expect(
    await page.evaluate(() => document.querySelector('main')?.scrollTop),
  ).toBe(before);
  await page.locator('article details').evaluate((node: HTMLDetailsElement) => {
    node.open = false;
  });
  await result(page, 'No matches');
  await query.fill('hiddenword');
  await page.evaluate(() => {
    for (const p of document.querySelectorAll('article p'))
      if (p.textContent === 'hiddenword') p.removeAttribute('style');
  });
  await result(page, '1 of 1');
});

test('raw metadata, late media feedback and actual Mermaid publication invalidate only the visible article', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.enqueue('resolve_media', { hold: 'late-media' });
    window.readerFixture.holdDiagram();
  });
  await open(
    page,
    `---\n${'['.repeat(20)}rawsentinel${']'.repeat(20)}\n---\n# Body\n\n![image](missing.png)\n\n\`\`\`mermaid\nflowchart LR\n A[diagramsecret] --> B\n\`\`\`\n`,
  );
  const query = await find(page, 'rawsentinel');
  await result(page, 'No matches');
  await page
    .locator('.metadata details')
    .evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
  await result(page, '1 of 1');
  await query.fill('View raw metadata');
  await result(page, 'No matches');
  await query.fill('file not found');
  await result(page, 'No matches');
  await page.evaluate(() => {
    window.readerFixture.release('late-media', {
      error: { code: 'notFound', message: 'missing' },
    });
  });
  await result(page, '1 of 1');
  await page.locator('article img').dispatchEvent('load');
  await result(page, 'No matches');
  await query.fill('diagramsecret');
  await result(page, 'No matches');
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.diagrams().held))
    .toBe(true);
  await page.evaluate(() => {
    window.readerFixture.releaseDiagram();
  });
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await result(page, 'No matches');
  await page
    .locator('.diagram details')
    .evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
  await result(page, 'No matches');
  const figure = await page.locator('.diagram').elementHandle();
  await page.evaluate(() => {
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: { ...record.settings, mode: 'dark', darkPalette: 'nord' },
    });
  });
  await expect(page.locator('.diagram')).toHaveAttribute(
    'data-palette',
    'nord',
  );
  expect(
    await figure.evaluate(
      (node) => node === document.querySelector('.diagram'),
    ),
  ).toBe(true);
  await result(page, 'No matches');
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await figure.dispose();
});

test('literal text reload and replacement retire old owned data, failed targets retain last good, empty file has no placeholder corpus', async ({
  page,
}) => {
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await open(page, '# <b>😀 . [x]*</b> old old', 'text');
  let query = await find(page, 'old');
  await result(page, '1 of 2');
  await page.evaluate(() => {
    const snapshot = window.readerFixture.state().displayed?.snapshot;
    if (!snapshot) throw new Error('missing snapshot');
    window.readerFixture.enqueue('reload_document', {
      value: { ...snapshot, revision: 2, source: 'new new . [x]* 😀' },
    });
    return window.readerFixture.menu('reload');
  });
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('pre.literal')).toHaveText('new new . [x]* 😀');
  query = await find(page);
  await expect(query).toHaveValue('old');
  await result(page, 'No matches');
  await query.fill('new');
  await result(page, '1 of 2');
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: { code: 'notFound', message: 'Attempted missing target' },
    });
    return window.readerFixture.menu('open');
  });
  await expect(page.getByLabel('Reader recovery')).toContainText(
    'Attempted missing target',
  );
  query = await find(page);
  await expect(query).toHaveValue('new');
  await result(page, '1 of 2');
  await open(page, '', 'text', 3);
  await find(page, 'This file is empty');
  await result(page, 'No matches');
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(0);
  expect(
    await page.evaluate(
      () => window.readerFixture.state().displayed?.snapshot.source,
    ),
  ).toBe('');
});

test('nonmodal keys respect modifiers, IME, 229, button activation and natural Tab; dialog and picker handoffs preserve the pre-surface origin', async ({
  page,
}) => {
  await open(
    page,
    '# Origin\n\n<a href="#origin">reading link</a> needle needle',
  );
  const link = page.getByRole('link', { name: 'reading link' });
  await link.focus();
  let query = await find(page, 'needle');
  await query.press('Control+Enter');
  await result(page, '1 of 2');
  await query.press('Shift+Escape');
  await expect(bar(page)).toBeVisible();
  await query.dispatchEvent('compositionstart');
  await query.press('Enter');
  await query.press('Escape');
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await page.evaluate(() => window.readerFixture.menu('guide'));
  await result(page, '1 of 2');
  await page.evaluate(() => window.readerFixture.menu('find-next'));
  await result(page, '1 of 2');
  await query.dispatchEvent('compositionend');
  await query.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await query.dispatchEvent('keydown', { key: 'Escape', keyCode: 229 });
  await result(page, '1 of 2');
  await find(page);
  await query.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Previous match', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await link.press('Escape');
  await expect(bar(page)).toBeVisible();
  for (const surface of [
    'settings',
    'guide',
    'information',
    'about',
    'quick-open',
  ] as const) {
    await page.evaluate(
      (surface) => window.readerFixture.menu(surface),
      surface,
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    query = await find(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(query).toHaveValue('needle');
    await query.press('Escape');
    await expect(link).toBeFocused();
    await find(page);
  }
  const calls = await page.evaluate(() => window.readerFixture.calls());
  expect(calls.filter((call) => call.command === 'query_index')).toHaveLength(
    0,
  );
  await query.press('Escape');
  await expect(link).toBeFocused();
  await link.focus();
  await find(page);
  await link.evaluate((node) => {
    node.style.visibility = 'hidden';
  });
  await input(page).press('Escape');
  await expect(page.getByRole('article')).toBeFocused();
});

test('native chooser, pending read/commit and logical native Save never queue Find or strand Cancel', async ({
  page,
}) => {
  await open(
    page,
    '# Busy\n\nneedle\n\n```mermaid\nflowchart LR\n A --> B\n```',
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await find(page, 'needle');
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', { hold: 'save' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('save');
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('save', { value: { status: 'cancelled' } });
  });
  await expect(page.getByLabel('Reader recovery')).toContainText(
    'Export cancelled',
  );
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'chooser' });
    return window.readerFixture.menu('open');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('chooser');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.readerFixture.release('chooser', { value: { status: 'cancelled' } });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('ready');
  await page.evaluate(() => {
    window.readerFixture.enqueue('reload_document', { hold: 'read' });
    return window.readerFixture.menu('reload');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('read');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    const snapshot = window.readerFixture.state().displayed?.snapshot;
    window.readerFixture.release('read', { value: snapshot });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('ready');
  await page.evaluate(() => {
    const snapshot = window.readerFixture.state().displayed?.snapshot;
    if (!snapshot) throw new Error('missing');
    window.readerFixture.enqueue('reload_document', {
      value: { ...snapshot, revision: 2 },
    });
    window.readerFixture.enqueue('commit_document', { hold: 'commit' });
    return window.readerFixture.menu('reload');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('commit');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('commit', { value: null });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('ready');
  await expect(bar(page)).toHaveCount(0);
});

test('owned marks retain playing media, diagram/link/Text identities, directional selection and non-navigation scroll across queries and close', async ({
  page,
}) => {
  const tone = readFileSync(new URL('./media/tone.wav', import.meta.url));
  await page.route('http://reader-media.localhost/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: tone });
  });
  await page.evaluate(() => {
    window.readerFixture.enqueue('resolve_media', {
      value: { id: '0'.repeat(31) + '2', mime: 'audio/wav' },
    });
  });
  await open(
    page,
    '# Keep\n\nPreserved **selection** text.\n\n<audio src="tone.wav"></audio>\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n<details><summary>Details</summary>body</details>\n\n' +
      'Long reading paragraph. '.repeat(1000),
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await page
    .locator('article audio')
    .evaluate(async (node: HTMLAudioElement) => {
      node.muted = true;
      node.loop = true;
      await node.play();
    });
  await page
    .locator('article details')
    .first()
    .evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
  const handles = await page.evaluateHandle(() => {
    const article = document.querySelector('article');
    const paragraph = article?.querySelector('p');
    if (!article || !paragraph) throw new Error('missing article');
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    return {
      article,
      audio: article.querySelector('audio'),
      source: article.querySelector('audio source'),
      figure: article.querySelector('.diagram'),
      control: article.querySelector('.diagram button'),
      svg: article.querySelector('.diagram svg'),
      texts,
      data: texts.map((t) => t.data),
    };
  });
  for (const backward of [false, true]) {
    await handles.evaluate(({ texts }, backward) => {
      const first = texts[0];
      const last = texts.at(-1);
      if (!last) throw new Error('missing texts');
      getSelection()?.setBaseAndExtent(
        backward ? last : first,
        1,
        backward ? first : last,
        2,
      );
      document.querySelector('main')?.scrollTo(0, 600);
    }, backward);
    const before = await page.evaluate(() => ({
      selection: getSelection()?.toString(),
      scroll: document.querySelector('main')?.scrollTop,
    }));
    const query = await find(page);
    await query.fill('Preserved selection text');
    await result(page, '1 of 1');
    // Inputs have their own native selection. Retained reading endpoints are
    // checked after dismissal; matching must not steal the input's caret/focus.
    await expect(query).toBeFocused();
    const fixedScroll = await page.evaluate(() => {
      const scroller = document.querySelector('main');
      scroller?.scrollTo(0, 600);
      return scroller?.scrollTop;
    });
    await query.fill('no such reading text');
    await result(page, 'No matches');
    expect(
      await page.evaluate(() => document.querySelector('main')?.scrollTop),
    ).toBe(fixedScroll);
    await page.evaluate(async () => {
      await window.readerFixture.menu('status-bar');
      const record = window.readerFixture.settings();
      await window.readerFixture.settingsEvent({
        ...record,
        revision: record.revision + 1,
        settings: { ...record.settings, mode: 'dark', darkPalette: 'nord' },
      });
      await window.readerFixture.indexEvent(
        window.readerFixture.indexSnapshot(null),
      );
    });
    await result(page, 'No matches');
    await expect(query).toBeFocused();
    expect(
      await page.evaluate(() => document.querySelector('main')?.scrollTop),
    ).toBe(fixedScroll);
    await query.fill('');
    await query.press('Escape');
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(
      before.selection,
    );
    expect(
      await page.evaluate(() => document.querySelector('main')?.scrollTop),
    ).toBe(fixedScroll);
    expect(
      await handles.evaluate(({ texts, data }) =>
        texts.every(
          (text, index) => text.isConnected && text.data === data[index],
        ),
      ),
    ).toBe(true);
  }
  expect(
    await handles.evaluate(
      ({ article, audio, source, figure, control }) =>
        article === document.querySelector('article') &&
        audio === article.querySelector('audio') &&
        source === audio?.querySelector('source') &&
        figure === article.querySelector('.diagram') &&
        control?.isConnected,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('article audio')
      .evaluate((node: HTMLAudioElement) => node.paused),
  ).toBe(false);
  await expect(page.locator('article details').first()).toHaveAttribute(
    'open',
    '',
  );
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'resolve_media',
    ),
  ).toHaveLength(1);
  await handles.dispose();
});

test('latest pointer-selected reading text and direction survive Close focus/click or return-to-input Escape', async ({
  page,
}) => {
  await open(page, '# Origin\n\n<span>alpha</span> **beta** needle');
  const article = page.getByRole('article');
  const alpha = page.locator('article span').filter({ hasText: 'alpha' });
  const beta = page.locator('article strong');
  const originals = await article.evaluateHandle((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    return { texts, data: texts.map((text) => text.data) };
  });
  for (const dismissal of ['close', 'escape'] as const)
    for (const backward of [false, true]) {
      await alpha.dblclick();
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString()))
        .toBe('alpha');
      await article.focus();
      const query = await find(page, 'needle');
      const bounds = await beta.boundingBox();
      if (!bounds) throw new Error('missing beta bounds');
      const left = bounds.x + 0.25;
      const right = bounds.x + bounds.width - 0.25;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(backward ? right : left, y);
      await page.mouse.down();
      await page.mouse.move(backward ? left : right, y, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString()))
        .toBe('beta');
      const selected = await beta.evaluate((node) => {
        const selection = getSelection();
        return {
          anchor: selection?.anchorOffset,
          focus: selection?.focusOffset,
          anchorInBeta: node.contains(selection?.anchorNode ?? null),
          focusInBeta: node.contains(selection?.focusNode ?? null),
        };
      });
      // Browser caret aliases may use the preceding Text's end for beta's
      // start. Assert exact reading offsets/direction, then preserve the actual
      // engine endpoints below rather than requiring one DOM representation.
      expect(
        await beta.evaluate((node) => {
          const paragraph = node.closest('p');
          const selection = getSelection();
          if (!paragraph || !selection?.anchorNode || !selection.focusNode)
            throw new Error('missing reading selection');
          const offset = (endpoint: Node, position: number) => {
            const range = document.createRange();
            range.setStart(paragraph, 0);
            range.setEnd(endpoint, position);
            return range.toString().length;
          };
          return [
            offset(selection.anchorNode, selection.anchorOffset),
            offset(selection.focusNode, selection.focusOffset),
          ];
        }),
      ).toEqual(backward ? [10, 6] : [6, 10]);
      if (dismissal === 'close') {
        const close = page.getByRole('button', {
          name: 'Close find',
          exact: true,
        });
        await close.focus();
        await expect(close).toBeFocused();
        await close.click();
      } else {
        await query.click();
        await expect(query).toBeFocused();
        if (backward) {
          await query.fill('beta');
          await result(page, '1 of 1');
          await query.press('ArrowLeft');
          expect(
            await query.evaluate((node: HTMLInputElement) => [
              node.selectionStart,
              node.selectionEnd,
            ]),
          ).toEqual([3, 3]);
          await query.fill('');
        }
        await query.press('Escape');
      }
      await expect(bar(page)).toHaveCount(0);
      await expect(article).toBeFocused();
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(
        'beta',
      );
      expect(
        await beta.evaluate((node) => {
          const selection = getSelection();
          return {
            anchor: selection?.anchorOffset,
            focus: selection?.focusOffset,
            anchorInBeta: node.contains(selection?.anchorNode ?? null),
            focusInBeta: node.contains(selection?.focusNode ?? null),
          };
        }),
      ).toEqual(selected);
      expect(
        await originals.evaluate(({ texts, data }) =>
          texts.every(
            (text, index) => text.isConnected && text.data === data[index],
          ),
        ),
      ).toBe(true);
      await expect(page.locator('article .find-match')).toHaveCount(0);
    }
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await originals.dispose();
});

test('picker/root native handoffs, parsing and export preparation reject stale Find and retire picker debounce work', async ({
  page,
}) => {
  await open(
    page,
    '# Keep\n\nneedle\n\n```mermaid\nflowchart LR\n A --> B\n```',
  );
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await page.evaluate(() => {
    const index = {
      scope: 7,
      revision: 1,
      name: 'fixture',
      entries: [],
      issues: [],
    };
    window.readerFixture.enqueue('select_root', {
      value: {
        status: 'ready',
        snapshot: window.readerFixture.indexSnapshot(index),
      },
    });
    return window.readerFixture.menu('open-folder');
  });
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('Folder loaded');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  const picker = page.getByRole('combobox', { name: 'File name or path' });
  await picker.fill('queued-query');
  await find(page, 'needle');
  await page.clock.runFor(200);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'query_index',
    ),
  ).toHaveLength(0);
  await page.evaluate(() => window.readerFixture.menu('quick-open'));
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'picker-native' });
  });
  await page.getByRole('button', { name: 'Choose File…', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('picker-native');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('picker-native', {
      value: { status: 'cancelled' },
    });
  });
  await expect(picker).toBeFocused();
  await expect(bar(page)).toHaveCount(0);
  await find(page);
  await input(page).press('Escape');
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_root', { hold: 'root-native' });
    return window.readerFixture.menu('open-folder');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('root-native');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('root-native', {
      value: { status: 'cancelled' },
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.presentation()?.busy))
    .toBe(false);
  await page.evaluate(() => {
    const snapshot = window.readerFixture.state().displayed?.snapshot;
    window.readerFixture.workerMode('hold');
    window.readerFixture.enqueue('reload_document', { value: snapshot });
    return window.readerFixture.menu('reload');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('parsing');
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.state().phase))
    .toBe('ready');
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.activeWorkers()))
    .toBe(0);
  await page.clock.resume();
  await find(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('begin_export', { hold: 'preparing' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('preparing');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => window.readerFixture.menu('find'));
  await expect(bar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    window.readerFixture.release('preparing', { value: 77 });
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Reader recovery')).toContainText(
    'Export cancelled',
  );
  await expect(bar(page)).toHaveCount(0);
});

test('all seven palettes both slots, content zoom and narrow short reserved layout keep marked code and bar legible', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 640, height: 420 });
  await open(
    page,
    '# Needle\n\nneedle\n\n```js\nconst needle = "needle";\n```',
  );
  await find(page, 'needle');
  const geometry: unknown[] = [];
  let revision = 10;
  for (const mode of ['light', 'dark'] as const)
    for (const [palette] of palettes) {
      const zoom = mode === 'light' ? 50 : 300;
      await page.evaluate(
        ({ revision, mode, palette, zoom }) => {
          const record = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...record,
            revision,
            settings: {
              ...record.settings,
              mode,
              lightPalette: palette,
              darkPalette: palette,
              pageZoom: zoom,
              statusVisible: mode === 'light',
            },
          });
        },
        { revision: revision++, mode, palette, zoom },
      );
      await expect(page.locator('html')).toHaveAttribute(
        'data-palette',
        palette,
      );
      await expect(input(page)).toBeFocused();
      await result(page, '1 of 4');
      const value = await page.evaluate(() => {
        const field = document.querySelector('#document-query');
        const bar = document.querySelector('.find-bar');
        const main = document.querySelector('main');
        if (!field || !bar || !main) throw new Error('missing bar');
        return {
          field: field.getBoundingClientRect().toJSON() as {
            width: number;
            height: number;
          },
          barBottom: bar.getBoundingClientRect().bottom,
          mainTop: main.getBoundingClientRect().top,
          overflow: document.documentElement.scrollWidth > innerWidth,
          font: getComputedStyle(field).fontSize,
          marks: [...document.querySelectorAll('.find-match')].map((mark) => ({
            text: getComputedStyle(mark).color,
            background: getComputedStyle(mark).backgroundColor,
            outline: getComputedStyle(mark).outlineStyle,
            underline: getComputedStyle(mark).textDecorationLine,
          })),
        };
      });
      expect(value.overflow).toBe(false);
      expect(value.field.width).toBeGreaterThan(80);
      expect(value.field.height).toBeGreaterThan(25);
      expect(value.barBottom).toBeLessThanOrEqual(value.mainTop + 1);
      expect(parseFloat(value.font)).toBe(16);
      for (const mark of value.marks) {
        expect(mark.text).toBe('rgb(23, 23, 23)');
        expect(mark.background).toBe('rgb(255, 224, 138)');
        expect(mark.underline).toContain('underline');
      }
      expect(value.marks[0].outline).toBe('solid');
      geometry.push({ mode, palette, zoom, ...value });
      await page.screenshot({
        path: info.outputPath(`find-${mode}-${palette}.png`),
      });
    }
  writeFileSync(
    info.outputPath('find-geometry.json'),
    JSON.stringify(
      {
        engine: info.project.name,
        boundary:
          'Browser App and explicit native transport double, not native certification',
        geometry,
      },
      null,
      2,
    ),
  );
});
