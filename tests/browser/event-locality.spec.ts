import { expect, test, type Page } from '@playwright/test';
import type { EventIPC, ReaderEvent } from './event-transport';
import { FixtureEvents } from './event-transport';
import { nativeEventContract } from '../native-event-contract';
import type { FileIndex } from '../../src/navigation/types';

const root = (scope: number, name: string, revision = 1): FileIndex => ({
  scope,
  revision,
  name: `fixture/${name}`,
  entries: [
    {
      id: 1,
      uiId: 1,
      parent: null,
      name: `${name}.md`,
      relative: `${name}.md`,
      kind: 'markdown',
      context: 1,
      alphaRank: 1,
      dateRank: 1,
    },
  ],
  issues: [],
});
async function choose(page: Page, index: FileIndex) {
  await page.evaluate((index) => {
    window.readerFixture.enqueue('select_root', {
      value: {
        status: 'ready',
        snapshot: window.readerFixture.indexSnapshot(index),
      },
    });
    return window.readerFixture.menu('open-folder');
  }, index);
  await expect(
    page.getByRole('navigation', { name: 'Files', exact: true }),
  ).toContainText('Folder loaded');
}
test('shared native emitter keeps commands, index watermarks, requests and notices local while committed settings reach both readers', async ({
  page,
  context,
}, info) => {
  const broker = new FixtureEvents();
  const contract = nativeEventContract();
  const readers: Page[] = [page];
  await context.exposeBinding(
    'readerEventIPC',
    async ({ frame }, request: EventIPC) => {
      expect(request.metadata.currentWindow.label).toBe(
        request.metadata.currentWebview.label,
      );
      if (request.command === 'fixture:native_emit') {
        const args = request.payload as {
          event: ReaderEvent;
          payload: unknown;
        };
        const producers = contract.producers.filter(
          (producer) => producer.event === args.event,
        );
        expect(producers.length).toBeGreaterThan(0);
        const kinds = new Set(producers.map((producer) => producer.kind));
        expect(kinds.size).toBe(1);
        const kind = producers[0].kind;
        // This destination follows the actual selected Rust producer contract,
        // not the page the assertion hopes should receive the event.
        await broker.emit(
          args.event,
          args.payload,
          kind === 'Any'
            ? { kind: 'Any' }
            : {
                kind: 'WebviewWindow',
                label: request.metadata.currentWindow.label,
              },
        );
        return null;
      }
      return broker.invoke(frame, request, (callback, event) =>
        frame.evaluate(
          ({ callback, event }) => {
            window.readerFixture.deliverEvent(callback, event);
          },
          { callback, event },
        ),
      );
    },
  );
  try {
    const other = await context.newPage();
    readers.push(other);
    const url = `${process.env.MDVIEWERRSX_TEST_URL ?? ''}/tests/browser/shell.html`;
    await Promise.all([
      page.goto(`${url}?reader=reader-a`),
      other.goto(`${url}?reader=reader-b`),
    ]);
    for (const reader of readers)
      await expect
        .poll(() => reader.evaluate(() => window.readerFixture.listenerCount()))
        .toBe(5);
    expect(broker.listenerCount).toBe(10);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.readerFixture.menu('guide'));
      await expect(
        page.getByRole('dialog', { name: 'User Guide', exact: true }),
      ).toBeVisible();
      expect(
        broker.deliveries.filter(
          (delivery) =>
            delivery.event === 'menu_action' &&
            delivery.metadata.currentWindow.label === 'reader-b',
        ),
      ).toHaveLength(0);
      await expect(other.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
    // B's native sequence begins at1, despite A's independently increasing stream.
    await other.evaluate(() => window.readerFixture.menu('guide'));
    await expect(
      other.getByRole('dialog', { name: 'User Guide', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await other.getByRole('button', { name: 'Close', exact: true }).click();
    for (const reader of readers) {
      const subscriptions = await reader.evaluate(() =>
        window.readerFixture
          .eventCalls()
          .filter((call) => call.command === 'plugin:event|listen'),
      );
      for (const subscription of subscriptions) {
        const payload = subscription.payload as {
          event: string;
          target: unknown;
        };
        expect(payload.target).toEqual(
          payload.event === 'settings_changed'
            ? { kind: 'Any' }
            : {
                kind: 'WebviewWindow',
                label: subscription.metadata.currentWindow.label,
              },
        );
      }
    }
    await choose(page, root(50, 'a'));
    await choose(other, root(7, 'b'));
    await other.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await other.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await other.evaluate(() => window.readerFixture.menu('quick-open'));
    await other.clock.runFor(200);
    const options = other
      .getByRole('listbox', { name: 'Files and folders' })
      .getByRole('option');
    await expect(options).toContainText('b.md');
    const beforeGets = await other.evaluate(() =>
      window.readerFixture.indexGets(),
    );
    await page.evaluate(
      (index) => {
        const snapshot = window.readerFixture.indexSnapshot(index, 'loading');
        snapshot.status.sequence = 1000;
        return window.readerFixture.indexEvent(snapshot);
      },
      root(500, 'foreign', 99),
    );
    expect(
      broker.deliveries.filter(
        (delivery) =>
          delivery.event === 'index_status' &&
          delivery.metadata.currentWindow.label === 'reader-b',
      ),
    ).toHaveLength(0);
    expect(await other.evaluate(() => window.readerFixture.indexGets())).toBe(
      beforeGets,
    );
    await expect(options).toContainText('b.md');
    await expect(
      other.getByRole('navigation', { name: 'Files', exact: true }),
    ).not.toContainText('Updating folder');
    await other.evaluate(
      (index) =>
        window.readerFixture.indexEvent(
          window.readerFixture.indexSnapshot(index),
        ),
      root(7, 'b-current', 2),
    );
    await other.clock.runFor(200);
    await expect(options).toContainText('b-current.md');
    await other.getByRole('button', { name: 'Close', exact: true }).click();
    const beforePending = await other.evaluate(
      () =>
        window.readerFixture
          .documentCalls()
          .filter((call) => call.command === 'pending_document').length,
    );
    await page.evaluate(() =>
      window.readerFixture.documentRequest({
        kind: 'error',
        token: 90,
        error: { code: 'notFound', message: 'Owner A document request' },
      }),
    );
    await expect(page.getByRole('alert')).toContainText(
      'Owner A document request',
    );
    expect(
      await other.evaluate(
        () =>
          window.readerFixture
            .documentCalls()
            .filter((call) => call.command === 'pending_document').length,
      ),
    ).toBe(beforePending);
    await expect(other.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() =>
      window.readerFixture.readerNotice('Owner A notice'),
    );
    await expect(page.getByRole('alert')).toContainText('Owner A notice');
    await expect(other.getByRole('alert')).toHaveCount(0);
    expect(
      broker.deliveries.filter(
        (delivery) =>
          ['document_requested', 'reader_notice'].includes(delivery.event) &&
          delivery.metadata.currentWindow.label === 'reader-b',
      ),
    ).toHaveLength(0);
    await page.evaluate(() => {
      const record = window.readerFixture.settings();
      return window.readerFixture.settingsEvent({
        ...record,
        revision: 20,
        settings: { ...record.settings, mode: 'dark' },
      });
    });
    for (const reader of readers)
      await expect
        .poll(() =>
          reader.evaluate(
            () => window.readerFixture.presentation()?.appearance,
          ),
        )
        .toBe('dark');
    expect(
      broker.deliveries
        .filter((delivery) => delivery.event === 'settings_changed')
        .map((delivery) => delivery.metadata.currentWindow.label),
    ).toEqual(expect.arrayContaining(['reader-a', 'reader-b']));
  } finally {
    await info.attach('shared-event-contract', {
      body: JSON.stringify(
        {
          contract,
          calls: broker.calls,
          emissions: broker.emissions,
          deliveries: broker.deliveries,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    for (const reader of readers) {
      const remaining = await reader.evaluate(() => {
        const fixture = Reflect.get(window, 'readerFixture') as
          | typeof window.readerFixture
          | undefined;
        fixture?.cleanup();
        return {
          listeners: fixture?.listenerCount() ?? 0,
          workers: fixture?.activeWorkers() ?? 0,
        };
      });
      expect(remaining).toEqual({ listeners: 0, workers: 0 });
    }
    await expect.poll(() => broker.listenerCount).toBe(0);
    for (const reader of readers.slice(1)) {
      await reader.close();
      expect(context.pages().includes(reader)).toBe(false);
    }
  }
});
