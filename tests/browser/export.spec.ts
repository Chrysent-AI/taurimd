import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Snapshot } from '../../src/types';
const gallery = readFileSync(
  new URL('../../examples/mermaid.md', import.meta.url),
  'utf8',
);
const errors = readFileSync(
  new URL('../../examples/mermaid-errors.md', import.meta.url),
  'utf8',
);
const flow =
  '\n```mermaid\nflowchart LR\n A[Whole original label] --> B[Full right edge]\n classDef chosen fill:#e0eeee,stroke:#336666,color:#112222\n class A chosen\n```\n';
async function open(page: Page, source: string, id = 1) {
  await page.evaluate(
    ({ source, id }) => {
      const snapshot: Snapshot = {
        documentId: id,
        revision: 1,
        name: `export-${String(id)}.md`,
        location: 'fixture/export.md',
        format: 'markdown',
        source,
      };
      window.readerFixture.enqueue('select_document', {
        value: { status: 'ready', snapshot },
      });
      return window.readerFixture.menu('open');
    },
    { source, id },
  );
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    `export-${String(id)}.md`,
  );
}
async function settled(page: Page) {
  await expect(
    page.locator('.diagram [role="status"]').filter({ hasText: 'Rendering' }),
  ).toHaveCount(0);
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
}
async function captured(page: Page) {
  return page.evaluate(() =>
    window.readerFixture
      .calls()
      .filter((call) => call.command === 'append_export_image')
      .map((call) => {
        const image = (
          call.payload as {
            image: {
              ordinal: number;
              bytes: Uint8Array;
              binding: { mode: 'svg' | 'png' };
            };
          }
        ).image;
        return {
          ordinal: image.ordinal,
          mode: image.binding.mode,
          bytes: Array.from(image.bytes),
        };
      }),
  );
}
async function record(
  page: Page,
  info: TestInfo,
  source: string,
  name: string,
) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
  writeFileSync(
    info.outputPath(`${name}.json`),
    JSON.stringify(
      {
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        engine: info.project.name,
        diagrams: await page.locator('.diagram svg').evaluateAll((svgs) =>
          svgs.map((svg) => ({
            viewBox: svg.getAttribute('viewBox'),
            text: svg.textContent,
          })),
        ),
        nativeQualification: 'NOT RUN; browser transport and Save doubles',
      },
      null,
      2,
    ),
  );
}
interface JourneyLabel {
  text: string;
  fill: string;
  background: string;
  bounds: { x: number; y: number; width: number; height: number };
}
async function inspectJourneyRaster(
  page: Page,
  bytes: number[],
  mime: 'image/svg+xml' | 'image/png',
  labels: JourneyLabel[],
  viewBox: string | null,
) {
  return page.evaluate(
    async ({ bytes, mime, labels, viewBox }) => {
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: mime }),
      );
      const image = new Image();
      const canvas = document.createElement('canvas');
      try {
        image.src = url;
        await image.decode();
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context)
          throw new Error('Journey inspection has no canvas context');
        context.drawImage(image, 0, 0);
        const box = viewBox?.split(/[\s,]+/).map(Number);
        if (!box || box.length !== 4)
          throw new Error('Journey has no whole viewBox');
        const [originX = 0, originY = 0, width = 0, height = 0] = box;
        const rgb = (color: string) => {
          const values = color.match(/\d+/g)?.map(Number);
          if (values?.length !== 3)
            throw new Error(`Unexpected journey RGB fill: ${color}`);
          return values;
        };
        const samples = labels.map((label) => {
          const foreground = rgb(label.fill);
          const background = rgb(label.background);
          const left = Math.max(
            0,
            Math.floor(((label.bounds.x - originX) * canvas.width) / width),
          );
          const top = Math.max(
            0,
            Math.floor(((label.bounds.y - originY) * canvas.height) / height),
          );
          const right = Math.min(
            canvas.width,
            Math.ceil(
              ((label.bounds.x + label.bounds.width - originX) * canvas.width) /
                width,
            ),
          );
          const bottom = Math.min(
            canvas.height,
            Math.ceil(
              ((label.bounds.y + label.bounds.height - originY) *
                canvas.height) /
                height,
            ),
          );
          const pixels = context.getImageData(
            left,
            top,
            right - left,
            bottom - top,
          ).data;
          let textPixels = 0;
          let backgroundPixels = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (!pixels[offset + 3]) continue;
            let toText = 0;
            let toBackground = 0;
            for (let channel = 0; channel < 3; channel++) {
              toText +=
                ((pixels[offset + channel] ?? 0) -
                  (foreground[channel] ?? 0)) **
                2;
              toBackground +=
                ((pixels[offset + channel] ?? 0) -
                  (background[channel] ?? 0)) **
                2;
            }
            // Classify each glyph region against its actual foreground/background,
            // allowing antialiasing without introducing a contrast-ratio quota.
            if (toText < toBackground) textPixels++;
            else backgroundPixels++;
          }
          return {
            text: label.text,
            fill: label.fill,
            background: label.background,
            region: { left, top, right, bottom },
            textPixels,
            backgroundPixels,
          };
        });
        const preview = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Journey preview serialization failed'));
          }, 'image/png');
        });
        return {
          width: canvas.width,
          height: canvas.height,
          samples,
          preview: Array.from(new Uint8Array(await preview.arrayBuffer())),
        };
      } finally {
        image.removeAttribute('src');
        URL.revokeObjectURL(url);
        canvas.width = canvas.height = 0;
      }
    },
    { bytes, mime, labels, viewBox },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(2);
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await info.attach('failed-dom', {
      body: await page.content(),
      contentType: 'text/html',
    });
    await info.attach('failed-calls', {
      body: JSON.stringify(
        await page.evaluate(() => window.readerFixture.calls()),
      ),
      contentType: 'application/json',
    });
  }
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
  expect(await page.evaluate(() => window.readerFixture.activeWorkers())).toBe(
    0,
  );
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
});
for (const mode of ['svg', 'png'] as const)
  test(`real twelve-type corpus exports whole ${mode} images after pan without changing the reader`, async ({
    page,
  }, info) => {
    await open(page, gallery);
    await expect(page.locator('.diagram svg')).toHaveCount(12);
    await settled(page);
    const first = page.locator('.diagram').first();
    await first.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await first.getByRole('button', { name: 'Pan right', exact: true }).click();
    const before = await page.evaluate(() => {
      const article = document.querySelector('article');
      const figure = document.querySelector('.diagram');
      const main = document.querySelector('main');
      const svg = figure?.querySelector('svg');
      const range = document.createRange();
      const text = article?.querySelector('h1')?.firstChild;
      if (text) {
        range.selectNodeContents(text);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      const retained = {
        article,
        figure,
        svg,
        main,
        transform:
          figure?.querySelector<HTMLElement>('.diagram-scene')?.style.transform,
        selection: getSelection()?.toString(),
        scroll: main?.scrollTop,
        calls: window.readerFixture.calls().length,
        parses: window.readerFixture.parses(),
      };
      Object.assign(window, { retainedExport: retained });
      return { calls: retained.calls, parses: retained.parses };
    });
    const dimensions = await page.locator('.diagram svg').evaluateAll((svgs) =>
      svgs.map((svg) =>
        svg
          .getAttribute('viewBox')
          ?.split(/[\s,]+/)
          .map(Number),
      ),
    );
    await page.evaluate((mode) => {
      window.readerFixture.enqueue('finish_export', { hold: 'native-save' });
      return window.readerFixture.menu(
        mode === 'svg' ? 'export-svg' : 'export-png',
      );
    }, mode);
    await expect
      .poll(() => page.evaluate(() => window.readerFixture.pending()))
      .toContain('native-save');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(
      page.getByText(
        'Finishing ZIP and choosing destination… Use the native dialog to cancel.',
      ),
    ).toBeVisible();
    const images = await captured(page);
    expect(images).toHaveLength(12);
    expect(images.map((image) => image.ordinal)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    for (const [index, image] of images.entries()) {
      const geometry = dimensions[index];
      expect(geometry).toHaveLength(4);
      if (mode === 'svg') {
        const svg = new TextDecoder().decode(new Uint8Array(image.bytes));
        expect(svg).toContain(`viewBox="${geometry?.join(' ') ?? ''}"`);
        expect(svg).toContain('max-width: none');
        expect(svg).toContain('<style>');
        expect(svg).not.toContain('diagram-scene');
      } else {
        expect(image.bytes.slice(0, 8)).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        const view = new DataView(new Uint8Array(image.bytes).buffer);
        expect(view.getUint32(16)).toBe(Math.ceil(geometry?.[2] ?? 0));
        expect(view.getUint32(20)).toBe(Math.ceil(geometry?.[3] ?? 0));
        const ink = await page.evaluate(async (bytes) => {
          const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          const image = new Image();
          try {
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('No context');
            ctx.drawImage(image, 0, 0);
            const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            const colors = new Set<string>();
            let dark = 0;
            let chosenFill = 0;
            let chosenStroke = 0;
            let chosenText = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if ((pixels[offset + 3] ?? 0) > 0) {
                if (
                  pixels[offset] === 224 &&
                  pixels[offset + 1] === 238 &&
                  pixels[offset + 2] === 238
                )
                  chosenFill++;
                // Thin strokes/glyphs blend with the fill at fractional geometry.
                // Check their expected color direction, not an exact un-antialiased
                // pixel on every browser's text/stroke rasterizer.
                const red = pixels[offset] ?? 255;
                const green = pixels[offset + 1] ?? 255;
                const blue = pixels[offset + 2] ?? 255;
                if (
                  red >= 51 &&
                  red <= 160 &&
                  green >= 102 &&
                  green <= 185 &&
                  Math.abs(green - blue) <= 3 &&
                  green - red >= 20
                )
                  chosenStroke++;
                if (
                  green < 140 &&
                  Math.abs(green - blue) <= 2 &&
                  green - red >= 10 &&
                  green - red <= 20
                )
                  chosenText++;
                colors.add(
                  `${String(pixels[offset])},${String(pixels[offset + 1])},${String(pixels[offset + 2])}`,
                );
                if (
                  (pixels[offset] ?? 255) < 150 &&
                  (pixels[offset + 1] ?? 255) < 150 &&
                  (pixels[offset + 2] ?? 255) < 150
                )
                  dark++;
              }
            }
            canvas.width = canvas.height = 0;
            return {
              colors: colors.size,
              dark,
              chosenFill,
              chosenStroke,
              chosenText,
            };
          } finally {
            image.removeAttribute('src');
            URL.revokeObjectURL(url);
          }
        }, image.bytes);
        expect(ink.colors).toBeGreaterThan(8);
        expect(ink.dark).toBeGreaterThan(30);
        if (index === 0) {
          writeFileSync(
            info.outputPath('style-pixels.json'),
            JSON.stringify(ink, null, 2),
          );
          expect(ink.chosenFill).toBeGreaterThan(50);
          expect(ink.chosenStroke).toBeGreaterThan(5);
          expect(ink.chosenText).toBeGreaterThan(5);
        }
      }
      writeFileSync(
        info.outputPath(
          `diagram-${String(image.ordinal).padStart(3, '0')}.${mode}`,
        ),
        new Uint8Array(image.bytes),
      );
    }
    await page.evaluate(() => {
      void window.readerFixture.menu('settings');
      void window.readerFixture.menu('open');
      void window.readerFixture.menu('reload');
      void window.readerFixture.menu('export-png');
    });
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect((await captured(page)).length).toBe(12);
    await page.evaluate(() => {
      window.readerFixture.release('native-save', {
        value: {
          status: 'committed',
          count: 12,
          location: 'selected/diagrams.zip',
        },
      });
    });
    await expect(
      page.getByText(
        `Exported 12 ${mode.toUpperCase()} diagrams to selected/diagrams.zip.`,
      ),
    ).toBeVisible();
    const after = await page.evaluate(() => {
      const retained = (
        window as unknown as {
          retainedExport: {
            article: Element;
            figure: Element;
            svg: Element;
            main: HTMLElement;
            transform: string;
            selection: string;
            scroll: number;
          };
        }
      ).retainedExport;
      return {
        article: retained.article === document.querySelector('article'),
        figure: retained.figure === document.querySelector('.diagram'),
        svg: retained.svg === document.querySelector('.diagram svg'),
        transform:
          retained.transform ===
          document.querySelector<HTMLElement>('.diagram-scene')?.style
            .transform,
        selection: retained.selection === getSelection()?.toString(),
        scroll: retained.scroll === retained.main.scrollTop,
        parses: window.readerFixture.parses(),
        calls: window.readerFixture
          .calls()
          .slice(0, 2)
          .map((call) => call.command),
      };
    });
    expect(after).toEqual({
      article: true,
      figure: true,
      svg: true,
      transform: true,
      selection: true,
      scroll: true,
      parses: before.parses,
      calls: ['select_document', 'commit_document'],
    });
    await record(page, info, gallery, `whole-${mode}`);
  });
for (const palette of ['githubLight', 'githubDark'] as const)
  test(`journey section and task labels remain readable in inline SVG standalone SVG and PNG with ${palette}`, async ({
    page,
  }, info) => {
    await page.evaluate((palette) => {
      const record = window.readerFixture.settings();
      return window.readerFixture.settingsEvent({
        ...record,
        revision: record.revision + 1,
        settings: {
          ...record.settings,
          mode: palette === 'githubLight' ? 'light' : 'dark',
          lightPalette: 'githubLight',
          darkPalette: 'githubDark',
        },
      });
    }, palette);
    await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
    await open(page, gallery);
    await expect(page.locator('.diagram svg')).toHaveCount(12);
    await settled(page);
    const journey = page.locator('.diagram').nth(7);
    await expect(journey).toHaveAttribute('data-palette', palette);
    const inline = await journey.locator('svg').evaluate((element) => {
      const svg = element as SVGSVGElement;
      const viewBox = svg.getAttribute('viewBox');
      const values = viewBox?.split(/[\s,]+/).map(Number);
      if (!values || values.length !== 4)
        throw new Error('Journey has no whole viewBox');
      const [originX = 0, originY = 0, width = 0, height = 0] = values;
      const viewport = svg.getBoundingClientRect();
      const labels = [
        ...svg.querySelectorAll<SVGTextElement>(
          'text.journey-section, text.task',
        ),
      ].map((text) => {
        const rect = text.parentElement?.querySelector('rect');
        if (!rect) throw new Error('Journey label has no box');
        const bounds = text.getBoundingClientRect();
        return {
          text: text.textContent.trim(),
          fill: getComputedStyle(text).fill,
          background: getComputedStyle(rect).fill,
          bounds: {
            // Map reader CSS pixels back to the full image, including its
            // viewBox origin, independently of the scene's fit/pan transform.
            x: originX + ((bounds.x - viewport.x) * width) / viewport.width,
            y: originY + ((bounds.y - viewport.y) * height) / viewport.height,
            width: (bounds.width * width) / viewport.width,
            height: (bounds.height * height) / viewport.height,
          },
        };
      });
      return {
        expected: getComputedStyle(document.documentElement).color,
        viewBox,
        labels,
      };
    });
    expect(inline.labels.map((label) => label.text)).toEqual([
      'Prepare',
      'Choose a document',
      'Set a palette',
      'Read',
      'Follow headings',
      'Review a diagram',
    ]);
    for (const label of inline.labels) {
      expect(label.fill).toBe(inline.expected);
      expect(label.fill).not.toBe(label.background);
      expect(label.bounds.width).toBeGreaterThan(0);
      expect(label.bounds.height).toBeGreaterThan(0);
    }
    writeFileSync(
      info.outputPath(`journey-${palette}-inline.json`),
      JSON.stringify(inline, null, 2),
    );
    await journey.screenshot({
      path: info.outputPath(`journey-${palette}-reader.png`),
    });
    const rasters = [];
    for (const mode of ['svg', 'png'] as const) {
      await page.evaluate((mode) => {
        window.readerFixture.enqueue('finish_export', {
          hold: `journey-${mode}`,
        });
        return window.readerFixture.menu(
          mode === 'svg' ? 'export-svg' : 'export-png',
        );
      }, mode);
      await expect
        .poll(() => page.evaluate(() => window.readerFixture.pending()))
        .toContain(`journey-${mode}`);
      const images = (await captured(page)).filter(
        (image) => image.mode === mode,
      );
      expect(images).toHaveLength(12);
      const image = images.find((image) => image.ordinal === 8);
      if (!image) throw new Error('The gallery journey was not exported');
      writeFileSync(
        info.outputPath(`journey-${palette}.${mode}`),
        new Uint8Array(image.bytes),
      );
      if (mode === 'svg') {
        const svg = new TextDecoder().decode(new Uint8Array(image.bytes));
        expect(svg).toContain('text.journey-section');
        expect(svg).toContain('text.task');
        expect(svg).toContain(`viewBox="${inline.viewBox ?? ''}"`);
      }
      const raster = await inspectJourneyRaster(
        page,
        image.bytes,
        mode === 'svg' ? 'image/svg+xml' : 'image/png',
        inline.labels,
        inline.viewBox,
      );
      writeFileSync(
        info.outputPath(`journey-${palette}-${mode}-raster.png`),
        new Uint8Array(raster.preview),
      );
      writeFileSync(
        info.outputPath(`journey-${palette}-${mode}-pixels.json`),
        JSON.stringify(raster.samples, null, 2),
      );
      expect(raster.samples).toHaveLength(6);
      for (const sample of raster.samples) {
        expect(
          sample.textPixels,
          `${mode}: ${sample.text} glyphs`,
        ).toBeGreaterThan(0);
        expect(
          sample.backgroundPixels,
          `${mode}: ${sample.text} background`,
        ).toBeGreaterThan(0);
      }
      rasters.push({
        mode,
        width: raster.width,
        height: raster.height,
        samples: raster.samples,
      });
      await page.evaluate((mode) => {
        window.readerFixture.release(`journey-${mode}`, {
          value: { status: 'cancelled' },
        });
      }, mode);
      await expect(
        page.getByText('Export cancelled.', { exact: true }),
      ).toBeVisible();
    }
    writeFileSync(
      info.outputPath(`journey-${palette}-labels.json`),
      JSON.stringify(
        {
          engine: info.project.name,
          sourceSha256: createHash('sha256').update(gallery).digest('hex'),
          palette,
          inline,
          rasters,
          nativeQualification:
            'NOT RUN; actual App SVG/canvas with native Save transport double',
        },
        null,
        2,
      ),
    );
  });

test('partial failures require consent before native begin, preserve gaps and cancel Save normally with hidden status', async ({
  page,
}, info) => {
  await open(page, errors);
  await settled(page);
  await expect(page.locator('.diagram svg')).toHaveCount(2);
  await page.evaluate(() => window.readerFixture.menu('status-bar'));
  await page.evaluate(() => window.readerFixture.menu('export-svg'));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'Diagrams 2 could not render and will be omitted. Files will be numbered 1, 3.',
  );
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).some(
      (call) => call.command === 'begin_export',
    ),
  ).toBe(false);
  await expect(dialog.getByRole('heading')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', { name: 'Export 2 diagrams…' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.getByText('Export cancelled.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.readerFixture.menu('export-svg'));
  await dialog.getByRole('button', { name: 'Export 2 diagrams…' }).click();
  await expect(
    page.getByText('Export cancelled.', { exact: true }),
  ).toBeVisible();
  expect((await captured(page)).map((image) => image.ordinal)).toEqual([1, 3]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await record(page, info, errors, 'partial-save-cancel');
});
test('no success and pending applied palette never export a retained old SVG or queue Save', async ({
  page,
}) => {
  await open(page, '# No diagrams');
  await page.evaluate(() => window.readerFixture.menu('export-svg'));
  await expect(
    page.getByText('No diagrams to export.', { exact: true }),
  ).toBeVisible();
  await open(page, '\n```mermaid\nnot a diagram\n```', 2);
  await settled(page);
  await page.evaluate(() => window.readerFixture.menu('export-png'));
  await expect(
    page.getByText('No successfully rendered diagrams to export.', {
      exact: true,
    }),
  ).toBeVisible();
  await open(page, flow, 3);
  await settled(page);
  await page.evaluate(() => {
    window.readerFixture.holdDiagram();
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: { ...record.settings, mode: 'light', lightPalette: 'nord' },
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.diagrams().held))
    .toBe(true);
  await page.evaluate(() => window.readerFixture.menu('export-svg'));
  await expect(
    page.getByText(
      'Diagrams are still rendering. Try export when rendering finishes.',
    ),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).some(
      (call) => call.command === 'begin_export',
    ),
  ).toBe(false);
  await page.evaluate(() => {
    window.readerFixture.releaseDiagram();
  });
  await settled(page);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).some(
      (call) => call.command === 'begin_export',
    ),
  ).toBe(false);
});
test('Cancel is requested until native cleanup acknowledges; guards reject duplicates and focus restores once', async ({
  page,
}) => {
  await open(page, flow);
  await settled(page);
  const viewport = page.locator('.diagram-viewport');
  await viewport.focus();
  await page.evaluate(() => {
    window.readerFixture.enqueue('append_export_image', { hold: 'append' });
    window.readerFixture.enqueue('cancel_export', { hold: 'cancel' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('append');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toContainText(
    'Cancel requested… Finishing the current step and cleaning up.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    void window.readerFixture.menu('guide');
    void window.readerFixture.menu('open');
    void window.readerFixture.menu('export-svg');
    window.readerFixture.release('append', { value: null });
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('cancel');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    window.readerFixture.release('cancel', { value: null });
  });
  await expect(
    page.getByText('Export cancelled.', { exact: true }),
  ).toBeVisible();
  await expect(viewport).toBeFocused();
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).filter(
      (call) => call.command === 'finish_export',
    ),
  ).toHaveLength(0);
});
for (const failure of [
  'image',
  'decode',
  'font',
  'context',
  'blank',
  'taint',
  'null',
] as const)
  test(`new ${failure} conversion failure stops instead of silently omitting; releases resources and keeps hidden-status recovery`, async ({
    page,
  }) => {
    await open(page, flow + flow);
    await settled(page);
    await page.evaluate((failure) => {
      const urls = new Set<string>();
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const value = create(blob);
        urls.add(value);
        return value;
      };
      URL.revokeObjectURL = (value) => {
        urls.delete(value);
        revoke(value);
      };
      Object.assign(window, { exportURLs: urls });
      if (failure === 'image')
        Object.defineProperty(window, 'Image', {
          configurable: true,
          value: function failingImage() {
            throw new Error('injected image allocation');
          },
        });
      if (failure === 'context')
        HTMLCanvasElement.prototype.getContext = () => null;
      if (failure === 'decode')
        HTMLImageElement.prototype.decode = () =>
          Promise.reject(new Error('injected decode'));
      if (failure === 'font') {
        const prototype = Reflect.getPrototypeOf(document.fonts);
        if (!prototype) throw new Error('FontFaceSet prototype is unavailable');
        Object.defineProperty(prototype, 'load', {
          configurable: true,
          value: () => Promise.reject(new Error('injected font')),
        });
      }
      if (failure === 'blank')
        CanvasRenderingContext2D.prototype.drawImage = () => {};
      if (failure === 'taint')
        CanvasRenderingContext2D.prototype.getImageData = () => {
          throw new DOMException('injected taint', 'SecurityError');
        };
      if (failure === 'null')
        HTMLCanvasElement.prototype.toBlob = (callback) => {
          callback(null);
        };
    }, failure);
    await page.evaluate(() => window.readerFixture.menu('status-bar'));
    await page.evaluate(() => window.readerFixture.menu('export-png'));
    await expect(page.getByRole('alert')).toContainText(
      /Export stopped: Diagram 1/,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.readerFixture.calls())).filter(
        (call) =>
          call.command === 'append_export_image' ||
          call.command === 'finish_export',
      ),
    ).toHaveLength(0);
    expect(
      (await page.evaluate(() => window.readerFixture.calls())).filter(
        (call) => call.command === 'cancel_export',
      ),
    ).toHaveLength(1);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { exportURLs: Set<string> }).exportURLs.size,
      ),
    ).toBe(0);
    await expect(page.getByRole('article')).toContainText(
      'Whole original label',
    );
  });
test('applied palette retirement during native Save requests cleanup without a DOM modal and reports an already committed result truthfully', async ({
  page,
}) => {
  await open(page, flow);
  await settled(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', { hold: 'save' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('save');
  await page.evaluate(() => {
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: { ...record.settings, mode: 'light', lightPalette: 'nord' },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.readerFixture
            .calls()
            .filter((call) => call.command === 'cancel_export').length,
      ),
    )
    .toBe(1);
  await expect(
    page.getByText(
      'Finishing ZIP and choosing destination… Use the native dialog to cancel.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    window.readerFixture.release('save', {
      value: {
        status: 'committed',
        count: 1,
        location: 'selected/committed.zip',
      },
    });
  });
  await expect(
    page.getByText('Exported 1 SVG diagrams to selected/committed.zip.'),
  ).toBeVisible();
});

test('partial consent wraps at narrow high reading zoom and composition Escape does not dismiss it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await open(page, errors);
  await settled(page);
  await page.evaluate(() => {
    const record = window.readerFixture.settings();
    return window.readerFixture.settingsEvent({
      ...record,
      revision: record.revision + 1,
      settings: {
        ...record.settings,
        pageZoom: 300,
        mode: 'light',
        lightPalette: 'solarizedDark',
      },
    });
  });
  await expect(page.locator('.diagram').first()).toHaveAttribute(
    'data-palette',
    'solarizedDark',
  );
  await settled(page);
  await page.evaluate(() => window.readerFixture.menu('export-png'));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Files will be numbered 1, 3.');
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  for (const name of ['Cancel', 'Export 2 diagrams…'])
    await expect(
      dialog.getByRole('button', { name, exact: true }),
    ).toBeInViewport();
  await dialog.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('Export cancelled.', { exact: true }),
  ).toBeVisible();
});

test('unmount while native Save is held requests native retirement and ignores the late frontend completion', async ({
  page,
}) => {
  await open(page, flow);
  await settled(page);
  await page.evaluate(() => {
    window.readerFixture.enqueue('finish_export', { hold: 'late-save' });
    return window.readerFixture.menu('export-svg');
  });
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.pending()))
    .toContain('late-save');
  await page.evaluate(() => {
    window.readerFixture.unmount();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.readerFixture
            .calls()
            .filter((call) => call.command === 'cancel_export').length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    window.readerFixture.release('late-save', {
      value: { status: 'cancelled' },
    });
  });
  await expect(page.locator('#root')).toBeEmpty();
  expect(await page.evaluate(() => window.readerFixture.listenerCount())).toBe(
    0,
  );
});
