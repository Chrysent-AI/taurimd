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
    `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/fixture.html`,
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
  await expect(page.locator('#reading')).toContainText(
    '[Blocked img: Remote image]',
  );
  await expect(page.locator('#reading')).toContainText('[link inactive]');
  await expect(
    page.locator(
      '#reading [src], #reading [href], #reading [style], #reading script, #reading iframe',
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
