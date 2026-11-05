import { expect, test } from '@playwright/test';

// The parse worker is an optimization: when it stalls or runs without
// its usual engine tiers, the watchdog must fall back to the equivalent
// main-thread parse instead of leaving the reader stuck mid-stage.
test('a stalled parse worker falls back to the main-thread parser', async ({
  page,
}) => {
  test.setTimeout(30000);
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/fixture.html`,
  );
  await page.waitForFunction(
    () => typeof window.renderWorkerParse === 'function',
  );
  const result = await page.evaluate(async () => {
    const url = new URL('/tests/browser/stall.worker.ts', location.href);
    return window.renderWorkerParse('# Fallback title\n\nstill readable', {
      workerUrl: url,
      budgetMs: 500,
    });
  });
  expect(result.html).toContain('Fallback title');
  expect(result.html).toContain('still readable');
});

test('a healthy worker still completes inside its budget', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/fixture.html`,
  );
  await page.waitForFunction(
    () => typeof window.renderWorkerParse === 'function',
  );
  const result = await page.evaluate(async () => {
    return window.renderWorkerParse('# Worker title\n\nparsed off thread');
  });
  expect(result.html).toContain('Worker title');
  expect(result.html).toContain('parsed off thread');
});
