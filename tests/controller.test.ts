import { describe, expect, it, vi } from 'vitest';
import type { ParseJob } from '../src/reader/worker';
import type { Reading } from '../src/reader/parse';
import { ReaderController } from '../src/controller';
import type {
  Activation,
  NativeReader,
  Selection,
  Snapshot,
} from '../src/types';
function snapshot(name = 'first.md', revision = 1): Snapshot {
  return {
    documentId: revision,
    revision,
    name,
    location: `fixture/${name}`,
    source: '# Local',
    format: 'markdown',
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const bridge = {
    openEntry: vi
      .fn<NativeReader['openEntry']>()
      .mockResolvedValue(snapshot('entry.md', 2)),
    select: vi
      .fn<NativeReader['select']>()
      .mockResolvedValue({ status: 'ready', snapshot: snapshot() }),
    reload: vi
      .fn<NativeReader['reload']>()
      .mockResolvedValue(snapshot('first.md', 2)),
    commit: vi.fn<NativeReader['commit']>().mockResolvedValue(),
    cancel: vi.fn<NativeReader['cancel']>().mockResolvedValue(),
    resolve: vi.fn<NativeReader['resolve']>(),
    activate: vi.fn<NativeReader['activate']>(),
  };
  const parse = vi.fn(
    (): ParseJob => ({
      result: Promise.resolve({ html: '<h1>Local</h1>', metadata: null }),
      cancel: vi.fn(),
    }),
  );
  return { bridge, parse, controller: new ReaderController(bridge, parse) };
}
describe('production reader state and native commit boundary', () => {
  it('hands local links off without reading, reparsing, committing or staling the origin', async () => {
    const { bridge, controller, parse } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    if (!previous) throw new Error('Expected last-good document');
    bridge.activate.mockResolvedValueOnce({ status: 'handedOff' });
    await controller.activate(previous, 'linked.md#destination');
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.linkMessage).toBe('Opened in another reader.');
    expect(controller.state.message).toBe('Opened first.md.');
    expect(controller.state.stale).toBe(false);
    expect(parse).toHaveBeenCalledOnce();
    expect(bridge.commit).toHaveBeenCalledOnce();
  });
  it('receives native-owned snapshots through the real parse/commit boundary and handles receiving failure locally', async () => {
    const { bridge, controller, parse } = setup();
    await controller.receive(() =>
      Promise.resolve({
        snapshot: snapshot('linked.md', 1),
        fragment: 'destination',
      }),
    );
    expect(controller.state.displayed?.snapshot.name).toBe('linked.md');
    expect(controller.state.displayed?.fragment).toBe('destination');
    expect(bridge.commit).toHaveBeenLastCalledWith(1);
    const previous = controller.state.displayed;
    parse.mockReturnValueOnce({
      result: Promise.reject(new Error('Receiving parse failed')),
      cancel: vi.fn(),
    });
    await controller.receive(() =>
      Promise.resolve({ snapshot: snapshot('next.md', 2), fragment: null }),
    );
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.stale).toBe(true);
    expect(controller.state.message).toContain('Receiving parse failed');
    expect(bridge.cancel).toHaveBeenCalledWith(2);
    expect(bridge.commit).toHaveBeenCalledTimes(1);
  });
  it('clears link progress on cancellation and ignores a late native document result', async () => {
    const { bridge, controller, parse } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    if (!previous) throw new Error('Expected last-good document');
    const result = deferred<Activation>();
    bridge.activate.mockReturnValueOnce(result.promise);
    const pending = controller.activate(previous, 'linked.md');
    expect(controller.state.linkMessage).toBe('Opening link…');
    await controller.cancel();
    expect(bridge.cancel).toHaveBeenCalledWith(2);
    expect(controller.state.linkMessage).toBe('');
    result.resolve({ status: 'handedOff' });
    await pending;
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.message).toContain('cancelled');
    expect(controller.state.linkMessage).toBe('');
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('cancels receiving parsing with clear terminal progress and no native commit', async () => {
    const { bridge, controller, parse } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    if (!previous) throw new Error('Expected last-good document');
    const result = deferred<Reading>();
    parse.mockReturnValueOnce({
      result: result.promise,
      cancel: () => {
        result.reject(new Error('Cancelled linked parse'));
      },
    });
    const pending = controller.receive(() =>
      Promise.resolve({ snapshot: snapshot('linked.md', 2), fragment: null }),
    );
    await Promise.resolve();
    expect(controller.state.phase).toBe('parsing');
    await controller.cancel();
    await pending;
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.linkMessage).toBe('');
    expect(bridge.commit).toHaveBeenCalledTimes(1);
  });
  it('retains origin for chooser collisions and cached-file handoffs, including rejected activation', async () => {
    const { bridge, controller, parse } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    bridge.select.mockResolvedValueOnce({ status: 'handedOff' });
    expect(await controller.run('open')).toBe('handedOff');
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.stale).toBe(false);
    bridge.openEntry.mockResolvedValueOnce({ status: 'handedOff' });
    const intent = {
      binding: { scope: 1, revision: 1, entry: 1 },
      name: 'cached.md',
      focus: 'start' as const,
    };
    expect(await controller.openEntry(intent, true)).toBe('handedOff');
    expect(bridge.openEntry).toHaveBeenLastCalledWith(3, intent.binding, true);
    bridge.select.mockRejectedValueOnce({
      code: 'handoff',
      message: 'Target closed',
    });
    await controller.run('open');
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.stale).toBe(false);
    expect(controller.state.linkMessage).toContain('Target closed');
    expect(parse).toHaveBeenCalledOnce();
    expect(bridge.commit).toHaveBeenCalledOnce();
  });
  it('keeps last-good content and distinguishes failed target, reload and cancellation', async () => {
    const { bridge, controller } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    bridge.select.mockRejectedValueOnce({
      code: 'invalidUtf8',
      message: 'Not UTF-8',
      attempted: 'broken.md',
    });
    await controller.run('open');
    expect(controller.state.displayed).toBe(previous);
    expect(controller.state.stale).toBe(true);
    expect(controller.state.message).toContain('broken.md');
    expect(controller.state.message).toContain('first.md');
    bridge.reload.mockRejectedValueOnce(new Error('Missing file'));
    await controller.run('reload');
    expect(controller.state.message).toContain('Reload failed');
    expect(controller.state.displayed).toBe(previous);
    bridge.select.mockResolvedValueOnce({ status: 'cancelled' });
    await controller.run('open');
    expect(controller.state.stale).toBe(true);
    expect(controller.state.message).toContain('cancelled');
  });
  it('never sends plain text through parsing and commits empty files', async () => {
    const { bridge, parse, controller } = setup();
    bridge.select.mockResolvedValueOnce({
      status: 'ready',
      snapshot: {
        ...snapshot('literal.txt'),
        format: 'text',
        source: '<script>literal</script>',
      },
    });
    await controller.run('open');
    expect(parse).not.toHaveBeenCalled();
    expect(controller.state.displayed?.html).toBeNull();
    bridge.select.mockResolvedValueOnce({
      status: 'ready',
      snapshot: { ...snapshot('empty.md', 2), source: '' },
    });
    await controller.run('open');
    expect(controller.state.message).toContain('empty file');
    expect(bridge.commit).toHaveBeenCalledTimes(2);
  });
  it('ignores a superseded native response', async () => {
    const { bridge, controller } = setup();
    const first = deferred<Selection>();
    bridge.select.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      status: 'ready',
      snapshot: snapshot('second.md', 2),
    });
    const old = controller.run('open');
    await controller.run('open');
    first.resolve({ status: 'ready', snapshot: snapshot() });
    await old;
    expect(controller.state.displayed?.snapshot.name).toBe('second.md');
    expect(bridge.commit).toHaveBeenCalledTimes(1);
  });
  it('terminates parsing on cancellation and prevents late publication', async () => {
    const { bridge, controller, parse } = setup();
    const result = deferred<Reading>();
    const cancel = vi.fn(() => {
      result.reject(new Error('Cancelled'));
    });
    parse.mockReturnValueOnce({ result: result.promise, cancel });
    const pending = controller.run('open');
    await Promise.resolve();
    expect(controller.state.phase).toBe('parsing');
    await controller.cancel();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(bridge.cancel).toHaveBeenCalledWith(1);
    expect(bridge.commit).not.toHaveBeenCalled();
    expect(controller.state.displayed).toBeNull();
  });
  it('ignores a late cancellation failure after a newer document succeeds', async () => {
    const { bridge, controller } = setup();
    await controller.run('open');
    const pendingCancel = deferred<undefined>();
    bridge.cancel.mockReturnValueOnce(pendingCancel.promise);
    const cancelling = controller.cancel();
    bridge.select.mockResolvedValueOnce({
      status: 'ready',
      snapshot: snapshot('newer.md', 3),
    });
    await controller.run('open');
    pendingCancel.reject(new Error('Old cancellation acknowledgement failed'));
    await cancelling;
    expect(controller.state.message).toBe('Opened newer.md.');
    expect(controller.state.displayed?.snapshot.name).toBe('newer.md');
  });
  it('does not advance native identity on render failure and closes the commit interleave', async () => {
    const { bridge, controller, parse } = setup();
    await controller.run('open');
    const previous = controller.state.displayed;
    parse.mockReturnValueOnce({
      result: Promise.reject(new Error('Parse failed')),
      cancel: vi.fn(),
    });
    await controller.run('open');
    expect(controller.state.displayed).toBe(previous);
    expect(bridge.commit).toHaveBeenCalledTimes(1);
    const commit = deferred<undefined>();
    bridge.commit.mockReturnValueOnce(commit.promise);
    const next = controller.run('open');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state.phase).toBe('committing');
    await controller.run('open');
    await controller.cancel();
    commit.resolve(undefined);
    await next;
    expect(bridge.select).toHaveBeenCalledTimes(3);
  });
});
