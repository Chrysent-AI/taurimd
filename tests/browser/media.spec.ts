import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { palettes } from '../../src/settings/model';
const imageId = '0'.repeat(31) + '1';
const audioId = '0'.repeat(31) + '2';
const videoId = '0'.repeat(31) + '3';
const brokenId = '0'.repeat(31) + '4';
const damagedAudioId = '0'.repeat(31) + '5';
const files = new Map([
  [
    damagedAudioId,
    { body: Buffer.from('not an encoded audio file'), mime: 'audio/wav' },
  ],
  [
    imageId,
    {
      body: readFileSync(new URL('./media/figure.svg', import.meta.url)),
      mime: 'image/svg+xml',
    },
  ],
  [
    audioId,
    {
      body: readFileSync(new URL('./media/tone.wav', import.meta.url)),
      mime: 'audio/wav',
    },
  ],
  [
    videoId,
    {
      body: readFileSync(new URL('./media/clip.webm', import.meta.url)),
      mime: 'video/webm',
    },
  ],
  [
    brokenId,
    { body: Buffer.from('not an encoded media file'), mime: 'video/webm' },
  ],
]);
const source = `---\ntitle: Local media\n---\n# Scoped reading\n\n![Original geometric figure](figure.svg)\n\n<audio><source src="missing.mp3"><source src="damaged.wav"><source src="tone.wav"><track src="audio-captions.vtt" kind="captions"></audio>\n\n<video src="clip.webm" width="320" height="180"><track src="captions.vtt" kind="captions"></video>\n\n<video src="broken.webm"><track src="broken-captions.vtt" kind="captions"></video>\n\n![Blocked remote figure](https://invalid.example/image)\n\n[External](https://example.invalid/reader) [Related](related.md#destination) [Denied](../outside.md) [Section](#scoped-reading)\n\n<details><summary>Reading disclosure</summary>Preserved selection text.</details>\n\n<track src="orphan-captions.vtt">`;
async function open(page: Page, text: string, id = 1) {
  await page.evaluate(
    ({ text, id }) => {
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: id,
            revision: id,
            name: 'media.md',
            location: `fixture/context-${String(id)}/media.md`,
            format: 'markdown',
            source: text,
          },
        },
      });
    },
    { text, id },
  );
  await page.evaluate(() => window.readerFixture.menu('open'));
  await expect(
    page.getByRole('region', { name: 'Reader status' }),
  ).toContainText('Opened media.md.');
}
async function queueMedia(page: Page) {
  await page.evaluate(
    ({ imageId, audioId, videoId, brokenId, damagedAudioId }) => {
      for (const reply of [
        { value: { id: imageId, mime: 'image/svg+xml' } },
        { error: { code: 'notFound', message: 'Source missing' } },
        { value: { id: damagedAudioId, mime: 'audio/wav' } },
        { value: { id: audioId, mime: 'audio/wav' } },
        { value: { id: videoId, mime: 'video/webm' } },
        { value: { id: brokenId, mime: 'video/webm' } },
      ])
        window.readerFixture.enqueue('resolve_media', reply);
    },
    { imageId, audioId, videoId, brokenId, damagedAudioId },
  );
}
async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  metadata: object,
) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, caret: 'initial' });
  writeFileSync(
    `${path}.json`,
    JSON.stringify(
      {
        boundary:
          'Actual App/controller/worker/sanitizer/native JS adapter, browser-only IPC/convertFileSrc/HTTP transport doubles; not native protocol/CSP/codec/OS certification',
        engine: info.project.name,
        viewport: page.viewportSize(),
        ...metadata,
      },
      null,
      2,
    ),
  );
  await info.attach(name, { path, contentType: 'image/png' });
}
function contrast(a: string, b: string) {
  const light = (text: string) => {
    const values = text
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!values || values.length !== 3)
      throw new Error(`Invalid color: ${text}`);
    const v = values
      .map((value) => value / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  };
  const x = light(a),
    y = light(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('http://reader-media.localhost/**', async (route) => {
    const file = files.get(new URL(route.request().url()).pathname.slice(1));
    if (!file) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    // This narrow fixture double handles only the ranges emitted by these
    // browser players. Native range-policy correctness is tested in Rust.
    const rangeHeader = (await route.request().headerValue('range')) ?? '';
    const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), file.body.length - 1)
      : file.body.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      headers: {
        'Content-Type': file.mime,
        'Accept-Ranges': 'bytes',
        ...(range
          ? {
              'Content-Range': `bytes ${String(start)}-${String(end)}/${String(file.body.length)}`,
            }
          : {}),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: file.body.subarray(start, end + 1),
    });
  });
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(2);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('real decode/controls/seek and visible failures retain nodes, focus and players across both slots/all palettes/zoom', async ({
  page,
}, info) => {
  const unexpected: string[] = [];
  const engineImages: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // WebKit's native control shadow UI requests its own same-origin Blob
    // icons. Keep them as evidence, not a document-source/CSP exception.
    if (
      url.protocol === 'blob:' &&
      url.origin === new URL(page.url()).origin &&
      request.resourceType() === 'image'
    ) {
      engineImages.push(request.url());
      return;
    }
    if (!['127.0.0.1', 'reader-media.localhost'].includes(url.hostname))
      unexpected.push(request.url());
  });
  await queueMedia(page);
  await open(page, source);
  const image = page.getByRole('img', { name: 'Original geometric figure' });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(160);
  const audio = page.locator('article audio');
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.duration))
    .toBe(3);
  await expect(audio).toHaveAttribute('controls', '');
  await audio.evaluate(async (node: HTMLAudioElement) => {
    await node.play();
    node.pause();
    node.currentTime = 1;
  });
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBe(1);
  const video = page.locator('article video').first();
  await expect
    .poll(() =>
      video.evaluate(
        (node: HTMLVideoElement) =>
          node.readyState > 0 || node.networkState === node.NETWORK_NO_SOURCE,
      ),
    )
    .toBe(true);
  const decoded = await video.evaluate((node: HTMLVideoElement) => ({
    ready: node.readyState,
    width: node.videoWidth,
    duration: node.duration,
    canPlay: node.canPlayType('video/webm; codecs="vp8"'),
  }));
  if (decoded.ready > 0) {
    expect(decoded.width).toBe(160);
    await video.evaluate(async (node: HTMLVideoElement) => {
      await node.play();
      node.pause();
      node.currentTime = 1;
    });
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBe(1);
  } else
    await expect(
      page.locator('[data-reader-media-feedback="2"]'),
    ).toContainText('could not play');
  await expect(page.locator('[data-reader-media-feedback="3"]')).toContainText(
    'could not play',
  );
  await expect(page.locator('[data-reader-media-feedback="1"]')).toContainText(
    'Some local sources are missing, denied or unsupported.',
  );
  const captionWarnings: object[] = [];
  for (const slot of ['1', '2', '3']) {
    const feedback = page.locator(`[data-reader-media-feedback="${slot}"]`);
    await expect(feedback).toContainText(
      'Caption track unavailable — this resource type is not supported.',
    );
    await expect(feedback).toBeVisible();
    const placement = await feedback.evaluate((node) => ({
      insidePlayer: Boolean(node.closest('audio,video')),
      previous: node.previousElementSibling?.tagName,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      playerText: node.previousElementSibling?.textContent,
    }));
    expect(placement.insidePlayer).toBe(false);
    expect(['AUDIO', 'VIDEO']).toContain(placement.previous);
    expect(placement.width).toBeGreaterThan(0);
    expect(placement.height).toBeGreaterThan(0);
    expect(placement.playerText).not.toContain('Caption track unavailable');
    captionWarnings.push({ slot, ...placement });
  }
  const orphanCaption = await page.getByRole('article').evaluate((article) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let text: Node | null;
    while ((text = walker.nextNode())) {
      if (!text.textContent?.includes('[Caption track unavailable')) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rect = range.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        insidePlayer: Boolean(text.parentElement?.closest('audio,video')),
        visibility: text.parentElement
          ? getComputedStyle(text.parentElement).visibility
          : null,
      };
    }
    throw new Error('Orphan caption fallback missing');
  });
  expect(orphanCaption.width).toBeGreaterThan(0);
  expect(orphanCaption.height).toBeGreaterThan(0);
  expect(orphanCaption.insidePlayer).toBe(false);
  expect(orphanCaption.visibility).toBe('visible');
  captionWarnings.push({ slot: 'orphan', ...orphanCaption });
  await expect(
    page.locator('article track, article [src*="captions.vtt"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-reader-media-feedback="4"]')).toContainText(
    'Blocked img',
  );
  const node = await audio.elementHandle();
  await page.getByText('Reading disclosure', { exact: true }).click();
  const link = page.getByRole('link', { name: 'External', exact: true });
  await link.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.evaluate(() => {
    const text = document.querySelector('article details')?.lastChild;
    if (!text) throw new Error('Expected disclosure text');
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const selected = await page.evaluate(() => getSelection()?.toString());
  const computed: object[] = [];
  for (const mode of ['light', 'dark'] as const)
    for (const [palette] of palettes) {
      await page.evaluate(
        ({ mode, palette }) => {
          const record = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...record,
            revision: record.revision + 1,
            settings: {
              ...record.settings,
              mode,
              ...(mode === 'light'
                ? { lightPalette: palette }
                : { darkPalette: palette }),
            },
          });
        },
        { mode, palette },
      );
      await expect(page.locator('html')).toHaveAttribute(
        'data-palette',
        palette,
      );
      const roles = await page
        .locator('.media-feedback:not(:empty),article a')
        .evaluateAll((nodes) => {
          const background = (node: Element): string => {
            const color = getComputedStyle(node).backgroundColor;
            return color === 'rgba(0, 0, 0, 0)' && node.parentElement
              ? background(node.parentElement)
              : color;
          };
          return nodes.map((node) => ({
            foreground: getComputedStyle(node).color,
            background: background(node),
            outline: getComputedStyle(node).outlineColor,
            focused: node === document.activeElement,
          }));
        });
      for (const role of roles) {
        expect(
          contrast(role.foreground, role.background),
        ).toBeGreaterThanOrEqual(4.5);
        if (role.focused)
          expect(
            contrast(role.outline, role.background),
          ).toBeGreaterThanOrEqual(3);
      }
      computed.push({ mode, palette, roles });
    }
  expect(
    await node?.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  expect(
    await audio.evaluate((node: HTMLAudioElement) => node.currentTime),
  ).toBe(1);
  await expect(page.locator('article details')).toHaveAttribute('open', '');
  await expect(link).toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'resolve_media',
    ),
  ).toHaveLength(6);
  expect(unexpected).toEqual([]);
  await expect(
    page.locator(
      'article [src^="blob:"],article [src^="data:"],article [poster^="blob:"]',
    ),
  ).toHaveCount(0);
  await capture(page, info, 'media-nord', {
    engineImages,
    palette: 'nord',
    zoom: 100,
    video: decoded,
    captionWarnings,
    audio: 'PCM decoded, played, paused and sought to 1s',
    computed,
  });
  await page.setViewportSize({ width: 640, height: 800 });
  await page.evaluate(() => {
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: { ...record.settings, pageZoom: 300 },
    });
  });
  await expect(page.getByRole('article')).toHaveAttribute('data-zoom', '300');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await audio.evaluate((node) => node.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(640);
  await audio.scrollIntoViewIfNeeded();
  await capture(page, info, 'media-narrow-300', { palette: 'nord', zoom: 300 });
});

test('trusted activation only, native acknowledgement, linked worker/commit fragment focus and failure preserve origin/reader status', async ({
  page,
}) => {
  await open(
    page,
    '# Origin\n\n[External](https://example.invalid/) [Related](related.md#destination) [Denied](../outside.md)',
  );
  const external = page.getByRole('link', { name: 'External', exact: true });
  await external.evaluate((node: HTMLAnchorElement) => {
    node.click();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'activate_link',
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    window.readerFixture.enqueue('activate_link', { hold: 'os-handoff' });
  });
  await external.click();
  await expect(page.getByLabel('Reading link status')).not.toContainText(
    'Sent link',
  );
  await page.evaluate(() => {
    window.readerFixture.release('os-handoff', {
      value: { status: 'externalOpened' },
    });
  });
  await expect(page.getByLabel('Reading link status')).toHaveText(
    'Sent link to the default application.',
  );
  await expect(
    page.getByRole('heading', { name: 'Origin', exact: true }),
  ).toBeVisible();
  await expect(external).toBeFocused();
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', {
      error: { code: 'notFound', message: 'Failed replacement' },
    });
  });
  await page.evaluate(() => window.readerFixture.menu('open'));
  const stale = await page.getByRole('alert').textContent();
  await page.evaluate(() => {
    window.readerFixture.enqueue('activate_link', {
      error: { code: 'denied', message: 'Outside permitted scope' },
    });
  });
  const denied = page.getByRole('link', { name: 'Denied', exact: true });
  await denied.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Reading link status')).toContainText(
    'Outside permitted scope',
  );
  await expect(page.getByRole('alert')).toHaveText(stale ?? '');
  await expect(denied).toBeFocused();
  await page.evaluate(() => {
    window.readerFixture.enqueue('activate_link', { hold: 'cancelled-link' });
  });
  await page.getByRole('link', { name: 'Related', exact: true }).click();
  await expect(page.getByLabel('Reading link status')).toHaveText(
    'Opening link…',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Reading link status')).toBeEmpty();
  await page.evaluate(() => {
    window.readerFixture.release('cancelled-link', {
      value: {
        status: 'document',
        fragment: null,
        snapshot: {
          documentId: 5,
          revision: 5,
          name: 'cancelled.md',
          location: 'fixture/cancelled.md',
          format: 'markdown',
          source: '# Cancelled linked document',
        },
      },
    });
  });
  await expect(
    page.getByRole('heading', { name: 'Origin', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Cancelled linked document',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.enqueue('activate_link', {
      value: {
        status: 'document',
        fragment: 'destination',
        snapshot: {
          documentId: 7,
          revision: 7,
          name: 'related.md',
          location: 'fixture/related.md',
          format: 'markdown',
          source:
            '---\ntitle: Linked metadata\n---\n# Destination\n\nLinked content.',
        },
      },
    });
  });
  await page.getByRole('link', { name: 'Related', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Destination', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('region', { name: 'Document metadata' }),
  ).toContainText('Linked metadata');
  await expect(page.getByLabel('Displayed document')).toContainText(
    'related.md',
  );
  await expect(page.getByLabel('Reading link status')).toBeEmpty();
  const calls = await page.evaluate(() => window.readerFixture.calls());
  expect(
    calls
      .filter((call) => call.command === 'activate_link')
      .map((call) => call.payload),
  ).toEqual([
    {
      requestId: 2,
      documentId: 1,
      revision: 1,
      href: 'https://example.invalid/',
    },
    { requestId: 4, documentId: 1, revision: 1, href: '../outside.md' },
    {
      requestId: 5,
      documentId: 1,
      revision: 1,
      href: 'related.md#destination',
    },
    {
      requestId: 7,
      documentId: 1,
      revision: 1,
      href: 'related.md#destination',
    },
  ]);
});

test('last-good media survives pending/fail/cancel; same text/new context replaces and releases old player, late media cannot attach', async ({
  page,
}) => {
  await queueMedia(page);
  await open(page, source);
  const audio = page.locator('article audio');
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState))
    .toBeGreaterThan(0);
  await audio.evaluate((node: HTMLAudioElement) => {
    node.currentTime = 1;
  });
  const old = await audio.elementHandle();
  await page.evaluate(() => {
    window.readerFixture.enqueue('select_document', { hold: 'pending-open' });
  });
  await page.evaluate(() => window.readerFixture.menu('open'));
  expect(
    await old?.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    window.readerFixture.release('pending-open', {
      value: { status: 'cancelled' },
    });
  });
  expect(
    await audio.evaluate((node: HTMLAudioElement) => node.currentTime),
  ).toBe(1);
  await page.evaluate(() => {
    window.readerFixture.enqueue('reload_document', {
      error: { code: 'notFound', message: 'Missing replacement' },
    });
  });
  await page.evaluate(() => window.readerFixture.menu('reload'));
  await expect(page.getByRole('alert')).toContainText('Reload failed');
  expect(
    await old?.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  await queueMedia(page);
  await open(page, source, 5);
  expect(
    await old?.evaluate((node: HTMLAudioElement) => ({
      connected: node.isConnected,
      sources: node.querySelectorAll('source').length,
      paused: node.paused,
    })),
  ).toEqual({ connected: false, sources: 0, paused: true });
  const resolves = (
    await page.evaluate(() => window.readerFixture.calls())
  ).filter((call) => call.command === 'resolve_media');
  expect(
    resolves
      .slice(6)
      .every(
        (call) => (call.payload as { documentId: number }).documentId === 5,
      ),
  ).toBe(true);
  await page.evaluate(() => {
    window.readerFixture.enqueue('resolve_media', { hold: 'late-image' });
  });
  await open(page, '![Late](figure.svg)', 6);
  const late = await page.getByRole('img', { name: 'Late' }).elementHandle();
  await open(page, '# No media', 7);
  await page.evaluate(
    ({ imageId }) => {
      window.readerFixture.release('late-image', {
        value: { id: imageId, mime: 'image/svg+xml' },
      });
    },
    { imageId },
  );
  expect(await late?.evaluate((node) => node.hasAttribute('src'))).toBe(false);
  await expect(page.locator('article img,audio,video')).toHaveCount(0);
});

test('scrolled playing media, article, selection and disclosures survive status/Guide round trips without file authority or reparse', async ({
  page,
}, info) => {
  await queueMedia(page);
  await open(
    page,
    `${'A long reading paragraph before the media. '.repeat(160)}\n\n${source}\n\n${'Reading continues after the media. '.repeat(160)}`,
  );
  const article = page.getByRole('article');
  const audio = page.locator('article audio');
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState))
    .toBeGreaterThan(0);
  await page.getByText('Reading disclosure', { exact: true }).click();
  await article.focus();
  await page.evaluate(() => {
    const text = document.querySelector('article details')?.lastChild;
    if (!text) throw new Error('Missing disclosure');
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.querySelector('main')?.scrollTo(0, 700);
  });
  const originalArticle = await article.elementHandle();
  const originalAudio = await audio.elementHandle();
  const before = await page.evaluate(() => ({
    y: document.querySelector('main')?.scrollTop,
    selection: getSelection()?.toString(),
    calls: window.readerFixture.calls(),
    parses: window.readerFixture.parses(),
  }));
  const announcements = await page
    .getByRole('status')
    .evaluateHandle((node) => {
      const entries: string[] = [];
      const observer = new MutationObserver(() => {
        entries.push(node.textContent);
      });
      observer.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      return { entries, observer };
    });
  await audio.evaluate(async (node: HTMLAudioElement) => {
    node.loop = true;
    node.currentTime = 0.1;
    await node.play();
  });
  await expect
    .poll(() =>
      audio.evaluate(
        (node: HTMLAudioElement) => !node.paused && node.currentTime > 0.1,
      ),
    )
    .toBe(true);
  const playing = await audio.evaluate(
    (node: HTMLAudioElement) => node.currentTime,
  );
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await expect(page.getByLabel('Displayed document')).toHaveCount(0);
  await page.evaluate(() => window.readerFixture.menu('guide'));
  const guide = page.getByRole('dialog', { name: 'User Guide' });
  await expect(
    guide.getByRole('link', { name: 'Reading safely', exact: true }),
  ).toBeVisible();
  await guide
    .getByRole('link', { name: 'Reading safely', exact: true })
    .click();
  await expect(
    guide.getByRole('heading', { name: 'Reading safely', exact: true }),
  ).toBeFocused();
  await expect
    .poll(() =>
      audio.evaluate(
        (node: HTMLAudioElement, previous) =>
          !node.paused && node.currentTime !== previous,
        playing,
      ),
    )
    .toBe(true);
  const escape = guide.getByRole('link', {
    name: 'Back to User Guide',
    exact: true,
  });
  const underlying = await article.locator('h1').getAttribute('id');
  await escape.evaluate((node, id) => {
    node.setAttribute('href', `#${id ?? ''}`);
  }, underlying);
  await escape.click();
  expect(
    await guide.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await guide.getByRole('button', { name: 'Close' }).click();
  await expect(article).toBeFocused();
  expect(await page.getByRole('main').evaluate((node) => node.scrollTop)).toBe(
    before.y,
  );
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    before.selection,
  );
  await expect(page.locator('article details')).toHaveAttribute('open', '');
  expect(
    await originalArticle?.evaluate(
      (node) => node === document.querySelector('article'),
    ),
  ).toBe(true);
  expect(
    await originalAudio?.evaluate(
      (node) => node === document.querySelector('article audio'),
    ),
  ).toBe(true);
  expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(
    false,
  );
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual(
    before.calls,
  );
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(
    before.parses,
  );
  expect(
    await announcements.evaluate(({ entries, observer }) => {
      observer.disconnect();
      return entries;
    }),
  ).toEqual([]);
  await announcements.dispose();
  await capture(page, info, 'playing-media-after-guide', {
    palette: 'githubLight',
    viewport: page.viewportSize(),
    zoom: 100,
    noNewFileAuthority: true,
    browserOnly: true,
  });
  await originalArticle?.dispose();
  await originalAudio?.dispose();
});

test('diagram recoloring and temporary dialogs preserve scrolled playing media selection nodes and local interaction', async ({
  page,
}, info) => {
  await queueMedia(page);
  const text = `${'Reading before diagrams. '.repeat(100)}\n\n${source}\n\n\`\`\`mermaid\nsequenceDiagram\n Alice->>Bob: Keep reading\n\`\`\`\n\n${'Reading continues. '.repeat(100)}`;
  await open(page, text);
  const diagram = page.locator('.diagram');
  await expect(diagram.locator('svg')).toHaveCount(1);
  const audio = page.locator('article audio');
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState))
    .toBeGreaterThan(0);
  await diagram.getByText('Original definition', { exact: true }).click();
  await page.getByText('Reading disclosure', { exact: true }).click();
  await diagram
    .getByRole('button', { name: 'Interact with diagram 1' })
    .click();
  await diagram.getByRole('region').press('ArrowRight');
  const retained = await page.evaluateHandle(() => {
    const article = document.querySelector('article');
    const figure = document.querySelector('.diagram');
    const audio = document.querySelector('audio');
    const scene = document.querySelector<HTMLElement>('.diagram-scene');
    const text = document.querySelector('article details')?.lastChild;
    if (!text) throw new Error('No disclosure source');
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.querySelector('main')?.scrollTo(0, 700);
    return {
      article,
      figure,
      audio,
      scene,
      control: figure?.querySelector('button'),
      focused: document.activeElement,
      selected: getSelection()?.toString(),
      transform: scene?.style.transform,
      scroll: document.querySelector('main')?.scrollTop,
      calls: window.readerFixture.calls(),
      parses: window.readerFixture.parses(),
    };
  });
  await audio.evaluate(async (node: HTMLAudioElement) => {
    node.loop = true;
    node.currentTime = 0.1;
    await node.play();
  });
  await expect
    .poll(() =>
      audio.evaluate(
        (node: HTMLAudioElement) => !node.paused && node.currentTime > 0.1,
      ),
    )
    .toBe(true);
  const previousTime = await audio.evaluate(
    (node: HTMLAudioElement) => node.currentTime,
  );
  await page.evaluate(async () => {
    const record = window.readerFixture.settings();
    await window.readerFixture.settingsEvent({
      ...record,
      revision: 20,
      settings: { ...record.settings, mode: 'light', lightPalette: 'nord' },
    });
  });
  await expect(diagram).toHaveAttribute('data-palette', 'nord');
  for (const visible of [false, true]) {
    await page.evaluate(() => window.readerFixture.menu('sidebar'));
    await expect(
      page.getByLabel('Document navigation', { exact: true }),
    ).toBeVisible({ visible });
  }
  await page.evaluate(() => window.readerFixture.menu('sort-date'));
  await expect(page.getByLabel('Sibling order', { exact: true })).toHaveValue(
    'date',
  );
  await page.evaluate(() => window.readerFixture.menu('sort-alpha'));
  await expect(page.getByLabel('Sibling order', { exact: true })).toHaveValue(
    'alpha',
  );
  for (const surface of [
    'settings',
    'guide',
    'information',
    'about',
  ] as const) {
    await page.evaluate(
      (surface) => window.readerFixture.menu(surface),
      surface,
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(diagram.getByRole('region')).toBeFocused();
  }
  expect(
    await retained.evaluate((before) => ({
      article: before.article === document.querySelector('article'),
      figure: before.figure === document.querySelector('.diagram'),
      control: before.control === document.querySelector('.diagram button'),
      audio: before.audio === document.querySelector('audio'),
      scene: before.scene === document.querySelector('.diagram-scene'),
      selection: before.selected === getSelection()?.toString(),
      scroll: before.scroll === document.querySelector('main')?.scrollTop,
      transform:
        before.transform ===
        document.querySelector<HTMLElement>('.diagram-scene')?.style.transform,
      calls:
        JSON.stringify(before.calls) ===
        JSON.stringify(window.readerFixture.calls()),
    })),
  ).toEqual({
    article: true,
    figure: true,
    control: true,
    audio: true,
    scene: true,
    selection: true,
    scroll: true,
    transform: true,
    calls: true,
  });
  await expect(diagram.locator('details')).toHaveAttribute('open', '');
  await expect
    .poll(() =>
      audio.evaluate(
        (node: HTMLAudioElement, before) =>
          !node.paused && node.currentTime !== before,
        previousTime,
      ),
    )
    .toBe(true);
  for (const [mode, result] of [
    ['svg', { value: { status: 'cancelled' } }],
    ['png', { error: { code: 'io', message: 'Injected destination failure' } }],
    [
      'png',
      {
        value: {
          status: 'committed',
          count: 1,
          location: 'selected/media-diagram.zip',
        },
      },
    ],
  ] as const) {
    await page.evaluate(
      ({ mode, result }) => {
        window.readerFixture.enqueue('finish_export', result);
        return window.readerFixture.menu(
          mode === 'svg' ? 'export-svg' : 'export-png',
        );
      },
      { mode, result },
    );
    await expect(
      page.getByText(
        'error' in result
          ? 'Export stopped: Injected destination failure'
          : result.value.status === 'committed'
            ? 'Exported 1 PNG diagrams to selected/media-diagram.zip.'
            : 'Export cancelled.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(diagram.getByRole('region')).toBeFocused();
    expect(
      await retained.evaluate((before) => ({
        article: before.article === document.querySelector('article'),
        figure: before.figure === document.querySelector('.diagram'),
        audio: before.audio === document.querySelector('audio'),
        control: before.control === document.querySelector('.diagram button'),
        selected: before.selected === getSelection()?.toString(),
        scroll: before.scroll === document.querySelector('main')?.scrollTop,
        transform:
          before.transform ===
          document.querySelector<HTMLElement>('.diagram-scene')?.style
            .transform,
        parses: before.parses === window.readerFixture.parses(),
        readingCalls:
          JSON.stringify(before.calls) ===
          JSON.stringify(
            window.readerFixture
              .calls()
              .filter(
                (call) =>
                  !call.command.endsWith('_export') &&
                  call.command !== 'append_export_image',
              ),
          ),
      })),
    ).toEqual({
      article: true,
      figure: true,
      audio: true,
      control: true,
      selected: true,
      scroll: true,
      transform: true,
      parses: true,
      readingCalls: true,
    });
    expect(await audio.evaluate((node: HTMLAudioElement) => !node.paused)).toBe(
      true,
    );
  }
  await capture(page, info, 'diagram-media-continuity', {
    sameMountedNodesAndContext: true,
    source: 'original browser-only fixture',
    playing: true,
  });
  await retained.dispose();
});

test('hostile URL/style/action surfaces never connect fetch candidates or invoke native commands automatically', async ({
  page,
}, info) => {
  const remote: string[] = [];
  const diagnostics: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'blob:' && url.hostname !== '127.0.0.1')
      remote.push(request.url());
  });
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy'))
      diagnostics.push(message.text());
  });
  await open(
    page,
    `# Hostile resources\n\n<base href="https://invalid.example/"><link rel="stylesheet" href="https://invalid.example/css"><meta http-equiv="refresh" content="0;url=https://invalid.example/">
<style>@font-face{font-family:hostile;src:url(https://invalid.example/font)} body{background:url(https://invalid.example/bg)}</style>
<img src="data:image/svg+xml,evil" srcset="https://invalid.example/srcset 2x" onerror="window.compromised=true">
<img src="blob:http://127.0.0.1/author-token"><img src="file:///ungranted.png"><img src="custom://resource"><img src="//invalid.example/image">
<audio src="https://invalid.example/audio" autoplay><source src="file:///ungranted.mp3"><source src="data:audio/wav,evil"></audio>
<video poster="https://invalid.example/poster"><source src="//invalid.example/video"><track src="https://invalid.example/captions"></video>
<picture><source srcset="https://invalid.example/picture 1x"></picture>
<svg><image href="https://invalid.example/svg"></image><use href="https://invalid.example/use"></use></svg><math href="https://invalid.example/math">Math text</math>
<p id="root" data-reader-media="0" data-reader-link="0" data-action="open" style="background:url(https://invalid.example/style)" onclick="window.compromised=true">Safe text</p>
<a href="javascript:evil()" download target="_blank" onclick="window.compromised=true">Inert action</a>`,
  );
  const article = page.getByRole('article');
  await expect(
    article.locator(
      '[src],[srcset],[poster],[style],[autoplay],[download],[target],[onclick],[onerror],#root,source,track,svg,math,style,meta,base,link',
    ),
  ).toHaveCount(0);
  await article
    .getByRole('link', { name: 'Inert action' })
    .evaluate((node: HTMLAnchorElement) => {
      node.click();
    });
  await expect(article).toContainText('Blocked img');
  await expect(article).toContainText('Blocked video poster');
  expect(remote).toEqual([]);
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).map(
      (call) => call.command,
    ),
  ).toEqual(['select_document', 'commit_document']);
  await info.attach('hostile-resource-diagnostics', {
    body: JSON.stringify(
      {
        boundary:
          'Browser-only inert-boundary evidence; native transport and CSP not certified',
        remote,
        diagnostics,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
