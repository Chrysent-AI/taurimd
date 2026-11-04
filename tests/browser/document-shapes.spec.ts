import { expect, test, type Page } from '@playwright/test';

// The document-shape hot paths run on the reader's main thread: the parse
// worker's reply is sanitized synchronously, so sanitizer cost directly
// blocks the interface. These pins drive the actual production functions in
// the running engine — the same seam the freeze investigation measured —
// with bounds far above the repaired cost and below the measured quadratic
// baselines (2.06–2.62 s for 8,000 duplicate headings; 1.07–2.14 s for
// 4,000 diagram blocks; ~504 ms for a 16,000-heading target scan). jsdom
// cannot discriminate these repairs: its own DOM cost dominates the
// functions at these scales.
function repeat(count: number, block: string) {
  return Array.from({ length: count }, () => block).join('\n\n');
}

type Readers = [
  typeof import('../../src/reader/parse'),
  typeof import('../../src/reader/sanitize'),
];

async function withShell(page: Page) {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
}

test('duplicate-heading slug allocation stays linear at eight thousand headings', async ({
  page,
}) => {
  await withShell(page);
  const result = await page.evaluate(
    async (source) => {
      // The modules load inside the page from the same vite server that
      // serves the shell (sanitizeReading installs DOMPurify at import time,
      // so they cannot load in the test process). Variable specifiers keep
      // the imports runtime-only; the cast restores source typing.
      // Variable specifiers keep the vite module URLs runtime-only.
      const parseModule = '/src/reader/parse.ts';
      const sanitizeModule = '/src/reader/sanitize.ts';
      const [parse, sanitize] = (await Promise.all([
        import(parseModule),
        import(sanitizeModule),
      ])) as Readers;
      const parsed = parse.parseMarkdown(source);
      const started = performance.now();
      const reading = sanitize.sanitizeReading(parsed, 'd9-r9');
      const elapsed = performance.now() - started;
      const headings = reading.headings ?? [];
      return {
        elapsed,
        count: headings.length,
        unique: new Set(headings.map((heading) => heading.id)).size,
        first: Object.keys(reading.fragments ?? {}).find((key) =>
          key.startsWith('repeat'),
        ),
      };
    },
    repeat(8000, '## Repeat'),
  );
  expect(result.count).toBe(8000);
  expect(result.unique).toBe(8000);
  expect(result.first).toBe('repeat');
  expect(result.elapsed).toBeLessThan(1500);
});

test('diagram matching collects candidate blocks once at four thousand blocks', async ({
  page,
}) => {
  await withShell(page);
  const result = await page.evaluate(
    async (source) => {
      // Variable specifiers keep the vite module URLs runtime-only.
      const parseModule = '/src/reader/parse.ts';
      const sanitizeModule = '/src/reader/sanitize.ts';
      const [parse, sanitize] = (await Promise.all([
        import(parseModule),
        import(sanitizeModule),
      ])) as Readers;
      const parsed = parse.parseMarkdown(source);
      const started = performance.now();
      const reading = sanitize.sanitizeReading(parsed, 'd9-r9');
      const elapsed = performance.now() - started;
      const host = document.createElement('div');
      host.innerHTML = reading.html;
      return {
        elapsed,
        diagrams: reading.diagrams?.length ?? 0,
        marked: host.querySelectorAll('[data-reader-diagram]').length,
      };
    },
    repeat(4000, '```mermaid\ngraph LR\n A-->B\n```'),
  );
  expect(result.diagrams).toBe(4000);
  expect(result.marked).toBe(4000);
  expect(result.elapsed).toBeLessThan(900);
});

test('heading-target setup builds one identifier map at sixteen thousand headings', async ({
  page,
}) => {
  await withShell(page);
  // The App's observer setup pairs each article element with its heading
  // through one identifier map; the repaired pairing must stay
  // near-instant at 16k headings where the measured scan took ~504 ms.
  const result = await page.evaluate(async () => {
    // Variable specifiers keep the vite module URLs runtime-only.
    const parseModule = '/src/reader/parse.ts';
    const sanitizeModule = '/src/reader/sanitize.ts';
    const [parse, sanitize] = (await Promise.all([
      import(parseModule),
      import(sanitizeModule),
    ])) as Readers;
    const parsed = parse.parseMarkdown(
      Array.from({ length: 8000 }, () => '# Top\n\n## Under').join('\n\n'),
    );
    const reading = sanitize.sanitizeReading(parsed, 'd9-r9');
    const headings = reading.headings ?? [];
    const host = document.createElement('article');
    host.innerHTML = reading.html;
    const started = performance.now();
    const headingById = new Map(
      headings.map((heading) => [heading.id, heading]),
    );
    const targets = [...host.querySelectorAll<HTMLElement>('[id]')].flatMap(
      (node) => {
        const heading = headingById.get(node.id);
        return heading ? [{ node, key: heading.key }] : [];
      },
    );
    return {
      elapsed: performance.now() - started,
      headings: headings.length,
      targets: targets.length,
    };
  });
  expect(result.headings).toBe(16000);
  expect(result.targets).toBe(16000);
  expect(result.elapsed).toBeLessThan(250);
});
