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
  await page.evaluate(() => window.readerFixture.menu('settings'));
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function saved(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  if (await dialog.isVisible()) {
    await expect(
      dialog.getByRole('region', { name: 'Preferences status' }),
    ).toContainText('Preferences saved.');
  } else {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.readerFixture
              .pending()
              .filter((name) => name.includes('ack') || name.includes('save'))
              .length,
        ),
      )
      .toBe(0);
    await expect(
      page.getByRole('region', { name: 'Preferences status' }),
    ).toHaveCount(0);
  }
}
const screenshotting = new WeakSet<Page>();
const webkitScreenshotDiagnostic =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
async function capture(page: Page, info: TestInfo, name: string) {
  const destination = process.env.TAURIMD_APPEARANCE_EVIDENCE;
  const path = destination
    ? join(destination, `${info.project.name}-${name}.png`)
    : info.outputPath(`${name}.png`);
  // Playwright 1.64.1 screenshotter injects "body {}" to sync WebKit animations.
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
    palette: await page.locator('html').getAttribute('data-palette'),
    zoom: await page.locator('article').getAttribute('data-zoom'),
    nativeBackendAndMenus: 'Explicit browser doubles; not native qualification',
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
      '.status-bar',
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
      width: Number.parseFloat(getComputedStyle(element).outlineWidth),
      offset: Number.parseFloat(getComputedStyle(element).outlineOffset),
      style: getComputedStyle(element).outlineStyle,
      box: element.getBoundingClientRect().toJSON() as {
        x: number;
        y: number;
        width: number;
        height: number;
      },
      dialog: element.closest('dialog')?.getBoundingClientRect().toJSON() as {
        x: number;
        y: number;
        width: number;
        height: number;
      },
      background: getComputedStyle(element).backgroundColor,
    }));
  expect(contrast(focus.outline, focus.background)).toBeGreaterThanOrEqual(3);
  expect(focus.width).toBeGreaterThanOrEqual(3);
  expect(focus.offset).toBeGreaterThanOrEqual(3);
  expect(focus.style).toBe('solid');
  expect(focus.box.x - focus.width - focus.offset).toBeGreaterThan(
    focus.dialog.x,
  );
  expect(focus.box.y - focus.width - focus.offset).toBeGreaterThan(
    focus.dialog.y,
  );
  expect(
    focus.box.x + focus.box.width + focus.width + focus.offset,
  ).toBeLessThan(focus.dialog.x + focus.dialog.width);
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
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
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
  await page.evaluate(() => window.readerFixture.menu('open'));
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'End of document' }),
  ).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

// Each slot/palette combination owns its test budget; the browser and server
// remain shared by the existing runner rather than restarted per combination.
for (const mode of ['light', 'dark'] as const) {
  for (const [id] of palettes) {
    test(`palette coverage: ${mode} slot / ${id} is legible with settled evidence`, async ({
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
      // Exercise a real boundary-disabled zoom control now that the unavailable
      // folder advertisement is no longer part of the reader shell.
      await page.evaluate(() => {
        const value = window.readerFixture.settings();
        return window.readerFixture.settingsEvent({
          ...value,
          revision: value.revision + 1,
          settings: { ...value.settings, pageZoom: 50 },
        });
      });
      await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(
        dialog.getByLabel('Appearance', { exact: true }),
      ).toBeFocused();
      const computed = await assertRoles(page);
      await dialog.getByRole('button', { name: 'Reset to 100%' }).click();
      await saved(page);
      const evidence = process.env.TAURIMD_APPEARANCE_EVIDENCE;
      if (evidence)
        writeFileSync(
          join(evidence, `${info.project.name}-${mode}-${id}-computed.json`),
          JSON.stringify(computed, null, 2),
        );
      if (mode === 'light' && id === 'nord')
        await capture(page, info, 'settings-focused-nord-1280x800');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(() => window.readerFixture.menu('guide'));
      const guide = page.getByRole('dialog', { name: 'User Guide' });
      await expect(
        guide.getByRole('link', { name: 'Opening and recovery', exact: true }),
      ).toBeVisible();
      const guideRoles = await guide
        .locator('h2, .guide p, .guide a, .guide pre, button')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const background = (element: Element): string => {
              const color = getComputedStyle(element).backgroundColor;
              return color === 'rgba(0, 0, 0, 0)' && element.parentElement
                ? background(element.parentElement)
                : color;
            };
            return {
              text: getComputedStyle(node).color,
              background: background(node),
            };
          }),
        );
      for (const role of guideRoles)
        expect(contrast(role.text, role.background)).toBeGreaterThanOrEqual(
          4.5,
        );
      if (mode === 'light' && id === 'nord')
        await capture(page, info, 'guide-focused-nord-1280x800');
      await guide.getByRole('button', { name: 'Close' }).click();
      if (mode === 'light') {
        await page.getByRole('main').evaluate((node) => {
          node.scrollTo(0, 0);
        });
        await capture(page, info, `${id}-100-1280x800`);
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
  }
}

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
  await page.getByRole('main').evaluate((node) => {
    node.scrollTo(0, 700);
  });
  const before = await page.evaluate(() => ({
    y: document.querySelector('main')?.scrollTop,
    article: document.querySelector('article')?.textContent,
  }));
  const readingNode = await page.locator('article h1').elementHandle();
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await dialog
    .getByLabel('Dark palette', { exact: true })
    .selectOption('githubDark');
  await saved(page);
  expect(await page.getByRole('main').evaluate((node) => node.scrollTop)).toBe(
    before.y,
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await readingNode.evaluate((node) => node.isConnected)).toBe(true);
  await readingNode.dispose();
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
  expect(await page.getByRole('main').evaluate((node) => node.scrollTop)).toBe(
    before.y,
  );
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
    hydrated.getByLabel('Show File Explorer by default'),
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
  await expect(
    dialog.getByLabel('Show File Explorer by default'),
  ).not.toBeChecked();
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

test('Fit to View fills the reader width, persists across reload, and syncs the menu check and dialog mirror', async ({
  page,
}) => {
  // A wide window is where the centered measure leaves real gutters; the
  // narrow default viewport would hide the difference between the states.
  await page.setViewportSize({ width: 1680, height: 900 });
  const measure = () =>
    page.evaluate(() => {
      const main = document.querySelector('main');
      const article = document.querySelector('article');
      const feedback = document.querySelector('.link-feedback');
      if (!(main instanceof HTMLElement) || !(article instanceof HTMLElement))
        throw new Error('Reader shell missing');
      const mainStyle = getComputedStyle(main);
      const padding =
        Number.parseFloat(mainStyle.paddingLeft) +
        Number.parseFloat(mainStyle.paddingRight);
      const box = article.getBoundingClientRect();
      return {
        attribute: main.hasAttribute('data-fit-view'),
        maxWidth: getComputedStyle(article).maxWidth,
        feedbackMaxWidth:
          feedback instanceof HTMLElement
            ? getComputedStyle(feedback).maxWidth
            : null,
        width: Math.round(box.width),
        available: Math.round(main.clientWidth - padding),
        rightGutter: Math.round(main.getBoundingClientRect().right - box.right),
        // Horizontal space the vertical scrollbar consumes (zero on overlay
        // scrollbar platforms, ~15px on classic ones); the reader hands this
        // space back to the viewport without changing the fill.
        scrollbar: main.offsetWidth - main.clientWidth,
        codeScroll: getComputedStyle(article.querySelector('pre') ?? article)
          .overflowX,
      };
    });
  // The default reading measure is centered and capped below the width the
  // reader column offers, so real gutters sit on both sides.
  const measured = await measure();
  expect(measured.attribute).toBe(false);
  expect(measured.maxWidth).not.toBe('none');
  expect(measured.feedbackMaxWidth).not.toBe('none');
  expect(measured.width).toBeLessThan(measured.available);
  expect(measured.rightGutter).toBeGreaterThan(48);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.fitToView),
    )
    .toBe(false);
  // View → Fit to View fills the reader column with normal padding only and
  // persists the same field the check item and the dialog mirror write.
  await page.evaluate(() => window.readerFixture.menu('fit-view'));
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.settings().settings.fitToView),
    )
    .toBe(true);
  expect(
    (await page.evaluate(() => window.readerFixture.settingsCalls())).at(-1),
  ).toEqual({
    command: 'update_settings',
    payload: { expectedRevision: 0, patch: { fitToView: true } },
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.fitToView),
    )
    .toBe(true);
  const filled = await measure();
  expect(filled.attribute).toBe(true);
  expect(filled.maxWidth).toBe('none');
  expect(filled.feedbackMaxWidth).toBe('none');
  // Relative geometry, not exact pixels: the filled column is meaningfully
  // wider than the centered measure at the same viewport, and its right edge
  // reaches the reader's content edge within normal padding. The tolerance
  // absorbs classic (non-overlay) scrollbars, whose width the reader gives
  // back to the viewport without changing the fill.
  expect(filled.width).toBeGreaterThan(measured.width + 48);
  expect(filled.rightGutter).toBeLessThanOrEqual(filled.scrollbar + 25);
  // Code blocks keep their overflow behavior inside the wider column.
  expect(measured.codeScroll).toBe('auto');
  expect(filled.codeScroll).toBe('auto');
  // The Settings dialog mirrors the same remembered choice.
  const dialog = await settings(page);
  await expect(dialog.getByLabel('Fit reader to window width')).toBeChecked();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // A reload restores the filled column from the retained record.
  await page.reload();
  await saved(page);
  await page.evaluate((source) => {
    window.readerFixture.enqueue('select_document', {
      value: {
        status: 'ready',
        snapshot: {
          documentId: 1,
          revision: 1,
          name: 'reading.md',
          location: 'fixture/reading.md',
          format: 'markdown',
          source,
        },
      },
    });
    return window.readerFixture.menu('open');
  }, rich);
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'End of document' }),
  ).toBeAttached();
  expect(await measure()).toEqual(filled);
  // Disabling restores the centered measured layout exactly.
  await page.evaluate(() => window.readerFixture.menu('fit-view'));
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.settings().settings.fitToView),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => window.readerFixture.presentation()?.fitToView),
    )
    .toBe(false);
  expect(await measure()).toEqual(measured);
  const again = await settings(page);
  await expect(
    again.getByLabel('Fit reader to window width'),
  ).not.toBeChecked();
});

test('real modal keyboard containment/restoration, IME guards and feature menu event routing', async ({
  page,
}) => {
  const opener = page.getByRole('article');
  await opener.focus();
  await page.evaluate(() => window.readerFixture.menu('settings'));
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
  await dialog.getByLabel('Show File Explorer by default').focus();
  await page.keyboard.press('Space');
  await expect(
    dialog.getByLabel('Show File Explorer by default'),
  ).not.toBeChecked();
  await saved(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(opener).toBeFocused();
});

test('content-only 50–300 zoom has real reflow/scroll geometry while chrome and short modal stay usable', async ({
  page,
}, info) => {
  const open = page.getByRole('button', { name: 'Document Information…' });
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
    await page.getByLabel('Displayed document').scrollIntoViewIfNeeded();
    const placement = await page.evaluate(() => {
      const main = document.querySelector('main')?.getBoundingClientRect();
      const status = document
        .querySelector('.status-bar')
        ?.getBoundingClientRect();
      return {
        mainBottom: main?.bottom ?? 0,
        statusTop: status?.top ?? 0,
        statusBottom: status?.bottom ?? 0,
        statusWidth: status?.width ?? 0,
        height: innerHeight,
        width: innerWidth,
      };
    });
    expect(placement.statusTop).toBeGreaterThanOrEqual(placement.mainBottom);
    expect(placement.statusBottom).toBeCloseTo(placement.height, 2);
    expect(placement.statusWidth).toBeLessThanOrEqual(placement.width);
    if (width === 640) await capture(page, info, 'status-bottom-300-640x800');
    await article
      .getByRole('heading', { name: 'End of document' })
      .scrollIntoViewIfNeeded();
    await expect(
      article.getByRole('heading', { name: 'End of document' }),
    ).toBeInViewport();
  }
  await page.getByRole('main').evaluate((node) => {
    node.scrollTo(0, 0);
  });
  await capture(page, info, 'narrow-300-640x800');
  await page.setViewportSize({ width: 640, height: 360 });
  await page.evaluate(() => window.readerFixture.menu('information'));
  const information = page.getByRole('dialog', {
    name: 'Document Information',
  });
  await expect(information).toContainText('nested-folder/');
  await capture(page, info, 'information-narrow-640x360');
  await information.getByRole('button', { name: 'Close' }).click();
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
