import { afterEach, expect, it } from 'vitest';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { emit, emitTo, type Event } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { navigation, preferences } from '../src/native';
import { FixtureEvents } from './browser/event-transport';
import { nativeEventContract } from './native-event-contract';

afterEach(() => {
  clearMocks();
});
it('the actual native reader producers use explicit matching WebviewWindow targets; committed settings remain global', () => {
  const contract = nativeEventContract();
  expect(
    contract.producers.map(({ event, kind }) => ({ event, kind })),
  ).toEqual([
    { event: 'menu_action', kind: 'WebviewWindow' },
    { event: 'reader_notice', kind: 'WebviewWindow' },
    { event: 'index_status', kind: 'WebviewWindow' },
    { event: 'index_status', kind: 'WebviewWindow' },
    { event: 'document_requested', kind: 'WebviewWindow' },
  ]);
  expect(contract.settingsGlobal).toBe(true);
});
it('the installed native bridge binds index listeners to current metadata, while preferences keep Any', async () => {
  const events = new FixtureEvents();
  const a = {},
    b = {};
  let owner = a;
  mockWindows('reader-a');
  mockIPC((command, payload) =>
    events.invoke(
      owner,
      {
        command,
        payload,
        metadata: {
          currentWindow: { label: getCurrentWindow().label },
          currentWebview: { label: getCurrentWebview().label },
        },
      },
      (callback, event) => {
        const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
        if (typeof internals !== 'object' || internals === null)
          throw new Error('Missing installed event bridge');
        const receive: unknown = Reflect.get(internals, 'runCallback');
        if (typeof receive !== 'function')
          throw new Error('Missing installed callback bridge');
        (receive as (callback: number, event: Event<unknown>) => void)(
          callback,
          event,
        );
      },
    ),
  );
  const seenA: unknown[] = [],
    seenB: unknown[] = [],
    shared: unknown[] = [];
  const stopA = await navigation.listen((status) => {
    seenA.push(status);
  });
  mockWindows('reader-b');
  owner = b;
  const stopB = await navigation.listen((status) => {
    seenB.push(status);
  });
  const stopShared = await preferences.listen((record) => {
    shared.push(record);
  });
  expect(
    events.calls
      .filter(({ command }) => command.endsWith('|listen'))
      .map(({ payload, metadata }) => ({ payload, metadata })),
  ).toMatchObject([
    {
      payload: {
        event: 'index_status',
        target: { kind: 'WebviewWindow', label: 'reader-a' },
      },
      metadata: { currentWindow: { label: 'reader-a' } },
    },
    {
      payload: {
        event: 'index_status',
        target: { kind: 'WebviewWindow', label: 'reader-b' },
      },
      metadata: { currentWindow: { label: 'reader-b' } },
    },
    {
      payload: { event: 'settings_changed', target: { kind: 'Any' } },
      metadata: { currentWindow: { label: 'reader-b' } },
    },
  ]);
  await emitTo({ kind: 'WebviewWindow', label: 'reader-a' }, 'index_status', {
    scope: 99,
  });
  expect(seenA).toEqual([{ scope: 99 }]);
  expect(seenB).toEqual([]);
  await emit('settings_changed', { revision: 2 });
  expect(shared).toEqual([{ revision: 2 }]);
  mockWindows('reader-a');
  owner = a;
  stopA();
  mockWindows('reader-b');
  owner = b;
  stopB();
  stopShared();
  expect(events.listenerCount).toBe(0);
});
it('the event fixture never hides global broadcasts or Any subscriptions behind owner-local delivery', async () => {
  const events = new FixtureEvents();
  const delivered: number[] = [];
  for (const [handler, target] of [
    [1, { kind: 'Any' }],
    [2, { kind: 'WebviewWindow', label: 'reader-a' }],
    [3, { kind: 'WebviewWindow', label: 'reader-b' }],
    [4, { kind: 'Window', label: 'reader-a' }],
  ] as const) {
    await events.invoke(
      {},
      {
        command: 'plugin:event|listen',
        payload: { event: 'probe', target, handler },
        metadata: {
          currentWindow: { label: 'reader-b' },
          currentWebview: { label: 'reader-b' },
        },
      },
      (callback) => {
        delivered.push(callback);
      },
    );
  }
  await events.emit('probe', null, {
    kind: 'WebviewWindow',
    label: 'reader-a',
  });
  expect(delivered).toEqual([1, 2]);
  delivered.length = 0;
  await events.emit('probe', null);
  expect(delivered).toEqual([1, 2, 3, 4]);
  delivered.length = 0;
  await events.emit('probe', null, { kind: 'AnyLabel', label: 'reader-a' });
  expect(delivered).toEqual([1, 2, 4]);
  // The metadata intentionally says reader-b for every registration above;
  // only the subscription target, not that owner metadata, filters delivery.
});
