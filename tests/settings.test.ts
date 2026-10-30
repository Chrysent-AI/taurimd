import { afterEach, expect, it, vi } from 'vitest';
import {
  defaults,
  SettingsController,
  type SettingsBridge,
  type SettingsRecord,
  type SettingsUpdate,
} from '../src/settings/model';
const record = (revision = 0, settings = defaults): SettingsRecord => ({
  version: 1,
  revision,
  settings: { ...settings },
  notice: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => {
    stop();
  });
});
async function setup() {
  let receive: (value: SettingsRecord) => void = () => {};
  const stop = vi.fn();
  const bridge = {
    get: vi.fn<SettingsBridge['get']>().mockResolvedValue(record()),
    update: vi.fn<SettingsBridge['update']>(),
    listen: vi.fn<SettingsBridge['listen']>().mockImplementation((listener) => {
      receive = listener;
      return Promise.resolve(stop);
    }),
  };
  const model = new SettingsController(bridge);
  cleanup.push(model.connect());
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  return {
    model,
    bridge,
    event: (value: SettingsRecord) => {
      receive(value);
    },
    stop,
  };
}
it('applies immediately, keeps newer local intent through old acknowledgements, and merges unrelated event fields', async () => {
  const { model, bridge, event } = await setup();
  const first = deferred<SettingsUpdate>();
  const second = deferred<SettingsUpdate>();
  bridge.update
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  model.change({ lightPalette: 'dracula' });
  expect(model.getState().settings.lightPalette).toBe('dracula');
  expect(model.getState().status).toBe('saving');
  model.change({ lightPalette: 'nord' });
  event(record(2, { ...defaults, sidebarDefault: false }));
  first.resolve({
    status: 'committed',
    record: record(1, { ...defaults, lightPalette: 'dracula' }),
  });
  await vi.waitFor(() => {
    expect(bridge.update).toHaveBeenCalledTimes(2);
  });
  expect(bridge.update).toHaveBeenLastCalledWith(2, { lightPalette: 'nord' });
  expect(model.getState().settings.sidebarDefault).toBe(false);
  expect(model.getState().settings.lightPalette).toBe('nord');
  second.resolve({
    status: 'committed',
    record: record(3, {
      ...defaults,
      lightPalette: 'nord',
      sidebarDefault: false,
    }),
  });
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  event(record(1));
  expect(model.getState().revision).toBe(3);
});
it('reconciles stale patches with unrelated fields and bounds conflict retries', async () => {
  const { model, bridge } = await setup();
  bridge.update
    .mockResolvedValueOnce({
      status: 'conflict',
      record: record(4, { ...defaults, fitDiagrams: false }),
    })
    .mockResolvedValueOnce({
      status: 'committed',
      record: record(5, { ...defaults, mode: 'dark', fitDiagrams: false }),
    });
  model.change({ mode: 'dark' });
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.update.mock.calls).toEqual([
    [0, { mode: 'dark' }],
    [4, { mode: 'dark' }],
  ]);
  expect(model.getState().settings.fitDiagrams).toBe(false);
  bridge.update.mockResolvedValue({ status: 'conflict', record: record(6) });
  model.change({ pageZoom: 150 });
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  expect(bridge.update).toHaveBeenCalledTimes(5);
  expect(model.getState().settings.pageZoom).toBe(150);
});
it('retains applied values on failure, retries only pending fields, and unlistens', async () => {
  const { model, bridge, stop, event } = await setup();
  bridge.update.mockRejectedValueOnce(new Error('disk unavailable'));
  model.change({ sidebarDefault: false });
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  expect(model.getState().revision).toBe(0);
  expect(model.getState().settings.sidebarDefault).toBe(false);
  bridge.update.mockResolvedValueOnce({
    status: 'committed',
    record: record(1, { ...defaults, sidebarDefault: false }),
  });
  model.retry();
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.update).toHaveBeenLastCalledWith(0, { sidebarDefault: false });
  cleanup.pop()?.();
  expect(stop).toHaveBeenCalledTimes(1);
  event(record(10));
  expect(model.getState().revision).toBe(1);
});
it('subscribes before hydration, protects newer event from old getter, and reports fallback', async () => {
  const get = deferred<SettingsRecord>();
  let event: (value: SettingsRecord) => void = () => {};
  const bridge: SettingsBridge = {
    get: () => get.promise,
    listen: (receive) => {
      event = receive;
      return Promise.resolve(() => {});
    },
    update: vi.fn(),
  };
  const model = new SettingsController(bridge);
  cleanup.push(model.connect());
  const newer = {
    ...record(7, { ...defaults, darkPalette: 'monokai' }),
    notice: 'Some saved preferences could not be loaded',
  };
  event(newer);
  get.resolve(record(1));
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(model.getState().revision).toBe(7);
  expect(model.getState().notice).toBe(newer.notice);
});
it('retries failed subscriptions before hydration rather than claiming synchronized success', async () => {
  const bridge = {
    get: vi.fn().mockResolvedValue(record()),
    update: vi.fn(),
    listen: vi
      .fn()
      .mockRejectedValueOnce(new Error('no event'))
      .mockResolvedValueOnce(() => {}),
  };
  const model = new SettingsController(bridge);
  cleanup.push(model.connect());
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  expect(bridge.get).not.toHaveBeenCalled();
  model.retry();
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.listen).toHaveBeenCalledTimes(2);
});
it('keeps recovery visible when preferences are changed after failed initial hydration', async () => {
  const bridge = {
    get: vi
      .fn()
      .mockRejectedValueOnce(new Error('getter unavailable'))
      .mockResolvedValueOnce(record()),
    update: vi.fn().mockResolvedValue({
      status: 'committed',
      record: record(1, { ...defaults, mode: 'dark' }),
    }),
    listen: vi.fn().mockResolvedValue(() => {}),
  };
  const model = new SettingsController(bridge);
  cleanup.push(model.connect());
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  model.change({ mode: 'dark' });
  expect(model.getState().settings.mode).toBe('dark');
  expect(model.getState().status).toBe('error');
  model.retry();
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.update).toHaveBeenCalledWith(0, { mode: 'dark' });
});
