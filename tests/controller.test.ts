import { describe, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import type { NativeReader, Selection, Snapshot } from '../src/types';
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
    select: vi
      .fn<NativeReader['select']>()
      .mockResolvedValue({ status: 'ready', snapshot: snapshot() }),
    reload: vi
      .fn<NativeReader['reload']>()
      .mockResolvedValue(snapshot('first.md', 2)),
    commit: vi.fn<NativeReader['commit']>().mockResolvedValue(),
    cancel: vi.fn<NativeReader['cancel']>().mockResolvedValue(),
  };
  const parse = vi.fn(() => ({
    result: Promise.resolve('<h1>Local</h1>'),
    cancel: vi.fn(),
  }));
  return { bridge, parse, controller: new ReaderController(bridge, parse) };
}
describe('production reader state and native commit boundary', () => {
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
    const result = deferred<string>();
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
