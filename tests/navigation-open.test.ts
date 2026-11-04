import { expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import type { NativeReader, Snapshot } from '../src/types';
function setup() {
  const snapshot: Snapshot = {
    documentId: 1,
    contextId: 10,
    revision: 1,
    name: 'first.md',
    location: 'fixture/first.md',
    format: 'markdown',
    source: '# First',
  };
  const bridge = {
    select: vi
      .fn<NativeReader['select']>()
      .mockResolvedValue({ status: 'ready', snapshot }),
    reload: vi
      .fn<NativeReader['reload']>()
      .mockRejectedValue({ message: 'Missing file' }),
    openEntry: vi.fn<NativeReader['openEntry']>(),
    commit: vi.fn<NativeReader['commit']>().mockResolvedValue(),
    cancel: vi.fn<NativeReader['cancel']>().mockResolvedValue(),
    resolve: vi.fn<NativeReader['resolve']>(),
    activate: vi.fn<NativeReader['activate']>(),
  };
  const controller = new ReaderController(bridge, (source, snapshot) => ({
    result: Promise.resolve(
      // The parse seam is exercised end to end elsewhere; a stub keeps this
      // file pinned to the commit/reload state machine.
      {
        html: `<p data-doc="${String(snapshot.documentId)}">${source}</p>`,
        metadata: null,
        headings: [],
        fragments: {},
        resources: [],
        actions: [],
      },
    ),
    cancel: vi.fn(),
  }));
  return { controller, bridge, snapshot };
}
it('native commit rejection retains last-good content and marks the session stale', async () => {
  const { controller, bridge, snapshot } = setup();
  await controller.run('open');
  const old = controller.state.displayed;
  bridge.openEntry.mockResolvedValueOnce({
    ...snapshot,
    documentId: 2,
    revision: 2,
  });
  bridge.commit.mockRejectedValueOnce({ message: 'Retired root' });
  await controller.openEntry({
    binding: { scope: 7, revision: 1, entry: 9 },
    name: 'retired.md',
    focus: 'start',
  });
  expect(controller.state.displayed).toBe(old);
  expect(controller.state.stale).toBe(true);
  expect(controller.state.message).toContain('Retired root');
  // A failed reload also keeps the last-good reading and reports honestly.
  await controller.run('reload');
  expect(controller.state.displayed).toBe(old);
  expect(controller.state.message).toContain('Reload failed');
});
