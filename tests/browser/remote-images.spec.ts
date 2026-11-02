import { expect, test, type Page } from '@playwright/test';

const permitted = 'https://raw.githubusercontent.com/a/figure.png';
const blocked = 'https://images.example.com/a/figure.png';
const figure = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
);

async function open(page: Page, source: string, id = 1) {
  await page.evaluate(
    ({ source, id }) => {
      window.readerFixture.enqueue('select_document', {
        value: {
          status: 'ready',
          snapshot: {
            documentId: id,
            revision: id,
            name: 'remote.md',
            location: 'fixture/remote.md',
            format: 'markdown',
            source,
          },
        },
      });
    },
    { source, id },
  );
  await page.evaluate(() => window.readerFixture.menu('open'));
  await expect(
    page.getByRole('region', { name: 'Reader status' }),
  ).toContainText('Opened remote.md.');
}

async function settings(page: Page) {
  await page.evaluate(() => window.readerFixture.menu('settings'));
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function saved(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(
    dialog.getByRole('region', { name: 'Preferences status' }),
  ).toContainText('Preferences saved.');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `${process.env.TAURIMD_TEST_URL ?? ''}/tests/browser/shell.html`,
  );
  await expect
    .poll(() => page.evaluate(() => window.readerFixture.listenerCount()))
    .toBe(5);
  // The reader-media grant is the only delivery path. The browser double
  // serves it here so a permitted image really decodes.
  await page.route('http://reader-media.localhost/**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'X-Content-Type-Options': 'nosniff',
      },
      body: figure,
    });
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.readerFixture.cleanup();
  });
});

test('the permitted host list is saved, an unusable entry changes nothing and an emptied list stays empty', async ({
  page,
}) => {
  const dialog = await settings(page);
  const hosts = dialog.getByRole('group', { name: 'Remote image hosts' });
  await expect(hosts).toBeVisible();
  await expect(
    hosts.getByRole('button', { name: 'Remove github.com' }),
  ).toBeVisible();
  await expect(
    hosts.getByRole('button', {
      name: 'Remove raw.githubusercontent.com',
    }),
  ).toBeVisible();
  const entry = hosts.getByLabel('Add a host');
  // An unusable entry is refused before it reaches the native owner.
  await entry.fill('https://example.com/image');
  await hosts.getByRole('button', { name: 'Add host' }).click();
  await expect(hosts.getByRole('alert')).toContainText('bare host name');
  expect(
    (await page.evaluate(() => window.readerFixture.settings())).settings
      .remoteImageHosts,
  ).not.toContain('https://example.com/image');
  // A plain host is accepted and saved by the existing settings owner.
  await entry.fill('images.example.com');
  await hosts.getByRole('button', { name: 'Add host' }).click();
  await saved(page);
  const added = (await page.evaluate(() => window.readerFixture.settings()))
    .settings.remoteImageHosts;
  expect(added).toContain('images.example.com');
  expect(added).toContain('github.com');
  // Removing every host saves an empty list rather than a missing value.
  for (const host of added)
    await hosts.getByRole('button', { name: `Remove ${host}` }).click();
  await saved(page);
  expect(
    (await page.evaluate(() => window.readerFixture.settings())).settings
      .remoteImageHosts,
  ).toEqual([]);
  await expect(hosts.getByText(/No host is permitted/)).toBeVisible();
  // The deliberate empty list is not reseeded when the dialog reopens.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const reopened = await settings(page);
  await expect(
    reopened
      .getByRole('group', { name: 'Remote image hosts' })
      .getByText(/No host is permitted/),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.readerFixture.settings())).settings
      .remoteImageHosts,
  ).toEqual([]);
});

test('a permitted host delivers the image through the opaque grant and an unpermitted host is denied locally', async ({
  page,
}) => {
  await open(
    page,
    `# Reading\n\n![Permitted](${permitted})\n\nReadable paragraph.`,
  );
  const article = page.getByRole('article');
  const image = article.getByRole('img', { name: 'Permitted' });
  // The bytes arrive through the opaque reader-media grant, never through the
  // document address.
  await expect(image).toHaveAttribute(
    'src',
    /^http:\/\/reader-media\.localhost\/[0-9a-f]{32}$/,
  );
  expect(
    await article.evaluate((node) =>
      [...node.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      ),
    ),
  ).not.toContain(permitted);
  expect(await page.evaluate(() => window.readerFixture.calls())).toEqual([
    { command: 'select_document', payload: { requestId: 1 } },
    { command: 'commit_document', payload: { requestId: 1 } },
    {
      command: 'resolve_media',
      payload: {
        documentId: 1,
        revision: 1,
        relativeReference: permitted,
        remoteBinding: { slot: '0', attempt: 1 },
      },
    },
  ]);
  // A host that is not permitted is denied by the native owner, and only
  // that resource reports it.
  await open(
    page,
    `# Reading\n\n![Blocked](${blocked})\n\nReadable paragraph.`,
    2,
  );
  const blockedArticle = page.getByRole('article');
  await expect(blockedArticle).toContainText('is not permitted');
  await expect(
    blockedArticle.getByRole('img', { name: 'Blocked' }),
  ).not.toHaveAttribute('src');
  await expect(blockedArticle).toContainText('Readable paragraph.');
  expect(
    await blockedArticle.evaluate((node) =>
      [...node.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      ),
    ),
  ).not.toContain(blocked);
});
