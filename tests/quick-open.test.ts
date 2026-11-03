import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickOpenController } from '../src/navigation/quick-open';
import { NavigationController } from '../src/navigation/model';
import type {
  FileIndex,
  IndexSnapshot,
  NavigationBridge,
  QueryReply,
  QueryRequest,
} from '../src/navigation/types';
const root = (revision = 1): FileIndex => ({
  scope: 7,
  revision,
  name: 'fixture',
  entries: [],
  issues: [],
});
const snapshot = (revision = 1, sequence = revision): IndexSnapshot => ({
  index: root(revision),
  status: {
    scope: 7,
    revision,
    sequence,
    phase: 'ready',
    degraded: false,
    message: '',
    entries: 0,
    scans: 1,
    traversals: 0,
  },
});
const reply = (request: QueryRequest): QueryReply => ({
  ...request,
  status: 'ready',
  location: '',
  results: [],
  total: 0,
  message: '',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function bridge() {
  return {
    get: vi.fn<NavigationBridge['get']>().mockResolvedValue(snapshot()),
    listen: vi.fn<NavigationBridge['listen']>().mockResolvedValue(() => {}),
    query: vi
      .fn<NavigationBridge['query']>()
      .mockImplementation((request) => Promise.resolve(reply(request))),
    complete: vi
      .fn<NavigationBridge['complete']>()
      .mockImplementation((request) => Promise.resolve(reply(request))),
    refresh: vi.fn<NavigationBridge['refresh']>().mockResolvedValue(snapshot()),
    siblings: vi.fn<NavigationBridge['siblings']>(),
    preview: vi.fn<NavigationBridge['preview']>(),
    cancelPreview: vi
      .fn<NavigationBridge['cancelPreview']>()
      .mockResolvedValue(null),
    reveal: vi.fn<NavigationBridge['reveal']>(),
  };
}
const loadingSnapshot = (revision = 1, sequence = 2): IndexSnapshot => ({
  ...snapshot(revision, sequence),
  status: { ...snapshot(revision, sequence).status, phase: 'loading' },
});
const completionDelay = 20;
async function failedNotifications() {
  const native = bridge();
  native.listen.mockRejectedValue(new Error('Index subscription failed'));
  const model = new NavigationController(native, undefined, completionDelay);
  const disconnect = model.connect();
  await model.recover();
  return { native, model, disconnect };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('production Quick Open debounce and immutable query ownership', () => {
  it('uses the controlled 200ms boundary, never refreshes for typing, and cancels on close', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const recover = vi.fn();
    const model = new QuickOpenController(native, recover);
    model.open(root(), false);
    model.text('a');
    model.text('ab');
    await vi.advanceTimersByTimeAsync(199);
    expect(native.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.query).toHaveBeenCalledOnce();
    expect(model.currentReply()?.text).toBe('ab');
    expect(native.refresh).not.toHaveBeenCalled();
    model.text('abc');
    model.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(native.query).toHaveBeenCalledOnce();
    expect(model.currentReply()).toBeNull();
  });
  it('rejects old replies across typing, root replacement, revision, and close; recomputes latest text', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const model = new QuickOpenController(native, vi.fn());
    const held = deferred<QueryReply>();
    native.query.mockReturnValueOnce(held.promise);
    model.open(root(), false);
    model.text('old');
    await vi.advanceTimersByTimeAsync(200);
    const old = native.query.mock.calls[0][0];
    model.text('latest');
    model.update(root(2), false);
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()).toMatchObject({ text: 'latest', revision: 2 });
    held.resolve(reply(old));
    await Promise.resolve();
    expect(model.currentReply()).toMatchObject({ text: 'latest', revision: 2 });
    model.update({ ...root(3), scope: 20 }, false);
    expect(model.currentReply()).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()?.scope).toBe(20);
    model.close();
    expect(model.currentReply()).toBeNull();
  });
  it('keeps a selected native directory identity through loading and completed revision remapping', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const model = new QuickOpenController(native, vi.fn());
    const folder = {
      id: 10,
      uiId: 100,
      parent: null,
      name: 'a�',
      relative: 'a�',
      kind: 'directory' as const,
      context: 10,
      alphaRank: 0,
      dateRank: 0,
      sizeRank: 0,
    };
    model.open({ ...root(), entries: [folder] }, false);
    model.enterDirectory(folder.relative, folder.id, folder.uiId);
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()?.directory).toBe(10);
    model.update({ ...root(2), entries: [folder] }, true);
    model.update({ ...root(2), entries: [{ ...folder, id: 99 }] }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()).toMatchObject({
      directory: 99,
      revision: 2,
      text: 'a�/',
    });
    model.text('elsewhere/');
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()?.directory).toBeUndefined();
    model.close();
  });
  it('restores only the same native selected binding after a suspended chooser, not a newer revision', async () => {
    vi.useFakeTimers();
    const native = bridge();
    native.query.mockImplementation((request) =>
      Promise.resolve({
        ...reply(request),
        total: 2,
        results: [1, 2].map((id) => ({
          entry: {
            id,
            uiId: id,
            parent: null,
            name: `${String(id)}.md`,
            relative: `${String(id)}.md`,
            kind: 'markdown' as const,
            context: id,
            alphaRank: id,
            dateRank: id,
            sizeRank: id,
          },
          positions: [],
        })),
      }),
    );
    const model = new QuickOpenController(native, vi.fn());
    model.open(root(), false);
    await vi.advanceTimersByTimeAsync(200);
    model.select(1);
    model.close(true);
    model.open(root(), false);
    await vi.advanceTimersByTimeAsync(200);
    expect(model.state.selected).toBe(1);
    model.close(true);
    model.open(root(2), false);
    await vi.advanceTimersByTimeAsync(200);
    expect(model.state.selected).toBe(0);
    model.close();
  });
  it('does not search an implicit scope; directory completion is explicit and uses one existing tuple', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const model = new QuickOpenController(native, vi.fn());
    model.open(null, false);
    model.text('~/');
    await vi.advanceTimersByTimeAsync(200);
    expect(native.query).not.toHaveBeenCalled();
    model.update(root(), true);
    await vi.advanceTimersByTimeAsync(200);
    expect(native.query).not.toHaveBeenCalled();
    native.query.mockImplementationOnce((request) =>
      Promise.resolve({ ...reply(request), status: 'missing' }),
    );
    model.update(root(), false);
    await vi.advanceTimersByTimeAsync(200);
    expect(native.complete).not.toHaveBeenCalled();
    await model.complete();
    expect(native.complete).toHaveBeenCalledOnce();
    expect(model.enterDirectory('sub')).toBe(true);
    expect(model.enterDirectory('sub')).toBe(false);
    model.close();
    model.open(root(), false);
    expect(model.state.text).toBe('sub/');
    model.close();
  });
});
describe('traverse recovery against the watched working folder', () => {
  it('adopts the traversal-published root revision instead of rescanning it away', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const recover = vi.fn();
    const model = new QuickOpenController(native, recover);
    const folder = root();
    model.open(folder, false);
    // A hollow boundary directory probes as missing (native query policy).
    native.query.mockImplementationOnce((request) =>
      Promise.resolve({ ...reply(request), status: 'missing' }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(model.currentReply()?.status).toBe('missing');
    // The native traverse reads the directory, republishes the root under
    // revision 2, and returns the request-built pre-traversal reply: still
    // revision 1 and missing. Convergence comes from the recovery fetch
    // adopting the republished scope, not from the reply's revision.
    native.complete.mockImplementationOnce((request) =>
      Promise.resolve({ ...reply(request), status: 'missing' }),
    );
    await model.complete();
    expect(native.complete).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    // The pre-traversal missing reply stays visible as "Reading folder…"
    // while the recovery fetch runs.
    expect(model.currentReply()).toMatchObject({
      revision: 1,
      status: 'missing',
    });
    expect(model.state.message).toBe('Reading folder…');
    // The recovery fetch adopts the published scope: revision 2 survives
    // with the just-read directory, and the re-search is ready with it.
    const child = {
      id: 41,
      uiId: 41,
      parent: 12,
      name: 'child.md',
      relative: 'four/child.md',
      kind: 'markdown' as const,
      context: 41,
      alphaRank: 1,
      dateRank: 1,
      sizeRank: 1,
    };
    native.query.mockImplementationOnce((request) =>
      Promise.resolve({
        ...reply(request),
        total: 1,
        results: [{ entry: child, positions: [] }],
      }),
    );
    model.update({ ...root(2), entries: [child] }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(native.query).toHaveBeenCalledTimes(2);
    expect(native.query.mock.calls[1][0]).toMatchObject({
      scope: 7,
      revision: 2,
    });
    expect(model.currentReply()).toMatchObject({ revision: 2, total: 1 });
    model.close();
  });
});
describe('revisioned getter and actual subscription lifecycle', () => {
  it('settles explicit refresh without focus after rejected notifications, pacing cached getters instead of scanning again', async () => {
    vi.useFakeTimers();
    const { native, model, disconnect } = await failedNotifications();
    try {
      const before = native.get.mock.calls.length;
      native.refresh.mockResolvedValueOnce(loadingSnapshot());
      native.get.mockResolvedValue(loadingSnapshot(2, 3));
      await model.refresh();
      expect(model.state.rootBusy).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(completionDelay - 1);
      expect(native.get).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(native.get).toHaveBeenCalledTimes(before + 1);
      expect(model.state.root?.revision).toBe(2);
      expect(model.state.rootBusy).toBe(true);
      native.get.mockResolvedValue(snapshot(2, 4));
      await vi.advanceTimersByTimeAsync(completionDelay - 1);
      expect(native.get).toHaveBeenCalledTimes(before + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(native.get).toHaveBeenCalledTimes(before + 2);
      expect(native.refresh).toHaveBeenCalledOnce();
      expect(model.state.rootStatus).toBe('ready');
      expect(model.state.rootBusy).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      native.refresh.mockResolvedValueOnce(loadingSnapshot(2, 5));
      native.get.mockResolvedValue(snapshot(3, 6));
      await model.refresh();
      await vi.advanceTimersByTimeAsync(completionDelay);
      expect(native.refresh).toHaveBeenCalledTimes(2);
      expect(model.state.root?.revision).toBe(3);
      expect(model.state.rootBusy).toBe(false);
    } finally {
      disconnect();
      model.dispose();
    }
  });
  it.each(['partial', 'unavailable'] as const)(
    'stops completion recovery at an honest %s snapshot',
    async (phase) => {
      vi.useFakeTimers();
      const { native, model, disconnect } = await failedNotifications();
      try {
        native.refresh.mockResolvedValueOnce(loadingSnapshot());
        const terminal = snapshot(2, 3);
        terminal.status.phase = phase;
        terminal.status.message = 'Folder unavailable';
        if (phase === 'partial')
          terminal.index = {
            ...root(2),
            issues: [
              {
                relative: 'denied',
                code: 'denied',
                message: 'Subfolder unavailable',
              },
            ],
          };
        native.get.mockResolvedValue(terminal);
        await model.refresh();
        await vi.advanceTimersByTimeAsync(completionDelay);
        expect(model.state.rootStatus).toBe(phase);
        expect(model.state.rootBusy).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const calls = native.get.mock.calls.length;
        await vi.advanceTimersByTimeAsync(completionDelay * 20);
        expect(native.get).toHaveBeenCalledTimes(calls);
        expect(native.refresh).toHaveBeenCalledOnce();
      } finally {
        disconnect();
        model.dispose();
      }
    },
  );
  it('ends failed getter recovery with retryable retained availability rather than rearming forever', async () => {
    vi.useFakeTimers();
    const { native, model, disconnect } = await failedNotifications();
    try {
      native.refresh.mockResolvedValueOnce(loadingSnapshot());
      native.get.mockRejectedValueOnce(new Error('Getter failed'));
      await model.refresh();
      await vi.advanceTimersByTimeAsync(completionDelay);
      expect(model.state.rootStatus).toBe('unavailable');
      expect(model.state.rootBusy).toBe(false);
      expect(model.state.rootMessage).toContain(
        'Retained entries are last known',
      );
      expect(model.state.message).toContain('Could not retrieve');
      expect(vi.getTimerCount()).toBe(0);
      const calls = native.get.mock.calls.length;
      await vi.advanceTimersByTimeAsync(completionDelay * 20);
      expect(native.get).toHaveBeenCalledTimes(calls);
    } finally {
      disconnect();
      model.dispose();
    }
  });
  it.each([
    ['disconnect', 'ready'],
    ['dispose', 'ready'],
    ['disconnect', 'error'],
    ['dispose', 'error'],
  ] as const)(
    'cancels scheduled recovery after %s and suppresses a held getter %s',
    async (end, outcome) => {
      vi.useFakeTimers();
      const { native, model, disconnect } = await failedNotifications();
      try {
        native.refresh.mockResolvedValueOnce(loadingSnapshot());
        const held = deferred<IndexSnapshot>();
        native.get.mockReturnValueOnce(held.promise);
        await model.refresh();
        await vi.advanceTimersByTimeAsync(completionDelay);
        const pending = model.recover();
        disconnect();
        if (end === 'dispose') model.dispose();
        const stopped = model.state;
        const calls = native.get.mock.calls.length;
        if (outcome === 'ready') held.resolve(snapshot(2, 100));
        else held.reject(new Error('Retired getter failed'));
        await pending;
        expect(model.state).toBe(stopped);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(completionDelay * 20);
        expect(native.get).toHaveBeenCalledTimes(calls);
      } finally {
        disconnect();
        model.dispose();
      }
    },
  );
  it('replaces an old root recovery with one current loading-root recovery without overlapping getters or stale ready publication', async () => {
    vi.useFakeTimers();
    const { native, model, disconnect } = await failedNotifications();
    try {
      native.refresh.mockResolvedValueOnce(loadingSnapshot());
      const held = deferred<IndexSnapshot>();
      native.get.mockReturnValueOnce(held.promise);
      const before = native.get.mock.calls.length;
      await model.refresh();
      await vi.advanceTimersByTimeAsync(completionDelay);
      const pending = model.recover();
      const nextLoading: IndexSnapshot = {
        index: { ...root(), scope: 40 },
        status: { ...loadingSnapshot().status, scope: 40 },
      };
      const nextReady: IndexSnapshot = {
        index: { ...root(2), scope: 40 },
        status: { ...snapshot(2, 3).status, scope: 40 },
      };
      native.get.mockResolvedValue(nextReady);
      // A replaced working folder (scope 40) publishes while the old getter
      // is held; the notification starts one superseding recovery.
      native.listen.mock.calls[0][0](nextLoading.status);
      expect(model.state.rootBusy).toBe(true);
      await vi.advanceTimersByTimeAsync(completionDelay);
      expect(native.get).toHaveBeenCalledTimes(before + 1);
      held.resolve(snapshot(2, 100));
      await pending;
      expect(native.get).toHaveBeenCalledTimes(before + 2);
      expect(model.state.root?.scope).toBe(40);
      expect(model.state.root?.revision).toBe(2);
      expect(model.state.rootBusy).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(native.refresh).toHaveBeenCalledOnce();
    } finally {
      disconnect();
      model.dispose();
    }
  });
  it.each(['disconnect', 'dispose', 'root'] as const)(
    'cancels an unconsumed completion wake on %s retirement',
    async (end) => {
      vi.useFakeTimers();
      const { native, model, disconnect } = await failedNotifications();
      try {
        native.refresh.mockResolvedValueOnce(loadingSnapshot());
        await model.refresh();
        expect(vi.getTimerCount()).toBe(1);
        const calls = native.get.mock.calls.length;
        const replacement: IndexSnapshot = {
          index: { ...root(), scope: 40 },
          status: { ...snapshot().status, scope: 40 },
        };
        if (end === 'disconnect') disconnect();
        else if (end === 'dispose') model.dispose();
        else {
          native.get.mockResolvedValue(replacement);
          native.listen.mock.calls[0][0](replacement.status);
          await Promise.resolve();
          await Promise.resolve();
        }
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(completionDelay * 20);
        expect(native.get).toHaveBeenCalledTimes(
          end === 'root' ? calls + 1 : calls,
        );
      } finally {
        disconnect();
        model.dispose();
      }
    },
  );
  it('never starts completion polling while the installed listener is healthy', async () => {
    vi.useFakeTimers();
    const native = bridge();
    const model = new NavigationController(native, undefined, completionDelay);
    const disconnect = model.connect();
    try {
      await model.recover();
      const before = native.get.mock.calls.length;
      native.refresh.mockResolvedValueOnce(loadingSnapshot());
      await model.refresh();
      await vi.advanceTimersByTimeAsync(completionDelay * 20);
      expect(native.get).toHaveBeenCalledTimes(before);
      expect(vi.getTimerCount()).toBe(0);
      native.get.mockResolvedValue(snapshot(2, 3));
      native.listen.mock.calls[0][0](snapshot(2, 3).status);
      await model.recover();
      expect(model.state.rootBusy).toBe(false);
      expect(native.refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      disconnect();
      model.dispose();
    }
  });
  it('coalesces notification bursts to one getter plus one pending recovery and invalidates before old replies arrive', async () => {
    const native = bridge();
    const held = deferred<IndexSnapshot>();
    native.get
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(snapshot(2, 100));
    const model = new NavigationController(native);
    const close = model.connect();
    await Promise.resolve();
    const receive = native.listen.mock.calls[0][0];
    for (let sequence = 2; sequence < 52; sequence++)
      receive({ ...snapshot(2, sequence).status, phase: 'loading' });
    expect(native.get).toHaveBeenCalledOnce();
    expect(model.state.rootBusy).toBe(true);
    held.resolve(snapshot(1, 1));
    await model.recover();
    expect(native.get).toHaveBeenCalledTimes(2);
    expect(model.state.root?.revision).toBe(2);
    expect(model.state.rootBusy).toBe(false);
    close();
    model.dispose();
  });
  it('keeps loading ownership while the working folder scan is in flight', async () => {
    const native = bridge();
    native.get.mockResolvedValue({
      ...snapshot(),
      status: { ...snapshot().status, phase: 'loading' },
    });
    const model = new NavigationController(native);
    await model.recover();
    expect(model.state.root).toEqual(snapshot().index);
    expect(model.state.rootBusy).toBe(true);
    expect(model.state.rootStatus).toBe('loading');
    model.dispose();
  });
  it('subscribes before getter, rejects older same-revision status, and disposes late installation', async () => {
    const native = bridge();
    const installing = deferred<() => void>();
    native.listen.mockReturnValueOnce(installing.promise);
    const model = new NavigationController(native);
    const disconnect = model.connect();
    expect(native.get).not.toHaveBeenCalled();
    const stop = vi.fn();
    installing.resolve(stop);
    await Promise.resolve();
    await Promise.resolve();
    expect(native.get).toHaveBeenCalledOnce();
    await model.recover();
    const newer = {
      ...snapshot(1, 10),
      status: { ...snapshot(1, 10).status, degraded: true },
    };
    native.get.mockResolvedValueOnce(newer);
    await model.recover();
    native.get.mockResolvedValueOnce(snapshot(1, 9));
    await model.recover();
    expect(model.state.cache?.degraded).toBe(true);
    disconnect();
    expect(stop).toHaveBeenCalledOnce();
    model.dispose();
    const late = bridge();
    const waiting = deferred<() => void>();
    late.listen.mockReturnValue(waiting.promise);
    const next = new NavigationController(late);
    const close = next.connect();
    close();
    next.dispose();
    const lateStop = vi.fn();
    waiting.resolve(lateStop);
    await Promise.resolve();
    expect(lateStop).toHaveBeenCalledOnce();
    expect(late.get).not.toHaveBeenCalled();
  });
  it('recovers a missed event through getter, invalidates same-metadata previews, and never enrolls a document', async () => {
    const native = bridge();
    const model = new NavigationController(native);
    const close = model.connect();
    await Promise.resolve();
    await model.recover();
    native.get.mockResolvedValue(snapshot(2, 4));
    native.listen.mock.calls[0][0](snapshot(2, 4).status);
    await model.recover();
    expect(model.state.root?.revision).toBe(2);
    expect(native.preview).not.toHaveBeenCalled();
    expect(native.refresh).not.toHaveBeenCalled();
    close();
    model.dispose();
  });
});
