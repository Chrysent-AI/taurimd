import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  palettes,
  defaults,
  type SettingsRecord,
} from '../../src/settings/model';
const example = readFileSync(
  new URL('../../examples/reading.md', import.meta.url),
  'utf8',
);
const rich = `${example}\n\n## Layout checks\n\n${('A readable paragraph keeps its reading position while appearance changes. '.repeat(14) + '\n\n').repeat(5)}\n\n\`\`\`text\n${'long-code-token_'.repeat(80)}\n\`\`\`\n\n| Wide first column | Wide second column | Wide third column |\n|---|---|---|\n| ${'widecell'.repeat(30)} | ${'second-'.repeat(30)} | ${'third-'.repeat(30)} |\n\n## End of document\n\nAll content remains reachable.\n`;
const pageColors: Record<string, string> = {
  githubLight: 'rgb(255, 255, 255)',
  githubDark: 'rgb(13, 17, 23)',
  solarizedLight: 'rgb(253, 246, 227)',
  solarizedDark: 'rgb(0, 43, 54)',
  dracula: 'rgb(40, 42, 54)',
  monokai: 'rgb(39, 40, 34)',
  nord: 'rgb(46, 52, 64)',
};
const record = (
  revision: number,
  patch: Partial<SettingsRecord['settings']> = {},
): SettingsRecord => ({
  version: 1,
  revision,
  settings: { ...defaults, ...patch },
  notice: null,
});
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings…' }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}
async function saved(page: Page) {
  await expect(
    page
      .getByRole('region', { name: 'Preferences status' })
      .filter({ visible: true })
      .first(),
  ).toContainText('Preferences saved.');
}
const screenshotting = new WeakSet<Page>();
const webkitScreenshotDiagnostic =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
async function capture(page: Page, info: TestInfo, name: string) {
  const destination = process.env.MDVIEWERRSX_APPEARANCE_EVIDENCE;
  const path = destination
    ? join(destination, `${info.project.name}-${name}.png`)
    : info.outputPath(`${name}.png`);
  // Playwright 1.59.1 screenshotter injects "body {}" to sync WebKit animations.
  // Keep CSP intact; record only that tool-owned diagnostic during capture.
  const diagnostics: string[] = [];
  const observe = (message: { text: () => string }) => {
    if (message.text() === webkitScreenshotDiagnostic)
      diagnostics.push(message.text());
  };
  page.on('console', observe);
  screenshotting.add(page);
  let image: Buffer;
  try {
    image = await page.screenshot({
      path,
      fullPage: name.includes('-100-'),
      caret: 'initial',
    });
  } finally {
    screenshotting.delete(page);
    page.off('console', observe);
  }
  await expect(page.locator('style, [style]')).toHaveCount(0);
  const metadata = {
    evidence:
      'Browser only; actual App/controller/worker/JS adapter with explicit native double',
    browser: info.project.name,
    screenshotToolDiagnostics: diagnostics,
    name,
    viewport: page.viewportSize(),
    dpr: await page.evaluate(() => window.devicePixelRatio),
    raster: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
  };
  writeFileSync(`${path}.json`, JSON.stringify(metadata, null, 2));
  await info.attach(name, { path, contentType: 'image/png' });
}
function luminance(color: string) {
  const rgb = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!rgb || rgb.length !== 3)
    throw new Error(`Unexpected computed color ${color}`);
  const linear = rgb.map((component) => {
    const value = component / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    (linear[0] ?? 0) * 0.2126 +
    (linear[1] ?? 0) * 0.7152 +
    (linear[2] ?? 0) * 0.0722
  );
}
function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function assertRoles(page: Page) {
  const roles = await page.evaluate(() => {
    const background = (node: Element): string => {
      const color = getComputedStyle(node).backgroundColor;
      return color === 'rgba(0, 0, 0, 0)' && node.parentElement
        ? background(node.parentElement)
        : color;
    };
    return [
      'body',
      'header',
      '.hint',
      'article',
      'article pre',
      'article code',
      'article th',
      'article td',
      'article blockquote',
      'dialog select',
      '.commands button:disabled',
      '.warning',
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing real styled role ${selector}`);
      return {
        selector,
        text: getComputedStyle(element).color,
        background: background(element),
      };
    });
  });
  for (const role of roles)
    expect(
      contrast(role.text, role.background),
      JSON.stringify(role),
    ).toBeGreaterThanOrEqual(4.5);
  const focus = await page
    .getByLabel('Appearance', { exact: true })
    .evaluate((element) => ({
      outline: getComputedStyle(element).outlineColor,
      background: getComputedStyle(element).backgroundColor,
    }));
  expect(contrast(focus.outline, focus.background)).toBeGreaterThanOrEqual(3);
  return {
    roles: roles.map((role) => ({
      ...role,
      contrast: contrast(role.text, role.background),
    })),
    focus: { ...focus, contrast: contrast(focus.outline, focus.background) },
  };
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(2);
  await saved(page);
  await page.evaluate((source) => {
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 1,
          revision: 1,
          name: 'reading.md',
          location: `fixture/${'nested-folder/'.repeat(12)}reading.md`,
          format: 'markdown',
          source,
        },
      },
    });
  }, rich);
  await page.getByRole('button', { name: 'Open File…' }).click();
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'End of document' }),
  ).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('both complete seven-choice slots produce real legible palettes, opposite tones and settled screenshots', async ({
  page,
}, info) => {
  const network: string[] = [];
  const violations: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      network.push(request.url());
  });
  page.on('console', (message) => {
    if (
      message.text().includes('Content Security Policy') &&
      !(
        info.project.name === 'webkit' &&
        screenshotting.has(page) &&
        message.text() === webkitScreenshotDiagnostic
      )
    )
      violations.push(message.text());
  });
  // Real native fallback notice is an explicit fixture DTO, not a fake document error.
  await page.evaluate(
    (value) =>
      window.readerFixture.settingsEvent({
        ...value,
        notice:
          'Some saved preferences could not be loaded; defaults are being used.',
      }),
    record(1),
  );
  for (const mode of ['light', 'dark'] as const) {
    for (const [id] of palettes) {
      const dialog = await settings(page);
      for (const label of ['Light palette', 'Dark palette']) {
        expect(
          await dialog
            .getByLabel(label, { exact: true })
            .locator('option')
            .allTextContents(),
        ).toEqual(palettes.map(([, name]) => name));
      }
      await dialog.getByLabel('Appearance', { exact: true }).selectOption(mode);
      await dialog
        .getByLabel(mode === 'light' ? 'Light palette' : 'Dark palette', {
          exact: true,
        })
        .selectOption(id);
      await saved(page);
      // Keep the warning visible for actual computed error role measurements.
      await page.evaluate(() => {
        const value = window.readerFixture.settings();
        return window.readerFixture.settingsEvent({
          ...value,
          notice:
            'Some saved preferences could not be loaded; defaults are being used.',
        });
      });
      await dialog.getByLabel('Appearance', { exact: true }).focus();
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        pageColors[id] ?? '',
      );
      await expect(page.locator('html')).toHaveCSS(
        'color-scheme',
        id === 'githubLight' || id === 'solarizedLight' ? 'light' : 'dark',
      );
      await expect(dialog).toContainText(
        `Currently using ${mode === 'light' ? 'Light' : 'Dark'} palette`,
      );
      const computed = await assertRoles(page);
      const evidence = process.env.MDVIEWERRSX_APPEARANCE_EVIDENCE;
      if (evidence)
        writeFileSync(
          join(evidence, `${info.project.name}-${mode}-${id}-computed.json`),
          JSON.stringify(computed, null, 2),
        );
      if (mode === 'light' && id === 'nord')
        await capture(page, info, 'settings-focused-nord-1280x800');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      if (mode === 'light') {
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await capture(page, info, `${id}-100-1280x800`);
      }
    }
  }
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).map(
      (call) => call.command,
    ),
  ).toEqual(['select_document', 'commit_document']);
  expect(network).toEqual([]);
  expect(violations).toEqual([]);
});

test('System observes both slots, forced modes ignore OS changes, inactive edits persist without recolor or parse', async ({
  page,
}) => {
  const dialog = await settings(page);
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('solarizedLight');
  await dialog.getByLabel('Dark palette', { exact: true }).selectOption('nord');
  await saved(page);
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.solarizedLight,
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.nord,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.solarizedLight,
  );
  await dialog.getByLabel('Appearance', { exact: true }).selectOption('light');
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('dracula');
  await dialog
    .getByLabel('Dark palette', { exact: true })
    .selectOption('githubLight');
  await saved(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.dracula,
  );
  await dialog.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.githubLight,
  );
  await saved(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => {
    window.scrollTo(0, 700);
  });
  const before = await page.evaluate(() => ({
    y: window.scrollY,
    article: document.querySelector('article')?.textContent,
  }));
  const readingNode = await page.locator('article h1').elementHandle();
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await dialog
    .getByLabel('Dark palette', { exact: true })
    .selectOption('githubDark');
  await saved(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(before.y);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await readingNode?.evaluate((node) => node.isConnected)).toBe(true);
  await readingNode?.dispose();
  await page.evaluate(() =>
    window.readerFixture.settingsEvent({
      ...window.readerFixture.settings(),
      revision: 40,
      settings: {
        ...window.readerFixture.settings().settings,
        darkPalette: 'monokai',
      },
    }),
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(before.y);
  expect(await page.getByRole('article').textContent()).toBe(before.article);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
});

test('optimistic failure/retry, fallback, stale responses and simulated retained-record hydration preserve reading status', async ({
  page,
}, info) => {
  const dialog = await settings(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('update_settings', { hold: 'first-save' });
  });
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('dracula');
  await expect(dialog).toContainText('Saving preferences');
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    pageColors.dracula,
  );
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('nord');
  await page.evaluate(() => {
    window.readerFixture.release('first-save', {
      error: { code: 'io', message: 'Fixture disk unavailable' },
    });
  });
  await expect(dialog).toContainText('Applied for now');
  await page.evaluate(
    (value) =>
      window.readerFixture.settingsEvent({
        ...value,
        notice:
          'Some saved preferences could not be loaded; defaults are being used.',
      }),
    record(5, { sidebarDefault: false }),
  );
  await capture(page, info, 'save-fallback-error-1280x800');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Preferences status' })
      .filter({ visible: true }),
  ).toContainText('Applied for now');
  await expect(page.getByRole('status')).toHaveText('Opened reading.md.');
  await expect(page.getByLabel('Displayed document')).not.toContainText(
    'Stale',
  );
  await page.getByRole('button', { name: 'Retry preferences' }).click();
  await saved(page);
  const calls = await page.evaluate(() => window.readerFixture.settingsCalls());
  expect(calls.at(-1)).toEqual({
    command: 'update_settings',
    payload: { expectedRevision: 5, patch: { lightPalette: 'nord' } },
  });
  expect(
    await page.evaluate(
      () => window.readerFixture.settings().settings.sidebarDefault,
    ),
  ).toBe(false);
  const again = await settings(page);
  await again.getByLabel('Fit diagrams to view').uncheck();
  await saved(page);
  // Explicitly a backend-double hydration check, not native restart evidence.
  await page.reload();
  await saved(page);
  const hydrated = await settings(page);
  await expect(
    hydrated.getByLabel('Light palette', { exact: true }),
  ).toHaveValue('nord');
  await expect(hydrated.getByLabel('Fit diagrams to view')).not.toBeChecked();
  await expect(
    hydrated.getByLabel('Show sidebar by default'),
  ).not.toBeChecked();
});

test('stale native revisions and late replies preserve newer local intent and unrelated committed fields through the actual adapter', async ({
  page,
}) => {
  const dialog = await settings(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('update_settings', { hold: 'old-ack' });
  });
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('dracula');
  await dialog
    .getByLabel('Light palette', { exact: true })
    .selectOption('nord');
  const current = record(5, { sidebarDefault: false, darkPalette: 'monokai' });
  const conflict = record(7, {
    sidebarDefault: false,
    darkPalette: 'monokai',
    fitDiagrams: false,
  });
  await page.evaluate(
    ({ current, conflict }) => {
      window.readerFixture.enqueue('update_settings', {
        value: { status: 'conflict', record: conflict },
      });
      window.readerFixture.enqueue('update_settings', { hold: 'latest-ack' });
      window.readerFixture.retain(conflict);
      return window.readerFixture.settingsEvent(current);
    },
    { current, conflict },
  );
  await page.evaluate(
    (value) => {
      window.readerFixture.release('old-ack', {
        value: { status: 'committed', record: value },
      });
    },
    record(1, { lightPalette: 'dracula' }),
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toEqual(['latest-ack']);
  await expect(dialog.getByLabel('Light palette', { exact: true })).toHaveValue(
    'nord',
  );
  await expect(dialog.getByLabel('Show sidebar by default')).not.toBeChecked();
  await expect(dialog.getByLabel('Fit diagrams to view')).not.toBeChecked();
  const calls = await page.evaluate(() =>
    window.readerFixture
      .settingsCalls()
      .filter((call) => call.command === 'update_settings'),
  );
  expect(calls.map((call) => call.payload)).toEqual([
    { expectedRevision: 0, patch: { lightPalette: 'dracula' } },
    { expectedRevision: 5, patch: { lightPalette: 'nord' } },
    { expectedRevision: 7, patch: { lightPalette: 'nord' } },
  ]);
  const latest = record(9, {
    lightPalette: 'nord',
    darkPalette: 'monokai',
    fitDiagrams: false,
    sidebarDefault: false,
    pageZoom: 150,
  });
  await page.evaluate(
    (value) => window.readerFixture.settingsEvent(value),
    latest,
  );
  await dialog.getByLabel('Appearance', { exact: true }).focus();
  await page.evaluate((value) => {
    window.readerFixture.release('latest-ack', {
      value: { status: 'committed', record: { ...value, revision: 8 } },
    });
  }, latest);
  await saved(page);
  await page.evaluate(
    (value) => window.readerFixture.settingsEvent(value),
    record(2),
  );
  await expect(dialog.getByLabel('Light palette', { exact: true })).toHaveValue(
    'nord',
  );
  await expect(dialog.getByLabel('Page zoom', { exact: true })).toHaveText(
    '150%',
  );
  await expect(dialog.getByLabel('Appearance', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
});

test('real modal keyboard containment/restoration, IME guards and feature menu event routing', async ({
  page,
}) => {
  const opener = page.getByRole('button', { name: 'Settings…' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const appearance = dialog.getByLabel('Appearance', { exact: true });
  await expect(appearance).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', { name: 'Close', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(appearance).toBeFocused();
  await appearance.dispatchEvent('compositionstart', { data: 'reading' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.readerFixture.menu('zoom-in'));
  await expect(dialog.getByLabel('Page zoom', { exact: true })).toHaveText(
    '100%',
  );
  await appearance.dispatchEvent('compositionend', { data: 'reading' });
  await page.evaluate(() => window.readerFixture.menu('zoom-in'));
  await expect(dialog.getByLabel('Page zoom', { exact: true })).toHaveText(
    '110%',
  );
  await saved(page);
  await expect(appearance).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await expect(dialog).toBeVisible();
  await expect(appearance).toBeFocused();
  await dialog.getByLabel('Show sidebar by default').focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByLabel('Show sidebar by default')).not.toBeChecked();
  await saved(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(opener).toBeFocused();
});

test('content-only 50–300 zoom has real reflow/scroll geometry while chrome and short modal stay usable', async ({
  page,
}, info) => {
  const open = page.getByRole('button', { name: 'Open File…' });
  const chrome = await open.boundingBox();
  const article = page.locator('article');
  const initial = await article.boundingBox();
  const dialog = await settings(page);
  const zoomControl = dialog.getByRole('button', {
    name: 'Increase page zoom',
  });
  const control = await zoomControl.boundingBox();
  for (let i = 0; i < 5; i++)
    await dialog.getByRole('button', { name: 'Decrease page zoom' }).click();
  await expect(dialog.getByLabel('Page zoom', { exact: true })).toHaveText(
    '50%',
  );
  await expect(
    dialog.getByRole('button', { name: 'Decrease page zoom' }),
  ).toBeDisabled();
  await expect(article).toHaveCSS('font-size', '8px');
  await dialog.getByRole('button', { name: 'Reset to 100%' }).click();
  await expect(article).toHaveCSS('font-size', '16px');
  for (let i = 0; i < 20; i++) await zoomControl.click();
  await expect(dialog.getByLabel('Page zoom', { exact: true })).toHaveText(
    '300%',
  );
  await expect(zoomControl).toBeDisabled();
  await expect(article).toHaveCSS('font-size', '48px');
  expect((await article.boundingBox())?.height).toBeGreaterThan(
    (initial?.height ?? 0) * 2,
  );
  expect((await zoomControl.boundingBox())?.height).toBe(control?.height);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect((await open.boundingBox())?.height).toBe(chrome?.height);
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await article
        .locator('pre')
        .last()
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    expect(
      await article
        .locator('table')
        .last()
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    // Prose wraps; wide tabular data stays compact and scrolls locally.
    expect(
      await article
        .locator('table')
        .last()
        .locator('tr')
        .last()
        .evaluate(
          (row) =>
            row.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(row).fontSize),
        ),
    ).toBeLessThan(4);
    await article
      .getByRole('heading', { name: 'End of document' })
      .scrollIntoViewIfNeeded();
    await expect(
      article.getByRole('heading', { name: 'End of document' }),
    ).toBeInViewport();
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await capture(page, info, 'narrow-300-640x800');
  await page.setViewportSize({ width: 640, height: 360 });
  const short = await settings(page);
  await short.getByRole('button', { name: 'Close', exact: true }).focus();
  await expect(
    short.getByRole('button', { name: 'Close', exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(short.getByLabel('Appearance', { exact: true })).toBeFocused();
  await expect(
    short.getByLabel('Appearance', { exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.readerFixture.menu('zoom-reset'));
  await expect(article).toHaveCSS('font-size', '16px');
  await saved(page);
  expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
});
