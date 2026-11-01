import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { palettes } from '../../src/settings/model';
const example = readFileSync(
  new URL('../../examples/rich-text.md', import.meta.url),
  'utf8',
);
const literal = '<img src="x" onerror="evil()"> & <script>evil()</script>';
const rich = `${example}\n\n## 日本語\n\n[Unicode](#%E6%97%A5%E6%9C%AC%E8%AA%9E) [Missing](#not-here) [Inactive](https://invalid.example/link)\n\n\`\`\`unknown-fence\n${literal}\n\`\`\`\n\nMore[^ref-x] and hostile[^x" onclick="evil()] notes.\n\n[^ref-x]: Second definition\n\n[^x" onclick="evil()]: Third definition\n\n<p id="root" class="hljs-keyword" data-action="open" data-reader-slot="0" style="background:url(https://invalid.example/css)" onclick="window.compromised=true">Safe text</p>\n\n<img src="https://invalid.example/image" srcset="file:///blocked 2x" alt="Remote image" onerror="window.compromised=true">\n\n<video poster="https://invalid.example/poster"><source src="file:///blocked"></video>\n\n<script>window.compromised=true;window.__TAURI_INTERNALS__.invoke('select_document')</script>\n\n${'Reading continues without changing its source. '.repeat(60)}`;
async function open(page: Page, source: string, id = 1) {
  await page.evaluate(
    ({ source, id }) => {
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: id,
            revision: id,
            name: 'rich.md',
            location: 'fixture/rich.md',
            format: 'markdown',
            source,
          },
        },
      });
    },
    { source, id },
  );
  await page.evaluate(() => window.readerFixture.menu('open'));
  await expect(page.getByRole('article')).toBeFocused();
  await expect(
    page.getByRole('region', { name: 'Reader status' }),
  ).toContainText('Opened rich.md.');
}
const screenshotting = new WeakSet<Page>();
const captureDiagnostic =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  extra: object = {},
) {
  const path = process.env.MDVIEWERRSX_APPEARANCE_EVIDENCE
    ? join(
        process.env.MDVIEWERRSX_APPEARANCE_EVIDENCE,
        `${info.project.name}-${name}.png`,
      )
    : info.outputPath(`${name}.png`);
  const diagnostics: string[] = [];
  const observe = (message: { text(): string }) => {
    if (message.text() === captureDiagnostic) diagnostics.push(message.text());
  };
  page.on('console', observe);
  screenshotting.add(page);
  let image: Buffer;
  try {
    image = await page.screenshot({ path, caret: 'initial' });
  } finally {
    screenshotting.delete(page);
    page.off('console', observe);
  }
  await expect(page.locator('style,[style]')).toHaveCount(0);
  writeFileSync(
    `${path}.json`,
    JSON.stringify(
      {
        boundary:
          'Browser only; actual App/controller/worker/sanitizer/native JS adapter; explicit native double',
        browser: info.project.name,
        viewport: page.viewportSize(),
        raster: {
          width: image.readUInt32BE(16),
          height: image.readUInt32BE(20),
        },
        diagnostics,
        ...extra,
      },
      null,
      2,
    ),
  );
  await info.attach(name, { path, contentType: 'image/png' });
}
function contrast(a: string, b: string) {
  function luminance(color: string) {
    const rgb = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!rgb || rgb.length !== 3) throw new Error(`Unexpected color ${color}`);
    const linear = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return (
      (linear[0] ?? 0) * 0.2126 +
      (linear[1] ?? 0) * 0.7152 +
      (linear[2] ?? 0) * 0.0722
    );
  }
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('actual rich worker output, keyboard fragment/footnote round trips, hostile markup and current-document authority', async ({
  page,
}, info) => {
  const external: string[] = [],
    engineMediaImages: string[] = [],
    violations: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // A blocked player still has native controls. WebKit's control shadow UI
    // uses same-origin Blob icons; retain this evidence separately, while all
    // author Blob/data references and fetch-bearing attributes remain inert.
    if (
      info.project.name === 'webkit' &&
      url.protocol === 'blob:' &&
      url.origin === new URL(page.url()).origin &&
      request.resourceType() === 'image'
    ) {
      engineMediaImages.push(request.url());
    } else if (url.hostname !== '127.0.0.1') external.push(request.url());
  });
  page.on('console', (message) => {
    if (
      message.text().includes('Content Security Policy') &&
      !(
        info.project.name === 'webkit' &&
        screenshotting.has(page) &&
        message.text() === captureDiagnostic
      )
    )
      violations.push(message.text());
  });
  await open(page, rich);
  const article = page.getByRole('article');
  await expect(
    article.getByRole('region', { name: 'Document metadata' }),
  ).toContainText('2026-10-30T00:00:00.000Z');
  for (const text of ['false', 'null', '0'])
    await expect(
      article.getByRole('region', { name: 'Document metadata' }),
    ).toContainText(text);
  await expect(article.locator('.hljs-keyword').first()).toHaveText(
    'interface',
  );
  expect(await article.locator('pre code').last().textContent()).toBe(literal);
  await expect(
    article.locator(
      'script,img[src],video[src],source,[style],[data-action],[data-reader-slot],#root',
    ),
  ).toHaveCount(0);
  await expect(article).toContainText('Blocked img');
  await expect(
    article.getByText('Safe text', { exact: true }),
  ).not.toHaveAttribute('class');
  const ids = await article
    .locator('[id]')
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => id.startsWith('reader-d1-r1-'))).toBe(true);
  await page.getByRole('main').evaluate((node) => {
    node.scrollTo(0, 0);
  });
  await capture(page, info, 'rich-top-githubLight-100');
  await article.focus();
  const first = article.getByRole('link', {
    name: 'Footnote 1, occurrence 1',
    exact: true,
  });
  // From the focused article, Tab reaches its first ordinary fragment link,
  // then the first reference. This uses real keyboard modality in Firefox too.
  await page.keyboard.press('Tab');
  await expect(
    article.getByRole('link', { name: 'Go to code', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  const focus = await first.evaluate((node) => ({
    style: getComputedStyle(node).outlineStyle,
    width: getComputedStyle(node).outlineWidth,
    color: getComputedStyle(node).outlineColor,
  }));
  expect(focus.style).toBe('solid');
  expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Enter');
  const noteId = (await first.getAttribute('href'))?.slice(1);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(noteId);
  expect(
    await page.getByRole('main').evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(0);
  for (const occurrence of [1, 2]) {
    const back = article.getByRole('link', {
      name: `Back to reference 1, occurrence ${String(occurrence)}`,
      exact: true,
    });
    await page.keyboard.press('Tab');
    if (occurrence === 2) await page.keyboard.press('Tab');
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    const reference = article.getByRole('link', {
      name: `Footnote 1, occurrence ${String(occurrence)}`,
      exact: true,
    });
    await expect(reference).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await capture(page, info, 'rich-footnote-keyboard-focus', { focus });
  await article.getByRole('link', { name: 'Go to code', exact: true }).click();
  await capture(page, info, 'rich-code-heading-focus');
  const missing = article.getByRole('link', { name: 'Missing', exact: true });
  await missing.focus();
  await page.keyboard.press('Enter');
  await expect(missing).toBeFocused();
  await expect(page.getByLabel('Reading link status')).toHaveText(
    'Section or footnote not found in this document.',
  );
  await expect(
    page.getByRole('region', { name: 'Reader status' }),
  ).toContainText('Opened rich.md.');
  await article.getByRole('link', { name: 'Unicode', exact: true }).click();
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
    '日本語',
  );
  await expect(page.getByLabel('Reading link status')).toBeEmpty();
  const source = await page.evaluate(
    () => window.readerFixture.state().displayed?.snapshot.source,
  );
  expect(source).toBe(rich);
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  expect(external).toEqual([]);
  // CSP allows inline styles for trusted Mermaid output; ordinary author styles
  // are still stripped above, so this fixture should emit no CSP violations.
  expect(violations).toEqual([]);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).map(
      (call) => call.command,
    ),
  ).toEqual(['select_document', 'commit_document']);
  const proof = {
    engineMediaImages,
    sourceSha256: createHash('sha256')
      .update(source ?? '')
      .digest('hex'),
    sourceBytes: Buffer.byteLength(rich),
    boundary:
      'JS snapshot/source equality, not native filesystem write certification',
    ids,
    focus,
  };
  writeFileSync(
    info.outputPath('source-and-destinations.json'),
    JSON.stringify(proof, null, 2),
  );
  await open(page, rich, 2);
  expect(
    await article
      .locator('[id]')
      .evaluateAll((nodes) =>
        nodes.some((node) => node.id.startsWith('reader-d1-r1-')),
      ),
  ).toBe(false);
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: {
        code: 'notFound',
        message: 'Replacement missing',
        attempted: 'fixture/missing.md',
      },
    });
  });
  await page.evaluate(() => window.readerFixture.menu('open'));
  const failure = await page.getByRole('alert').textContent();
  await article.getByRole('link', { name: 'Missing', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(failure ?? '');
  await expect(page.getByLabel('Displayed document')).toContainText('Stale');
});

test('all real token categories and metadata remain legible in every palette and both slots without remounting', async ({
  page,
}, info) => {
  await open(page, rich);
  const heading = await page.locator('article h1').elementHandle();
  const results: object[] = [];
  for (const mode of ['light', 'dark'] as const) {
    for (const [id] of palettes) {
      await page.evaluate(
        ({ mode, id }) => {
          const record = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...record,
            revision: record.revision + 1,
            settings: {
              ...record.settings,
              mode,
              ...(mode === 'light'
                ? { lightPalette: id }
                : { darkPalette: id }),
            },
          });
        },
        { mode, id },
      );
      await expect(page.locator('html')).toHaveAttribute('data-palette', id);
      const roles = await page.evaluate(() => {
        const background = (node: Element): string => {
          const color = getComputedStyle(node).backgroundColor;
          return color === 'rgba(0, 0, 0, 0)' && node.parentElement
            ? background(node.parentElement)
            : color;
        };
        return [
          ...document.querySelectorAll(
            'article code span[class], article .metadata, article .metadata dt, article .metadata dd, article a[href], .reading-note',
          ),
        ].map((node) => ({
          role: node.tagName,
          category: node.className,
          foreground: getComputedStyle(node).color,
          background: background(node),
        }));
      });
      expect(roles.some((role) => role.category.includes('hljs-number'))).toBe(
        true,
      );
      for (const role of roles)
        expect(
          contrast(role.foreground, role.background),
          `${mode}/${id} ${JSON.stringify(role)}`,
        ).toBeGreaterThanOrEqual(4.5);
      results.push({
        mode,
        palette: id,
        roles: roles.map((role) => ({
          ...role,
          contrast: contrast(role.foreground, role.background),
        })),
      });
      if (mode === 'light' && id === 'nord') {
        await page.getByRole('main').evaluate((node) => {
          node.scrollTo(0, 0);
        });
        await capture(page, info, 'rich-top-nord-100');
      }
    }
  }
  expect(
    await heading?.evaluate(
      (node) => node === document.querySelector('article h1'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  await open(page, '---\nlist: [broken\n---\n# Fallback body', 2);
  await page.getByText('View raw metadata', { exact: true }).click();
  await page.getByText('View raw metadata', { exact: true }).focus();
  await page.keyboard.press('Tab');
  const raw = page.getByRole('region', { name: 'Complete raw metadata' });
  await expect(raw).toBeFocused();
  for (const mode of ['light', 'dark'] as const) {
    for (const [id] of palettes) {
      await page.evaluate(
        ({ mode, id }) => {
          const record = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...record,
            revision: record.revision + 1,
            settings: {
              ...record.settings,
              mode,
              ...(mode === 'light'
                ? { lightPalette: id }
                : { darkPalette: id }),
            },
          });
        },
        { mode, id },
      );
      await expect(page.locator('html')).toHaveAttribute('data-palette', id);
      const roles = await page
        .locator(
          'article .metadata-diagnostic, article summary, article .metadata pre',
        )
        .evaluateAll((nodes) => {
          const background = (node: Element): string => {
            const color = getComputedStyle(node).backgroundColor;
            return color === 'rgba(0, 0, 0, 0)' && node.parentElement
              ? background(node.parentElement)
              : color;
          };
          return nodes.map((node) => ({
            role: node.tagName,
            foreground: getComputedStyle(node).color,
            background: background(node),
          }));
        });
      for (const role of roles)
        expect(
          contrast(role.foreground, role.background),
          `${mode}/${id} ${JSON.stringify(role)}`,
        ).toBeGreaterThanOrEqual(4.5);
      const focus = await raw.evaluate((node) => ({
        style: getComputedStyle(node).outlineStyle,
        width: getComputedStyle(node).outlineWidth,
        foreground: getComputedStyle(node).outlineColor,
        background: getComputedStyle(node).backgroundColor,
      }));
      expect(focus.style).toBe('solid');
      expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(3);
      expect(
        contrast(focus.foreground, focus.background),
      ).toBeGreaterThanOrEqual(3);
      results.push({ mode, palette: id, fallbackRoles: roles, focus });
    }
  }
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(2);
  const destination = process.env.MDVIEWERRSX_APPEARANCE_EVIDENCE;
  writeFileSync(
    destination
      ? join(destination, `${info.project.name}-rich-computed.json`)
      : info.outputPath('rich-computed.json'),
    JSON.stringify(results, null, 2),
  );
});

test('complete malformed/deep YAML disclosure, selection/node/scroll continuity, zoom and literal text bypass', async ({
  page,
}, info) => {
  const hostile =
    '"<img src=x>": "<script>not executable</script>"\nlist: [broken';
  await open(page, `\uFEFF---\r\n${hostile}\r\n---\r\n# Body sentinel`);
  const article = page.getByRole('article');
  await expect(
    article.getByRole('heading', { name: 'Body sentinel' }),
  ).toBeVisible();
  await expect(article).toContainText(
    'Metadata could not be read. The document body is shown below.',
  );
  const raw = article.getByRole('region', { name: 'Complete raw metadata' });
  await article.getByText('View raw metadata', { exact: true }).click();
  expect(await raw.textContent()).toBe(`${hostile}\r\n`);
  await expect(article.locator('img,script')).toHaveCount(0);
  await capture(page, info, 'rich-malformed-yaml-expanded');
  const deep = `nested: ${'['.repeat(20)}'${'<untrusted> & long value '.repeat(100)}'${']'.repeat(20)}`;
  await open(
    page,
    `---\n${deep}\n---\n# Body sentinel\n\n${'Visible body text. '.repeat(250)}`,
    2,
  );
  await article
    .getByText('View complete metadata (YAML)', { exact: true })
    .click();
  expect(await raw.textContent()).toBe(`${deep}\n`);
  const readingNode = await article.locator('h1').elementHandle();
  const disclosure = await article.locator('details').elementHandle();
  await raw.focus();
  await raw.evaluate((node) => {
    const text = node.firstChild;
    if (!text) throw new Error('Raw text missing');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const before = await page.evaluate(() => ({
    selection: window.getSelection()?.toString(),
    y: document.querySelector('main')?.scrollTop,
  }));
  await page.evaluate(() => {
    const r = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...r,
      revision: r.revision + 1,
      settings: { ...r.settings, mode: 'light', lightPalette: 'nord' },
    });
  });
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord');
  expect(
    await page.evaluate(() => ({
      selection: window.getSelection()?.toString(),
      y: document.querySelector('main')?.scrollTop,
    })),
  ).toEqual(before);
  await capture(page, info, 'rich-deep-yaml-expanded');
  await page.evaluate(() => window.readerFixture.menu('zoom-in'));
  await expect(article).toHaveAttribute('data-zoom', '110');
  expect(
    await readingNode?.evaluate(
      (node) => node === document.querySelector('article h1'),
    ),
  ).toBe(true);
  expect(
    await disclosure?.evaluate(
      (node) =>
        node === document.querySelector('article details') &&
        node.hasAttribute('open'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    before.selection,
  );
  await page.setViewportSize({ width: 640, height: 800 });
  const chromeSize = await page
    .getByRole('button', { name: 'Document Information…' })
    .evaluate((node) => getComputedStyle(node).fontSize);
  await page.evaluate(() => {
    const r = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...r,
      revision: r.revision + 1,
      settings: { ...r.settings, pageZoom: 300 },
    });
  });
  await expect(article).toHaveAttribute('data-zoom', '300');
  expect(
    await page
      .getByRole('button', { name: 'Document Information…' })
      .evaluate((node) => getComputedStyle(node).fontSize),
  ).toBe(chromeSize);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await raw.focus();
  await raw.evaluate((node) => {
    node.scrollIntoView({ block: 'center' });
  });
  await page.keyboard.press('End');
  await capture(page, info, 'rich-narrow-300');
  expect(await raw.textContent()).toBe(`${deep}\n`);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(2);
  const literalSource =
    '---\nmetadata: false\n---\n# Not Markdown\n[^label]: literal\n<script>literal</script>';
  await page.evaluate((source) => {
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 3,
          revision: 3,
          name: 'literal.txt',
          location: 'fixture/literal.txt',
          format: 'text',
          source,
        },
      },
    });
  }, literalSource);
  await page.evaluate(() => window.readerFixture.menu('open'));
  await expect(article).toHaveText(literalSource);
  await expect(article.locator('.metadata,h1,script')).toHaveCount(0);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(2);
});
