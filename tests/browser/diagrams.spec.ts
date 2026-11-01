import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { palettes } from '../../src/settings/model';
import type { Snapshot } from '../../src/types';
const fence = (source: string) => `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n`;
const flow =
  'flowchart LR\n A[Read locally] -->|offline| B[Inspect]\n classDef chosen fill:#e0eeee,stroke:#336666,color:#112222\n class A chosen';
async function open(
  page: Page,
  source: string,
  id = 1,
  format: Snapshot['format'] = 'markdown',
) {
  await page.evaluate(
    ({ source, id, format }) => {
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: id,
            revision: 1,
            name: `diagrams-${String(id)}.md`,
            location: 'fixture/diagrams.md',
            format,
            source,
          },
        },
      });
      return window.readerFixture.menu('open');
    },
    { source, id, format },
  );
  await expect(page.getByRole('article')).toHaveAttribute(
    'aria-label',
    `diagrams-${String(id)}.md`,
  );
}
async function settle(page: Page, count: number) {
  await expect(page.locator('.diagram-scene > svg')).toHaveCount(count);
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
  await expect(
    page.locator('.diagram [role="status"]').filter({ hasText: 'Rendering' }),
  ).toHaveCount(0);
}
async function record(
  page: Page,
  info: TestInfo,
  name: string,
  source: string,
) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
  const geometry = await page.locator('.diagram').evaluateAll((figures) =>
    figures.map((figure) => {
      const viewport = figure.querySelector('.diagram-viewport');
      const svg = figure.querySelector('svg');
      return {
        palette: figure.getAttribute('data-palette'),
        viewport: viewport
          ? {
              x: viewport.getBoundingClientRect().x,
              y: viewport.getBoundingClientRect().y,
              width: viewport.getBoundingClientRect().width,
              height: viewport.getBoundingClientRect().height,
            }
          : null,
        svg: svg
          ? {
              width: svg.getBoundingClientRect().width,
              height: svg.getBoundingClientRect().height,
            }
          : null,
        viewBox: svg?.getAttribute('viewBox'),
        text: svg?.textContent,
        transform:
          figure.querySelector<HTMLElement>('.diagram-scene')?.style.transform,
      };
    }),
  );
  writeFileSync(
    info.outputPath(`${name}.json`),
    JSON.stringify(
      {
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        engine: info.project.name,
        geometry,
        calls: await page.evaluate(() => window.readerFixture.calls()),
        diagrams: await page.evaluate(() => window.readerFixture.diagrams()),
        nativeQualification: 'NOT RUN; browser native adapter double',
      },
      null,
      2,
    ),
  );
}
test.beforeEach(async ({ page }) => {
  await page.goto(
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await info.attach('failed-dom', {
      body: await page.content(),
      contentType: 'text/html',
    });
    await info.attach('failed-state', {
      body: JSON.stringify(
        await page.evaluate(() => ({
          state: window.readerFixture.state(),
          diagrams: window.readerFixture.diagrams(),
        })),
      ),
      contentType: 'application/json',
    });
  }
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
  expect(await page.evaluate(() => window.readerFixture.activeWorkers())).toBe(
    0,
  );
});
test('real offline engine renders ordered flow sequence class duplicates and local escaped failures and limits', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      requests.push(request.url());
  });
  const source =
    '# Offline diagrams\n\n<pre class="mermaid" data-reader-diagram="9">author lookalike</pre>' +
    fence(flow) +
    fence('sequenceDiagram\n Alice->>Bob: Read safely\n Bob-->>Alice: Done') +
    fence('classDiagram\n Reader <|-- LocalReader\n Reader : +open()') +
    fence(flow) +
    fence('not a diagram <script>bad()</script>') +
    fence('flowchart LR\n' + ' '.repeat(50_001)) +
    fence(
      'flowchart LR\n' +
        Array.from(
          { length: 501 },
          (_, i) => `A${String(i)}-->A${String(i + 1)}`,
        ).join('\n'),
    ) +
    fence('flowchart LR\n C[Following valid]-->D[Still readable]') +
    '\n## Following Markdown\n\n<img src="https://invalid.example/ordinary" onerror="alert(1)"><iframe src="https://invalid.example/frame"></iframe>';
  await open(page, source);
  await settle(page, 5);
  await expect(page.locator('.diagram')).toHaveCount(8);
  await expect(page.locator('.diagram').nth(4)).toContainText(
    'could not render',
  );
  await expect(page.locator('.diagram').nth(4).locator('script')).toHaveCount(
    0,
  );
  await expect(page.locator('.diagram').nth(5)).toContainText(
    '50,000-character',
  );
  await expect(page.locator('.diagram').nth(6)).toContainText(/500|edge/i);
  await expect(
    page.getByRole('heading', { name: 'Following Markdown' }),
  ).toBeVisible();
  await expect(
    page.locator('article iframe, article script, article img[src]'),
  ).toHaveCount(0);
  await expect(page.locator('.diagram').first().locator('svg')).toContainText(
    'Read locally',
  );
  await expect(page.locator('.diagram').nth(1).locator('svg')).toContainText(
    'Read safely',
  );
  await expect(page.locator('.diagram').nth(2).locator('svg')).toContainText(
    'LocalReader',
  );
  expect(
    await page.locator('.diagram').first().locator('marker').count(),
  ).toBeGreaterThan(0);
  await page
    .locator('.diagram')
    .first()
    .getByText('Original definition', { exact: true })
    .click();
  await expect(page.locator('.diagram').first().locator('pre')).toHaveText(
    flow,
  );
  expect(requests).toEqual([]);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).map(
      (call) => call.command,
    ),
  ).toEqual(['select_document', 'commit_document']);
  const ids = await page
    .locator('.diagram svg')
    .evaluateAll((items) => items.map((item) => item.id));
  expect(new Set(ids).size).toBe(5);
  await record(page, info, 'real-engine-local-errors', source);
  for (const ordinal of [0, 1, 2, 3, 7]) {
    const viewport = page
      .locator('.diagram')
      .nth(ordinal)
      .locator('.diagram-viewport');
    await viewport.scrollIntoViewIfNeeded();
    await viewport.screenshot({
      path: info.outputPath(`ordinary-diagram-${String(ordinal + 1)}.png`),
    });
  }
});
test('real example files render twelve offline varieties and recover after the intentional error', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      requests.push(request.url());
  });
  const gallery = readFileSync(
    new URL('../../examples/mermaid.md', import.meta.url),
    'utf8',
  );
  await open(page, gallery);
  await settle(page, 12);
  await expect(page.locator('.diagram')).toHaveCount(12);
  await expect(page.locator('.diagram-scene > svg')).toContainText([
    'Read offline',
    'Local snapshot exchange',
    'LocalReader',
    'Reloading',
    'COLLECTION',
    'Offline review schedule',
    'Document mix',
    'Quiet reading session',
    'combined',
    'Reading checklist',
    'Handbook revisions',
    'Review priorities',
  ]);
  await expect(page.locator('.diagram [role="status"]')).toHaveText(
    Array<string>(12).fill(''),
  );
  expect(
    await page.locator('.diagram-scene > svg').evaluateAll((svgs) =>
      svgs.every((svg) => {
        const box = (svg as SVGSVGElement).viewBox.baseVal;
        const bounds = svg.getBoundingClientRect();
        return (
          [
            box.x,
            box.y,
            box.width,
            box.height,
            bounds.width,
            bounds.height,
          ].every(Number.isFinite) &&
          box.width > 0 &&
          box.height > 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      }),
    ),
  ).toBe(true);
  await expect(page.locator('article pre').last()).toContainText(
    'Not rendered',
  );
  await record(page, info, 'example-gallery', gallery);
  const errors = readFileSync(
    new URL('../../examples/mermaid-errors.md', import.meta.url),
    'utf8',
  );
  await open(page, errors, 2);
  await settle(page, 2);
  await expect(page.locator('.diagram')).toHaveCount(3);
  await expect(page.locator('.diagram').nth(1)).toContainText(
    'Diagram 2 could not render:',
  );
  await expect(page.locator('.diagram').nth(1).locator('svg')).toHaveCount(0);
  await expect(page.locator('.diagram-scene > svg')).toContainText([
    'Café & tea',
    'Café & tea',
  ]);
  await page
    .locator('.diagram')
    .last()
    .getByText('Original definition', { exact: true })
    .click();
  await expect(page.locator('.diagram').last().locator('pre')).toContainText(
    'Café & tea',
  );
  await expect(
    page.getByRole('heading', { name: 'Reading continues' }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await record(page, info, 'example-local-error', errors);
});
test('strict built-in configuration resists diagram directives, never binds, and CSP blocks remote image delivery', async ({
  page,
}, info) => {
  const attempted: string[] = [];
  const delivered: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('invalid.example'))
      attempted.push(request.url());
  });
  await page.route('https://invalid.example/**', async (route) => {
    delivered.push(route.request().url());
    await route.abort();
  });
  await page.evaluate(() => {
    Object.assign(window, { diagramCsp: [] });
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { diagramCsp: unknown[] }).diagramCsp.push({
        blocked: event.blockedURI,
        directive: event.effectiveDirective,
      });
    });
  });
  const source =
    '---\nsecurityLevel: loose\nhtmlLabels: true\n---\n' +
    fence(
      `---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  theme: dark\n  themeCSS: '.node { fill: #ff00ff; }'\n  flowchart:\n    htmlLabels: true\n---\n%%{init: {"securityLevel":"loose","htmlLabels":true,"themeVariables":{"primaryColor":"#ff00ff"},"sequence":{"htmlLabels":true}}}%%\nflowchart LR\n A[Safe label]-->B[Still strict]\n click A call hostileCallback()`,
    ) +
    fence(
      'flowchart LR\n Remote@{ img: "https://invalid.example/diagram.png", label: "Blocked remote" }',
    ) +
    fence('flowchart LR\n After[After blocked resource]-->Valid');
  await open(page, source);
  await settle(page, 2);
  await expect(
    page.locator('.diagram').nth(1).locator('p[role="status"]'),
  ).toContainText('Diagram 2 could not render:');
  await expect(
    page.locator('.diagram').first().locator('svg style'),
  ).not.toContainText('#ff00ff');
  await expect(
    page.locator('.diagram foreignObject, article iframe, article script'),
  ).toHaveCount(0);
  await expect(page.locator('.diagram').first().locator('svg')).toContainText(
    'Safe label',
  );
  const first = await page.evaluate(() => window.readerFixture.diagrams());
  expect(first.bindings).toBe(0);
  expect(first.initializations).toBe(3);
  expect(first.renders[0]?.config).toMatchObject({
    securityLevel: 'strict',
    startOnLoad: false,
    htmlLabels: false,
    suppressErrorRendering: true,
    maxEdges: 500,
    maxTextSize: 50_000,
    theme: 'base',
  });
  const violations = await page.evaluate(
    () =>
      (
        window as unknown as {
          diagramCsp: { blocked: string; directive: string }[];
        }
      ).diagramCsp,
  );
  expect(
    violations.some(
      (entry) =>
        entry.blocked.includes('invalid.example') &&
        entry.directive === 'img-src',
    ),
  ).toBe(true);
  expect(delivered).toEqual([]);
  expect(
    (await page.evaluate(() => window.readerFixture.calls())).map(
      (call) => call.command,
    ),
  ).toEqual(['select_document', 'commit_document']);
  writeFileSync(
    info.outputPath('resource-boundary.json'),
    JSON.stringify(
      {
        attemptedBrowserRequests: attempted,
        deliveredToRoute: delivered,
        violations,
        note: 'CSP blocked delivery, not a zero-resource-attempt guarantee; opaque native media grants not certified by browser doubles.',
      },
      null,
      2,
    ),
  );
  await record(page, info, 'strict-config-csp', source);
});

test('focused local buttons keys wheel drag and modal composition guards leave ordinary reading intact', async ({
  page,
}, info) => {
  const source =
    '# Controls' + fence(flow) + '\n' + 'Reading paragraph.\n\n'.repeat(40);
  await open(page, source);
  await settle(page, 1);
  const figure = page.locator('.diagram');
  const viewport = figure.getByRole('region');
  const scene = figure.locator('.diagram-scene');
  const transform = () =>
    scene.evaluate((element: HTMLElement) => element.style.transform);
  await figure.getByRole('button', { name: 'Interact with diagram 1' }).click();
  await expect(viewport).toBeFocused();
  const baseline = await transform();
  await viewport.press('ArrowRight');
  expect(await transform()).not.toBe(baseline);
  await viewport.press('+');
  const changed = await transform();
  await viewport.press('Escape');
  expect(await transform()).toBe(changed);
  await expect(
    figure.getByRole('button', { name: 'Interact with diagram 1' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  expect(await transform()).toBe(changed);
  await figure.getByRole('button', { name: 'Interact with diagram 1' }).click();
  await viewport.press('Tab');
  await expect(
    figure.getByRole('button', { name: 'Zoom out', exact: true }),
  ).toBeFocused();
  await figure.getByRole('button', { name: 'Interact with diagram 1' }).click();
  await viewport.press('Shift+Tab');
  await expect(
    figure.getByRole('button', { name: 'Interact with diagram 1' }),
  ).toBeFocused();
  await figure.getByRole('button', { name: 'Interact with diagram 1' }).click();
  for (const key of [
    'Control+0',
    'Meta+0',
    'Alt+ArrowLeft',
    'Shift+ArrowRight',
  ])
    await viewport.press(key);
  expect(await transform()).toBe(changed);
  await viewport.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '0',
        bubbles: true,
        isComposing: true,
      }),
    );
    const prevented = new KeyboardEvent('keydown', {
      key: '0',
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    element.dispatchEvent(prevented);
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: '0', bubbles: true }),
    );
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
  });
  expect(await transform()).toBe(changed);
  await page.evaluate(() => window.readerFixture.menu('settings'));
  await viewport.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: '0', bubbles: true }),
    ),
  );
  expect(await transform()).toBe(changed);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(viewport).toBeFocused();
  await viewport.press('0');
  expect(await transform()).toBe(baseline);
  await figure.getByRole('button', { name: 'Pan down' }).click();
  expect(await transform()).not.toBe(baseline);
  await figure.getByRole('button', { name: 'Reset diagram' }).click();
  expect(await transform()).toBe(baseline);
  const wheelResult = await viewport.evaluate((element) => {
    const plain = new WheelEvent('wheel', {
      deltaY: 50,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(plain);
    const modified = new WheelEvent('wheel', {
      deltaY: -50,
      bubbles: true,
      cancelable: true,
      ...(/Mac/.test(navigator.platform)
        ? { metaKey: true }
        : { ctrlKey: true }),
    });
    element.dispatchEvent(modified);
    return {
      plain: plain.defaultPrevented,
      modified: modified.defaultPrevented,
    };
  });
  expect(wheelResult).toEqual({ plain: false, modified: true });
  expect(await transform()).not.toBe(baseline);
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error('Missing viewport');
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  await page.mouse.down();
  const beforeDrag = await transform();
  await page.mouse.move(bounds.x + 80, bounds.y + 60);
  expect(await transform()).not.toBe(beforeDrag);
  await page.mouse.up();
  const afterDrag = await transform();
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  expect(await transform()).toBe(afterDrag);
  const scroll = await page
    .locator('main')
    .evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() => page.locator('main').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scroll);
  await record(page, info, 'controls', source);
  await viewport.scrollIntoViewIfNeeded();
  const pointer = await viewport.evaluateHandle((element) => {
    const state = { id: 0 };
    element.addEventListener('pointerdown', (event) => {
      if (event instanceof PointerEvent) state.id = event.pointerId;
    });
    return { state, element };
  });
  for (const interruption of [
    'pointercancel',
    'blur',
    'modal',
    'composition',
    'dispose',
  ]) {
    const box = await viewport.boundingBox();
    if (!box) throw new Error('Missing drag target');
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    expect(
      await pointer.evaluate(({ state, element }) =>
        element.hasPointerCapture(state.id),
      ),
    ).toBe(true);
    if (interruption === 'modal') {
      await page.evaluate(() => window.readerFixture.menu('about'));
      await expect(page.getByRole('dialog')).toBeVisible();
    } else if (interruption === 'dispose') {
      await page.evaluate(() => {
        window.readerFixture.unmount();
      });
    } else {
      await pointer.evaluate(({ state, element }, interruption) => {
        if (interruption === 'pointercancel')
          element.dispatchEvent(
            new PointerEvent('pointercancel', { pointerId: state.id }),
          );
        else if (interruption === 'blur')
          window.dispatchEvent(new Event('blur'));
        else
          element.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true }),
          );
      }, interruption);
    }
    await expect
      .poll(() =>
        pointer.evaluate(({ state, element }) =>
          element.hasPointerCapture(state.id),
        ),
      )
      .toBe(false);
    await page.mouse.up();
    if (interruption === 'modal')
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    if (interruption === 'composition')
      await viewport.dispatchEvent('compositionend');
  }
  await pointer.dispose();
});
for (const slot of ['light', 'dark'] as const)
  test(`all seven actual palettes in ${slot} slot replace only SVG and preserve controls source focus`, async ({
    page,
  }, info) => {
    const source =
      '# Palettes' +
      fence('sequenceDiagram\n Alice->>Bob: Offline labels') +
      fence('classDiagram\n A <|-- B');
    await open(page, source);
    await settle(page, 2);
    await page
      .locator('.diagram')
      .first()
      .getByText('Original definition', { exact: true })
      .click();
    await page.evaluate(() => {
      const figure = document.querySelector('.diagram');
      Object.assign(window, {
        retainedDiagram: figure,
        retainedArticle: document.querySelector('article'),
        retainedControl: figure?.querySelector('button'),
      });
    });
    let revision = 10;
    for (const [palette] of palettes) {
      await page.evaluate(
        ({ palette, slot, revision }) => {
          const old = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...old,
            revision,
            settings: {
              ...old.settings,
              mode: slot,
              [slot === 'light' ? 'lightPalette' : 'darkPalette']: palette,
            },
          });
        },
        { palette, slot, revision: revision++ },
      );
      await expect(page.locator('.diagram').first()).toHaveAttribute(
        'data-palette',
        palette,
      );
      await expect(page.locator('.diagram').last()).toHaveAttribute(
        'data-palette',
        palette,
      );
      await settle(page, 2);
      await expect(
        page.locator('.diagram').first().locator('details'),
      ).toHaveAttribute('open', '');
      expect(
        await page.evaluate(() => {
          const retained = window as unknown as {
            retainedDiagram: Element;
            retainedArticle: Element;
            retainedControl: Element;
          };
          return (
            retained.retainedDiagram === document.querySelector('.diagram') &&
            retained.retainedArticle === document.querySelector('article') &&
            retained.retainedControl ===
              document.querySelector('.diagram button')
          );
        }),
      ).toBe(true);
      await record(page, info, `${slot}-${palette}`, source);
    }
    expect(await page.evaluate(() => window.readerFixture.parses())).toBe(1);
  });
test('geometry-only fit zoom resize status preserve article and real SVG without engine work', async ({
  page,
}, info) => {
  const source = '# Geometry' + fence(flow) + '\nFinal reading content.';
  await open(page, source);
  await settle(page, 1);
  const before = await page.evaluate(() => ({
    renders: window.readerFixture.diagrams().renders.length,
    parses: window.readerFixture.parses(),
  }));
  await page.evaluate(() =>
    Object.assign(window, {
      retainedSvg: document.querySelector('.diagram svg'),
    }),
  );
  let revision = 10;
  for (const pageZoom of [50, 100, 300]) {
    for (const fitDiagrams of [true, false]) {
      await page.evaluate(
        ({ pageZoom, fitDiagrams, revision }) => {
          const old = window.readerFixture.settings();
          return window.readerFixture.settingsEvent({
            ...old,
            revision,
            settings: { ...old.settings, pageZoom, fitDiagrams },
          });
        },
        { pageZoom, fitDiagrams, revision: revision++ },
      );
      await expect(page.locator('article')).toHaveAttribute(
        'data-zoom',
        String(pageZoom),
      );
      await page.setViewportSize({ width: 640, height: 800 });
      await page.evaluate(() => window.readerFixture.menu('status-bar'));
      const figure = page.locator('.diagram');
      await figure.getByRole('button', { name: 'Fit to view' }).click();
      await figure.getByRole('button', { name: 'Reset diagram' }).click();
      const geometry = await figure.evaluate((element) => {
        const scene = element.querySelector<HTMLElement>('.diagram-scene');
        const viewport = element.querySelector('.diagram-viewport');
        return {
          matrix: new DOMMatrix(getComputedStyle(scene ?? element).transform)
            .toFloat64Array()
            .every(Number.isFinite),
          controlFont: getComputedStyle(
            element.querySelector('button') ?? element,
          ).fontSize,
          width: viewport?.getBoundingClientRect().width,
          body: document.body.scrollWidth,
          window: innerWidth,
        };
      });
      expect(geometry.matrix).toBe(true);
      expect(geometry.controlFont).toBe('16px');
      expect(geometry.width).toBeGreaterThan(0);
      expect(geometry.body).toBeLessThanOrEqual(geometry.window);
      await record(
        page,
        info,
        `geometry-${String(pageZoom)}-${String(fitDiagrams)}`,
        source,
      );
    }
  }
  expect(
    await page.evaluate(() => ({
      renders: window.readerFixture.diagrams().renders.length,
      parses: window.readerFixture.parses(),
    })),
  ).toEqual(before);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { retainedSvg: Element }).retainedSvg ===
        document.querySelector('.diagram svg'),
    ),
  ).toBe(true);
});
test('stale palette document and disposal results never publish or leave engine DOM; text and Guide remain inert', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.readerFixture.holdDiagram();
  });
  await open(page, fence(flow) + fence(flow));
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.diagrams().held))
    .toBe(true);
  await page.evaluate(async () => {
    const old = window.readerFixture.settings();
    await window.readerFixture.settingsEvent({
      ...old,
      revision: 10,
      settings: {
        ...old.settings,
        mode: 'light',
        lightPalette: 'nord',
      },
    });
    await window.readerFixture.settingsEvent({
      ...old,
      revision: 11,
      settings: {
        ...old.settings,
        mode: 'light',
        lightPalette: 'dracula',
      },
    });
    window.readerFixture.releaseDiagram();
  });
  await settle(page, 2);
  await expect(page.locator('.diagram').last()).toHaveAttribute(
    'data-palette',
    'dracula',
  );
  expect(
    await page.evaluate(() => window.readerFixture.diagrams().renders.length),
  ).toBe(3);
  await page.evaluate(() => {
    window.readerFixture.holdDiagram();
  });
  await open(page, fence(flow) + fence(flow), 2);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.diagrams().held))
    .toBe(true);
  await open(page, fence(flow), 3, 'text');
  await page.evaluate(() => {
    window.readerFixture.releaseDiagram();
  });
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
  await expect(page.locator('.diagram')).toHaveCount(0);
  await expect(page.locator('article pre')).toHaveText(fence(flow));
  await page.evaluate(() => window.readerFixture.menu('guide'));
  await expect(page.getByRole('dialog')).toContainText('50,000-character');
  await expect(page.locator('.guide svg, .guide .diagram')).toHaveCount(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.evaluate(() => {
    window.readerFixture.holdDiagram();
  });
  await open(page, fence(flow), 4);
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.diagrams().held))
    .toBe(true);
  await page.evaluate(() => {
    window.readerFixture.unmount();
    window.readerFixture.releaseDiagram();
  });
  await expect(page.locator('.diagram-measure')).toHaveCount(0);
  await expect(page.locator('article')).toHaveCount(0);
});
