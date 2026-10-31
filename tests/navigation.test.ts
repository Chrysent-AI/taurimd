import { describe, expect, it, vi } from 'vitest';
import { NavigationController } from '../src/navigation/model';
import {
  binding,
  neighbors,
  type FileEntry,
  type FileIndex,
  type NavigationBridge,
} from '../src/navigation/types';
import type { Snapshot } from '../src/types';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
const file = (id = 1, kind: FileEntry['kind'] = 'markdown'): FileEntry => ({
  id,
  uiId: id,
  parent: null,
  context: id + 10,
  name: `${String(id)}.md`,
  relative: `${String(id)}.md`,
  kind,
  alphaRank: id,
  dateRank: 4 - id,
});
const index = (revision = 1): FileIndex => ({
  scope: 7,
  revision,
  name: 'fixture',
  entries: [file(1), file(2), file(3, 'text')],
  issues: [],
});
const snapshot = (contextId = 11, revision = 1): Snapshot => ({
  documentId: 0,
  contextId,
  revision,
  name: '1.md',
  location: 'fixture/1.md',
  format: 'markdown',
  source: '# Same\n## Same',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  const bridge = {
    choose: vi
      .fn<NavigationBridge['choose']>()
      .mockResolvedValue({ status: 'ready', index: index() }),
    refresh: vi.fn<NavigationBridge['refresh']>().mockResolvedValue(index(2)),
    siblings: vi.fn<NavigationBridge['siblings']>(),
    preview: vi.fn<NavigationBridge['preview']>().mockResolvedValue(snapshot()),
    cancelPreview: vi
      .fn<NavigationBridge['cancelPreview']>()
      .mockResolvedValue(null),
    reveal: vi.fn<NavigationBridge['reveal']>().mockResolvedValue(null),
  };
  const parse = vi.fn(
    (source: string, _snapshot?: Snapshot, namespace?: string) => ({
      result: Promise.resolve(
        sanitizeReading(parseMarkdown(source), namespace),
      ),
      cancel: vi.fn(),
    }),
  );
  return { bridge, parse, controller: new NavigationController(bridge, parse) };
}
describe('production navigation state and shared native adapter DTO projection', () => {
  it('does not read document bodies on choosing, retains cancelled roots, and labels failed refresh last known', async () => {
    const { controller, bridge, parse } = setup();
    await controller.choose();
    const root = controller.state.root;
    expect(root?.revision).toBe(2);
    expect(bridge.preview).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    bridge.choose.mockResolvedValueOnce({ status: 'cancelled' });
    await controller.choose();
    expect(controller.state.root).toBe(root);
    bridge.refresh.mockRejectedValueOnce({ message: 'Access denied' });
    await controller.refresh();
    expect(controller.state.root).toBe(root);
    expect(controller.state.rootStatus).toBe('unavailable');
    expect(controller.state.rootMessage).toContain('last known');
    controller.dispose();
  });
  it.each(['denied', 'notFound'])(
    'keeps persistent %s root availability through cancelled/failed choices and unrelated feedback until a successful scan',
    async (code) => {
      const { controller, bridge } = setup();
      bridge.choose.mockResolvedValueOnce({
        status: 'ready',
        index: { ...index(), entries: [] },
      });
      bridge.refresh.mockRejectedValueOnce({ code, message: `${code} folder` });
      await controller.choose();
      const root = controller.state.root;
      const explanation = controller.state.rootMessage;
      const current = { snapshot: snapshot(), html: '', metadata: null };
      const unavailable = () => {
        expect(controller.state.root).toBe(root);
        expect(controller.state.rootStatus).toBe('unavailable');
        expect(controller.state.rootMessage).toBe(explanation);
        expect(explanation).toContain(`${code} folder`);
        expect(explanation).toContain('last known');
      };
      unavailable();
      bridge.choose.mockResolvedValueOnce({ status: 'cancelled' });
      await controller.choose();
      unavailable();
      bridge.choose.mockRejectedValueOnce({ message: 'Chooser unavailable' });
      await controller.choose();
      unavailable();
      await controller.reveal(current);
      unavailable();
      bridge.reveal.mockRejectedValueOnce({ message: 'Reveal unavailable' });
      await controller.reveal(current);
      unavailable();
      controller.notice('This section is no longer present.', true);
      unavailable();
      bridge.refresh.mockResolvedValueOnce({ ...index(3), entries: [] });
      await controller.refresh();
      expect(controller.state.rootStatus).toBe('ready');
      expect(controller.state.rootMessage).toBe('Folder loaded.');
      const partial = {
        ...index(4),
        issues: [
          { relative: 'sub', code: 'denied', message: 'Subfolder unavailable' },
        ],
      };
      bridge.refresh.mockResolvedValueOnce(partial);
      await controller.refresh();
      await controller.reveal(current);
      controller.notice('Section selected');
      expect(controller.state.rootStatus).toBe('partial');
      expect(controller.state.rootMessage).toContain('incomplete results');
      expect(controller.state.root?.issues).toEqual(partial.issues);
      controller.dispose();
    },
  );
  it('previews only requested Markdown through the shared parser and retains completed context/source until explicit invalidation', async () => {
    const { controller, bridge, parse } = setup();
    await controller.choose();
    const root = controller.state.root;
    if (!root) throw new Error('Expected selected root');
    await controller.preview(root, root.entries[2]);
    expect(bridge.preview).not.toHaveBeenCalled();
    await controller.preview(root, root.entries[0]);
    const preview = controller.state.previews.get(1);
    expect(preview?.snapshot?.contextId).toBe(11);
    expect(preview?.snapshot?.source).toBe('# Same\n## Same');
    expect(preview?.headings.map((h) => h.key)).toEqual([1, 2]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][2]).toContain('preview-7-2-1-11-1');
    controller.collapse(1);
    expect(controller.state.previews.get(1)).toBe(preview);
    controller.invalidate();
    expect(controller.state.previews.size).toBe(0);
    await controller.preview(root, root.entries[0]);
    expect(bridge.preview).toHaveBeenCalledTimes(2);
    await controller.refresh();
    expect(controller.state.previews.size).toBe(0);
    controller.dispose();
  });
  it('cancels only collapsed owned work and ignores its late native response', async () => {
    const { controller, bridge, parse } = setup();
    await controller.choose();
    const root = controller.state.root;
    if (!root) throw new Error('Expected selected root');
    const held = deferred<Snapshot>();
    bridge.preview.mockReturnValueOnce(held.promise);
    const preview = controller.preview(root, root.entries[0]);
    expect(controller.state.previews.get(1)?.phase).toBe('loading');
    controller.collapse(1);
    held.resolve(snapshot());
    await preview;
    expect(parse).not.toHaveBeenCalled();
    expect(bridge.cancelPreview).toHaveBeenCalledTimes(1);
    expect(controller.state.previews.has(1)).toBe(false);
    controller.dispose();
  });
  it('terminates its real parse-job seam on supersession without publishing old-root headings', async () => {
    const { controller, bridge, parse } = setup();
    await controller.choose();
    const root = controller.state.root;
    if (!root) throw new Error('Expected selected root');
    const reading = deferred<ReturnType<typeof sanitizeReading>>();
    const cancel = vi.fn();
    parse.mockReturnValueOnce({ result: reading.promise, cancel });
    const pending = controller.preview(root, root.entries[0]);
    await Promise.resolve();
    controller.invalidate();
    expect(cancel).toHaveBeenCalledOnce();
    reading.resolve(sanitizeReading(parseMarkdown('# Obsolete')));
    await pending;
    expect(controller.state.previews.size).toBe(0);
    bridge.choose.mockResolvedValueOnce({
      status: 'ready',
      index: { ...index(), scope: 10 },
    });
    bridge.refresh.mockResolvedValueOnce({ ...index(), scope: 10 });
    await controller.choose();
    expect(controller.state.root?.scope).toBe(10);
    controller.dispose();
  });
  it('retains errors locally and native-ranked siblings never wrap or invent active membership', async () => {
    const { controller, bridge } = setup();
    const doc = { snapshot: snapshot(), html: '', metadata: null };
    bridge.siblings.mockResolvedValue({
      index: index(),
      active: 1,
      inRoot: true,
      rootActive: 1,
    });
    await controller.update(doc);
    expect(
      neighbors(controller.state.siblings, false).previous,
    ).toBeUndefined();
    expect(neighbors(controller.state.siblings, false).next?.id).toBe(2);
    expect(neighbors(controller.state.siblings, true).next).toBeUndefined();
    expect(neighbors(controller.state.siblings, true).previous?.id).toBe(2);
    bridge.siblings.mockResolvedValueOnce({
      index: index(),
      active: null,
      inRoot: false,
      rootActive: null,
    });
    await controller.update(doc);
    expect(neighbors(controller.state.siblings, false)).toEqual({
      previous: undefined,
      next: undefined,
    });
    bridge.reveal.mockRejectedValueOnce({ message: 'Missing file' });
    await controller.reveal(doc);
    expect(controller.state.message).toContain('Missing file');
    expect(controller.state.error).toBe(true);
    controller.dispose();
  });
  it('exposes immutable tuple selection and filters directory entries without changing native ranks', () => {
    const source = index();
    const entry = file(1);
    expect(binding(source, entry)).toEqual({ scope: 7, revision: 1, entry: 1 });
    const siblings = {
      index: { ...source, entries: [...source.entries, file(4, 'directory')] },
      active: 3,
      rootActive: 3,
      inRoot: true,
    };
    expect(neighbors(siblings, false).next).toBeUndefined();
    expect(neighbors(siblings, false).previous?.id).toBe(2);
  });
});
