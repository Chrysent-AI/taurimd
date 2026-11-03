import { describe, expect, it, vi } from 'vitest';
import { NavigationController } from '../src/navigation/model';
import {
  binding,
  compareEntries,
  siblingTargets,
  type FileEntry,
  type FileIndex,
  type FileSortDirection,
  type FileSortKey,
  type NavigationBridge,
  type IndexSnapshot,
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
  dateRank: id,
  sizeRank: id,
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
function cache(
  root: FileIndex,
  phase: IndexSnapshot['status']['phase'] = root.issues.length
    ? 'partial'
    : 'ready',
  message = '',
): IndexSnapshot {
  return {
    index: root,
    status: {
      scope: root.scope,
      revision: root.revision,
      sequence: root.revision,
      phase,
      message,
      degraded: false,
      scans: root.revision,
      traversals: 0,
      entries: root.entries.length,
    },
  };
}
function setup() {
  const bridge = {
    get: vi.fn<NavigationBridge['get']>(),
    listen: vi.fn<NavigationBridge['listen']>().mockResolvedValue(() => {}),
    query: vi.fn<NavigationBridge['query']>(),
    complete: vi.fn<NavigationBridge['complete']>(),
    choose: vi
      .fn<NavigationBridge['choose']>()
      .mockResolvedValue({ status: 'ready', snapshot: cache(index(2)) }),
    refresh: vi
      .fn<NavigationBridge['refresh']>()
      .mockResolvedValue(cache(index(3))),
    siblings: vi.fn<NavigationBridge['siblings']>(),
    quickScope: vi.fn<NavigationBridge['quickScope']>(),
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
        snapshot: cache(
          { ...index(), entries: [] },
          'unavailable',
          `${code} folder`,
        ),
      });
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
      bridge.refresh.mockResolvedValueOnce(cache({ ...index(3), entries: [] }));
      await controller.refresh();
      expect(controller.state.rootStatus).toBe('ready');
      expect(controller.state.rootMessage).toBe('Folder loaded.');
      const partial = {
        ...index(4),
        issues: [
          { relative: 'sub', code: 'denied', message: 'Subfolder unavailable' },
        ],
      };
      bridge.refresh.mockResolvedValueOnce(cache(partial));
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
      snapshot: cache({ ...index(), scope: 10 }),
    });
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
      siblingTargets(controller.state.siblings, 'name', 'asc').previous,
    ).toBeUndefined();
    expect(
      siblingTargets(controller.state.siblings, 'name', 'asc').next?.id,
    ).toBe(2);
    expect(
      siblingTargets(controller.state.siblings, 'modified', 'desc').next,
    ).toBeUndefined();
    expect(
      siblingTargets(controller.state.siblings, 'modified', 'desc').previous
        ?.id,
    ).toBe(2);
    bridge.siblings.mockResolvedValueOnce({
      index: index(),
      active: null,
      inRoot: false,
      rootActive: null,
    });
    await controller.update(doc);
    const excluded = siblingTargets(controller.state.siblings, 'name', 'asc');
    expect(excluded.previous).toBeUndefined();
    expect(excluded.next).toBeUndefined();
    expect(excluded.first).toBeUndefined();
    expect(excluded.last).toBeUndefined();
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
    expect(siblingTargets(siblings, 'name', 'asc').next).toBeUndefined();
    expect(siblingTargets(siblings, 'name', 'asc').previous?.id).toBe(2);
  });
  it('derives the Quick Open scope from the displayed file and drops it when a root is chosen', async () => {
    const { controller, bridge } = setup();
    const derived = { ...index(), scope: 30, revision: 2, name: 'fixture/sub' };
    const held = deferred<FileIndex>();
    bridge.quickScope.mockReturnValueOnce(held.promise);
    const doc = { snapshot: snapshot(), html: '', metadata: null };
    const first = controller.openQuickScope(doc);
    expect(controller.state.quickBusy).toBe(true);
    // One fetch at a time: a second open while pending never re-requests.
    await controller.openQuickScope(doc);
    expect(bridge.quickScope).toHaveBeenCalledOnce();
    held.resolve(derived);
    await first;
    expect(controller.state.quickBusy).toBe(false);
    expect(controller.state.quick?.scope).toBe(30);
    // The recovery path reuses: it adopts the traversal-published scope.
    bridge.quickScope.mockResolvedValueOnce({ ...derived, revision: 3 });
    await controller.openQuickScope(doc, true);
    expect(bridge.quickScope).toHaveBeenNthCalledWith(2, doc.snapshot, true);
    expect(controller.state.quick?.revision).toBe(3);
    // Overlay opens stay plain rescans and drop the old scope synchronously.
    bridge.quickScope.mockResolvedValueOnce({ ...derived, revision: 4 });
    const rescan = controller.openQuickScope(doc);
    expect(controller.state.quick).toBeNull();
    await rescan;
    expect(bridge.quickScope).toHaveBeenNthCalledWith(3, doc.snapshot, false);
    expect(controller.state.quick?.revision).toBe(4);
    // Without a displayed document there is nothing to derive from.
    await controller.openQuickScope(null);
    expect(bridge.quickScope).toHaveBeenCalledTimes(3);
    await controller.choose();
    expect(controller.state.root?.scope).toBe(7);
    expect(controller.state.quick).toBeNull();
    // With a root present the derived scope is never fetched again.
    await controller.openQuickScope(doc);
    expect(bridge.quickScope).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
  it('reports a failed derived-scope fetch and discards a fetch that lands after a root is chosen', async () => {
    const { controller, bridge } = setup();
    const doc = { snapshot: snapshot(), html: '', metadata: null };
    bridge.quickScope.mockRejectedValue({ message: 'folder vanished' });
    await controller.openQuickScope(doc);
    expect(controller.state.quick).toBeNull();
    expect(controller.state.quickBusy).toBe(false);
    expect(controller.state.quickMessage).toContain('folder vanished');
    const held = deferred<FileIndex>();
    bridge.quickScope.mockReturnValueOnce(held.promise);
    const pending = controller.openQuickScope(doc);
    await controller.choose();
    expect(controller.state.quick).toBeNull();
    expect(controller.state.quickBusy).toBe(false);
    held.resolve({ ...index(), scope: 31 });
    await pending;
    // The landed fetch is discarded: the chosen root owns the scope now.
    expect(controller.state.quick).toBeNull();
    expect(controller.state.quickBusy).toBe(false);
    controller.dispose();
  });
});
describe('shared file order and the four sibling endpoints', () => {
  const entry = (
    id: number,
    name: string,
    kind: FileEntry['kind'],
    alphaRank: number,
    dateRank: number | null,
    sizeRank: number | null,
    parent: number | null = null,
  ): FileEntry => ({
    id,
    uiId: id,
    parent,
    context: id + 10,
    name,
    relative: name,
    kind,
    alphaRank,
    dateRank,
    sizeRank,
  });
  const folder = entry(1, 'folder', 'directory', 0, null, null);
  const alpha = entry(2, 'alpha.md', 'markdown', 1, 3, 5);
  const beta = entry(3, 'beta.md', 'markdown', 2, 1, 5);
  const gamma = entry(4, 'gamma.md', 'markdown', 3, 2, 2);
  const missing = entry(5, 'missing.md', 'markdown', 4, null, 2);
  const entries = [folder, alpha, beta, gamma, missing];
  const files = [alpha, beta, gamma, missing];
  const order = (
    list: FileEntry[],
    key: FileSortKey,
    direction: FileSortDirection,
  ) =>
    [...list]
      .sort((a, b) => compareEntries(a, b, key, direction))
      .map((item) => item.name);
  const siblings = (list: FileEntry[], active: number | null) => ({
    index: {
      scope: 7,
      revision: 1,
      name: 'fixture',
      entries: list,
      issues: [],
    },
    active,
    rootActive: active,
    inRoot: true,
  });
  it('orders every key and direction with folders first and stable ties', () => {
    expect(order(entries, 'name', 'asc')).toEqual([
      'folder',
      'alpha.md',
      'beta.md',
      'gamma.md',
      'missing.md',
    ]);
    expect(order(entries, 'name', 'desc')).toEqual([
      'folder',
      'missing.md',
      'gamma.md',
      'beta.md',
      'alpha.md',
    ]);
    expect(order(entries, 'modified', 'asc')).toEqual([
      'folder',
      'beta.md',
      'gamma.md',
      'alpha.md',
      'missing.md',
    ]);
    expect(order(entries, 'modified', 'desc')).toEqual([
      'folder',
      'alpha.md',
      'gamma.md',
      'beta.md',
      'missing.md',
    ]);
    expect(order(entries, 'size', 'asc')).toEqual([
      'folder',
      'gamma.md',
      'missing.md',
      'alpha.md',
      'beta.md',
    ]);
    expect(order(entries, 'size', 'desc')).toEqual([
      'folder',
      'alpha.md',
      'beta.md',
      'gamma.md',
      'missing.md',
    ]);
  });
  it('keeps known metadata before missing metadata in both directions', () => {
    const unsized = entry(6, 'unsized.md', 'markdown', 5, 1, null);
    for (const direction of ['asc', 'desc'] as const) {
      const dated = order([alpha, missing], 'modified', direction);
      expect(dated.indexOf('alpha.md')).toBeLessThan(
        dated.indexOf('missing.md'),
      );
      const sized = order([unsized, alpha], 'size', direction);
      expect(sized.indexOf('alpha.md')).toBeLessThan(
        sized.indexOf('unsized.md'),
      );
    }
  });
  it('keeps nested subsets and the sidebar order equal to the sibling order', () => {
    const nested = [
      entry(6, 'nested/one.md', 'markdown', 1, 2, 1, 6),
      entry(7, 'nested/two.md', 'markdown', 2, 1, 2, 6),
    ];
    expect(order(nested, 'modified', 'asc')).toEqual([
      'nested/two.md',
      'nested/one.md',
    ]);
    const projection = siblings(files, gamma.id);
    const siblingOrder = siblingTargets(projection, 'modified', 'asc');
    expect(siblingOrder.previous?.name).toBe('beta.md');
    expect(siblingOrder.next?.name).toBe('alpha.md');
    expect(siblingOrder.first?.name).toBe('beta.md');
    expect(siblingOrder.last?.name).toBe('missing.md');
    const sidebar = order(entries, 'modified', 'asc').filter(
      (name) => name !== 'folder',
    );
    expect(sidebar).toEqual(['beta.md', 'gamma.md', 'alpha.md', 'missing.md']);
  });
  it('never mutates the native entry order while projecting siblings', () => {
    const source = [...entries];
    siblingTargets(siblings(source, beta.id), 'size', 'desc');
    expect(source.map((item) => item.name)).toEqual(
      entries.map((item) => item.name),
    );
  });
  it('derives previous, next, first and last from one array without wrapping', () => {
    const middle = siblingTargets(siblings(files, beta.id), 'name', 'asc');
    expect(middle.previous?.name).toBe('alpha.md');
    expect(middle.next?.name).toBe('gamma.md');
    expect(middle.first?.name).toBe('alpha.md');
    expect(middle.last?.name).toBe('missing.md');
    const first = siblingTargets(siblings(files, alpha.id), 'name', 'asc');
    expect(first.previous).toBeUndefined();
    expect(first.first).toBeUndefined();
    expect(first.next?.name).toBe('beta.md');
    expect(first.last?.name).toBe('missing.md');
    const last = siblingTargets(siblings(files, missing.id), 'name', 'asc');
    expect(last.next).toBeUndefined();
    expect(last.last).toBeUndefined();
    expect(last.previous?.name).toBe('gamma.md');
    expect(last.first?.name).toBe('alpha.md');
  });
  it('offers no target for an excluded active file, a singleton or an empty list', () => {
    for (const list of [files, [alpha], []]) {
      const excluded = siblingTargets(siblings(list, null), 'name', 'asc');
      expect(excluded.previous).toBeUndefined();
      expect(excluded.next).toBeUndefined();
      expect(excluded.first).toBeUndefined();
      expect(excluded.last).toBeUndefined();
    }
    const singleton = siblingTargets(
      siblings([alpha], alpha.id),
      'name',
      'asc',
    );
    expect(singleton.previous).toBeUndefined();
    expect(singleton.next).toBeUndefined();
    expect(singleton.first).toBeUndefined();
    expect(singleton.last).toBeUndefined();
  });
});
