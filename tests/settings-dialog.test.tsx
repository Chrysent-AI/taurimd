import { useSyncExternalStore } from 'react';
import {
  cleanup as cleanupDom,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  defaults,
  SettingsController,
  type SettingsBridge,
  type SettingsPatch,
  type SettingsRecord,
  type SettingsUpdate,
  type SettingsV1,
} from '../src/settings/model';
import {
  SettingsDialog,
  SettingsFeedback,
} from '../src/settings/SettingsDialog';
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
  cleanupDom();
});
async function setup(settings: SettingsV1 = defaults) {
  let receive: (value: SettingsRecord) => void = () => {};
  const stop = vi.fn();
  const bridge = {
    get: vi.fn<SettingsBridge['get']>().mockResolvedValue(record(0, settings)),
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
function SettingsHarness({ model }: { model: SettingsController }) {
  const state = useSyncExternalStore(model.subscribe, model.getState);
  return (
    <SettingsDialog controller={model} settings={state.settings} slot="light">
      <SettingsFeedback
        status={state.status}
        notice={state.notice}
        retry={model.retry}
      />
    </SettingsDialog>
  );
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
it('retains dedicated applied status visibility through late acknowledgements, conflict, failure and Retry', async () => {
  const { model, bridge, event } = await setup();
  const first = deferred<SettingsUpdate>();
  bridge.update
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error('disk'));
  model.change({ statusVisible: false });
  model.change({ statusVisible: true });
  expect(model.getState().settings.statusVisible).toBe(true);
  event(
    record(4, { ...defaults, sidebarDefault: false, statusVisible: false }),
  );
  expect(model.getState().settings.statusVisible).toBe(true);
  first.resolve({
    status: 'committed',
    record: record(1, { ...defaults, statusVisible: false }),
  });
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  expect(bridge.update).toHaveBeenLastCalledWith(4, { statusVisible: true });
  expect(model.getState().settings.statusVisible).toBe(true);
  bridge.update
    .mockResolvedValueOnce({
      status: 'conflict',
      record: record(5, { ...defaults, sidebarDefault: false }),
    })
    .mockResolvedValueOnce({
      status: 'committed',
      record: record(6, {
        ...defaults,
        sidebarDefault: false,
        statusVisible: true,
      }),
    });
  model.retry();
  await vi.waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(model.getState().settings.sidebarDefault).toBe(false);
  expect(model.getState().settings.statusVisible).toBe(true);
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
it('shares committed revisions between two readers without propagating failed optimistic intent', async () => {
  let committed = record();
  const listeners = new Set<(record: SettingsRecord) => void>();
  let failA = true;
  const create = (first: boolean): SettingsBridge => ({
    get: () => Promise.resolve(committed),
    listen: (receive) => {
      listeners.add(receive);
      return Promise.resolve(() => {
        listeners.delete(receive);
      });
    },
    update: (revision, patch) => {
      if (first && failA) return Promise.reject(new Error('Save unavailable'));
      if (revision !== committed.revision)
        return Promise.resolve({ status: 'conflict', record: committed });
      committed = record(revision + 1, { ...committed.settings, ...patch });
      listeners.forEach((receive) => {
        receive(committed);
      });
      return Promise.resolve({ status: 'committed', record: committed });
    },
  });
  const a = new SettingsController(create(true));
  const b = new SettingsController(create(false));
  cleanup.push(a.connect(), b.connect());
  await vi.waitFor(() => {
    expect(a.getState().status).toBe('saved');
    expect(b.getState().status).toBe('saved');
  });
  a.change({ statusVisible: false });
  await vi.waitFor(() => {
    expect(a.getState().status).toBe('error');
  });
  expect(b.getState().settings.statusVisible).toBe(true);
  b.change({ mode: 'dark' });
  await vi.waitFor(() => {
    expect(b.getState().status).toBe('saved');
  });
  expect(a.getState().settings.mode).toBe('dark');
  expect(a.getState().settings.statusVisible).toBe(false);
  expect(b.getState().settings.statusVisible).toBe(true);
  failA = false;
  a.retry();
  await vi.waitFor(() => {
    expect(a.getState().status).toBe('saved');
    expect(b.getState().settings.statusVisible).toBe(false);
  });
  expect(b.getState().settings.mode).toBe('dark');
  cleanup.splice(0).forEach((stop) => {
    stop();
  });
  expect(listeners.size).toBe(0);
});
const appearanceDefaults: SettingsPatch = {
  mode: 'system',
  lightPalette: 'githubLight',
  darkPalette: 'githubDark',
  pageZoom: 100,
};
const customized: SettingsV1 = {
  ...defaults,
  mode: 'dark',
  lightPalette: 'dracula',
  darkPalette: 'nord',
  pageZoom: 150,
  fitDiagrams: false,
  sidebarDefault: false,
  statusVisible: false,
  remoteImageHosts: ['github.com'],
};
it('restores appearance defaults in one revisioned change and leaves unrelated preferences untouched', async () => {
  const { model, bridge } = await setup(customized);
  let committed = record(0, customized);
  bridge.update.mockImplementation((revision, patch) => {
    committed = record(revision + 1, { ...committed.settings, ...patch });
    return Promise.resolve({ status: 'committed', record: committed });
  });
  render(<SettingsHarness model={model} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset appearance defaults' }),
  );
  await waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.update).toHaveBeenCalledTimes(1);
  expect(bridge.update).toHaveBeenCalledWith(0, appearanceDefaults);
  expect(model.getState().settings).toEqual({
    ...appearanceDefaults,
    fitDiagrams: false,
    sidebarDefault: false,
    statusVisible: false,
    // The appearance reset never touches the remote image hosts.
    remoteImageHosts: ['github.com'],
  });
  expect(screen.getByLabelText<HTMLSelectElement>('Appearance').value).toBe(
    'system',
  );
  expect(screen.getByLabelText<HTMLSelectElement>('Light palette').value).toBe(
    'githubLight',
  );
  expect(screen.getByLabelText<HTMLSelectElement>('Dark palette').value).toBe(
    'githubDark',
  );
  expect(screen.getByLabelText('Page zoom').textContent).toBe('100%');
});
it('keeps a failed appearance reset truthful and retries only the appearance fields', async () => {
  const { model, bridge } = await setup(customized);
  bridge.update.mockRejectedValueOnce(new Error('disk unavailable'));
  render(<SettingsHarness model={model} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset appearance defaults' }),
  );
  await waitFor(() => {
    expect(model.getState().status).toBe('error');
  });
  expect(bridge.update).toHaveBeenCalledTimes(1);
  expect(bridge.update).toHaveBeenLastCalledWith(0, appearanceDefaults);
  expect(model.getState().revision).toBe(0);
  expect(model.getState().settings.mode).toBe('system');
  expect(model.getState().settings.pageZoom).toBe(100);
  expect(model.getState().settings.fitDiagrams).toBe(false);
  expect(model.getState().settings.sidebarDefault).toBe(false);
  expect(model.getState().settings.statusVisible).toBe(false);
  expect(screen.getByText(/Applied for now/).textContent).toContain(
    'could not save or synchronize preferences.',
  );
  bridge.update.mockResolvedValueOnce({
    status: 'committed',
    record: record(1, { ...customized, ...appearanceDefaults }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retry preferences' }));
  await waitFor(() => {
    expect(model.getState().status).toBe('saved');
  });
  expect(bridge.update).toHaveBeenCalledTimes(2);
  expect(bridge.update).toHaveBeenLastCalledWith(0, appearanceDefaults);
  expect(model.getState().settings).toEqual({
    ...appearanceDefaults,
    fitDiagrams: false,
    sidebarDefault: false,
    statusVisible: false,
    remoteImageHosts: ['github.com'],
  });
});

it('adds, refuses and removes permitted remote image hosts', async () => {
  const { model, bridge } = await setup({ ...defaults, remoteImageHosts: [] });
  bridge.update.mockImplementation((revision, patch) => {
    const next = { ...model.getState().settings, ...patch };
    return Promise.resolve({
      status: 'committed',
      record: record(revision + 1, next),
    });
  });
  render(<SettingsHarness model={model} />);
  expect(screen.getByText(/No host is permitted/)).toBeTruthy();
  const entry = screen.getByLabelText('Add a host');
  // An unusable entry is refused before it reaches the native owner.
  fireEvent.change(entry, { target: { value: 'https://example.com/image' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
  expect(bridge.update).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('bare host name');
  // A plain host is accepted and offered to the existing settings owner.
  fireEvent.change(entry, { target: { value: 'raw.githubusercontent.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
  await waitFor(() => {
    expect(model.getState().settings.remoteImageHosts).toEqual([
      'raw.githubusercontent.com',
    ]);
  });
  expect(bridge.update).toHaveBeenCalledWith(0, {
    remoteImageHosts: ['raw.githubusercontent.com'],
  });
  // Removing the last host saves an empty list rather than a missing value.
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove raw.githubusercontent.com' }),
  );
  await waitFor(() => {
    expect(model.getState().settings.remoteImageHosts).toEqual([]);
  });
  expect(bridge.update).toHaveBeenLastCalledWith(1, { remoteImageHosts: [] });
  expect(screen.getByText(/No host is permitted/)).toBeTruthy();
});
