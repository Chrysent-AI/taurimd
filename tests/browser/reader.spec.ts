import { expect, test } from '@playwright/test';
test('real worker and sanitizer do not execute or fetch document content', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      external.push(request.url());
  });
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/fixture.html`,
  );
  await page.waitForFunction(() => typeof window.renderDocument === 'function');
  await page.evaluate(async () => {
    await window.renderDocument(
      `# Safe title\n\n- [x] read only\n\n<img src="https://invalid.example/remote.png" srcset="file:///blocked 2x" onerror="window.compromised=true" alt="Remote image">\n\n<iframe src="https://invalid.example/frame"></iframe>\n\n<script>window.compromised=true;fetch('https://invalid.example/leak')</script>\n\n<p style="background:url(https://invalid.example/css)" onclick="window.compromised=true">Readable</p>\n\n[Denied](javascript:alert(1))`,
      'markdown',
    );
  });
  await expect(page.locator('#reading h1')).toHaveText('Safe title');
  await expect(page.locator('#reading input')).toBeDisabled();
  // An HTTPS image is a classified remote candidate. This surface only
  // parses, so no request is made and no address reaches an attribute.
  await expect(page.locator('#reading')).toContainText('Loading remote img');
  await expect(page.locator('#reading a')).toHaveAttribute('href', '#');
  await expect(
    page.locator(
      '#reading [src], #reading a[href]:not([href="#"]), #reading [style], #reading script, #reading iframe',
    ),
  ).toHaveCount(0);
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  expect(external).toEqual([]);
  const text =
    '# literal\n<script>not code</script>\n![not fetched](https://invalid.example/a)';
  await page.evaluate(async (source) => {
    await window.renderDocument(source, 'text');
  }, text);
  await expect(page.locator('#literal')).toHaveText(text);
  await expect(page.locator('#literal script')).toHaveCount(0);
  expect(external).toEqual([]);
});
test('GFM column and raw HTML alignment survive sanitize and compute aligned', async ({
  page,
}) => {
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/fixture.html`,
  );
  await page.waitForFunction(() => typeof window.renderDocument === 'function');
  await page.evaluate(async () => {
    await window.renderDocument(
      '<p align="center">Centered intro</p>\n\n| Left | Centered |\n| --- | :---: |\n| a | b |\n',
      'markdown',
    );
  });
  await expect(page.locator('#reading p[align="center"]')).toHaveText(
    'Centered intro',
  );
  // The legacy align attribute maps in UA origin in every engine; no
  // author style attribute is granted to carry the alignment. Engines
  // surface the mapped center as their legacy internal value
  // (-webkit-center / -moz-center), so normalize the prefix.
  const textAlign = (selector: string) =>
    page.evaluate((query) => {
      const node = document.querySelector(query);
      if (!node) throw new Error(`Missing aligned node: ${query}`);
      return getComputedStyle(node).textAlign.replace(
        /^(?:-webkit-|-moz-)/,
        '',
      );
    }, selector);
  expect(await textAlign('#reading p[align="center"]')).toBe('center');
  expect(
    await page.evaluate(() =>
      document.querySelector('#reading th:nth-child(2)')?.getAttribute('align'),
    ),
  ).toBe('center');
  expect(await textAlign('#reading th:nth-child(2)')).toBe('center');
  expect(await textAlign('#reading td:nth-child(2)')).toBe('center');
  await expect(page.locator('#reading [style]')).toHaveCount(0);
});
