import { describe, expect, it, vi } from 'vitest';
import { NavigationController, quickOpenScope } from '../src/navigation/model';
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
    refresh: vi
      .fn<NavigationBridge['refresh']>()
      .mockResolvedValue(cache(index(3))),
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
// The controller learns about the working folder through its recovery getter;
// the native side adopts it at the document's commit.
async function adoptRoot(
  bridge: ReturnType<typeof setup>['bridge'],
  controller: NavigationController,
  snap: IndexSnapshot,
) {
  bridge.get.mockResolvedValueOnce(snap);
  await controller.recover();
}
describe('production navigation state and shared native adapter DTO projection', () => {
  it('does not read document bodies when a root is accepted and labels a failed refresh last known', async () => {
    const { controller, bridge, parse } = setup();
    await adoptRoot(bridge, controller, cache(index(2)));
    const root = controller.state.root;
    expect(root?.revision).toBe(2);
    expect(bridge.preview).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    bridge.refresh.mockRejectedValueOnce({ message: 'Access denied' });
    await controller.refresh();
    expect(controller.state.root).toBe(root);
    expect(controller.state.rootStatus).toBe('unavailable');
    expect(controller.state.rootMessage).toContain('last known');
    controller.dispose();
  });
  it.each(['denied', 'notFound'])(
    'keeps persistent %s root availability through unrelated feedback until a successful scan',
    async (code) => {
      const { controller, bridge } = setup();
      await adoptRoot(
        bridge,
        controller,
        cache({ ...index(), entries: [] }, 'unavailable', `${code} folder`),
      );
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
    await adoptRoot(bridge, controller, cache(index(2)));
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
  it('reuses the displayed reading for its own preview and retires the superseded native work', async () => {
    const { controller, bridge, parse } = setup();
    await adoptRoot(bridge, controller, cache(index(2)));
    const root = controller.state.root;
    if (!root) throw new Error('Expected selected root');
    const held = deferred<Snapshot>();
    bridge.preview.mockReturnValueOnce(held.promise);
    const pending = controller.preview(root, root.entries[0]);
    expect(controller.state.previews.get(1)?.phase).toBe('loading');
    const reading = {
      snapshot: snapshot(),
      html: null,
      metadata: null,
      headings: [
        {
          level: 1 as const,
          label: 'Same',
          id: 'reader-d0-r0-heading-1',
          key: 1,
        },
      ],
    };
    controller.previewFromReading(1, reading);
    held.resolve(snapshot());
    await pending;
    const preview = controller.state.previews.get(1);
    expect(preview?.phase).toBe('ready');
    expect(preview?.headings.map((heading) => heading.label)).toEqual(['Same']);
    expect(preview?.snapshot).toBe(reading.snapshot);
    // The superseded native read and its parse never publish.
    expect(parse).not.toHaveBeenCalled();
    expect(bridge.preview).toHaveBeenCalledTimes(1);
    expect(bridge.cancelPreview).toHaveBeenCalledTimes(1);
    // Invalidation still clears the adopted preview.
    controller.invalidate();
    expect(controller.state.previews.size).toBe(0);
    // Adoption without pending work keeps the native bridge untouched.
    controller.previewFromReading(2, reading);
    expect(bridge.cancelPreview).toHaveBeenCalledTimes(1);
    expect(controller.state.previews.get(2)?.snapshot).toBe(reading.snapshot);
    controller.dispose();
  });
  it('count-only loading progress keeps the retained index and preview identity stable', async () => {
    const { controller, bridge } = setup();
    await adoptRoot(bridge, controller, cache(index(2)));
    const root = controller.state.root;
    if (!root) throw new Error('Expected selected root');
    const previews = controller.state.previews;
    const loading: IndexSnapshot = {
      index: root,
      status: {
        sequence: 99,
        scope: root.scope,
        revision: root.revision,
        phase: 'loading',
        degraded: false,
        message: '',
        scans: 2,
        traversals: 0,
        entries: root.entries.length + 7,
      },
    };
    bridge.get.mockResolvedValueOnce(loading);
    await controller.recover();
    // The explorer's inputs stay referentially stable while only the
    // admitted-entry count moved, so its retained tree does not re-render.
    expect(controller.state.root).toBe(root);
    expect(controller.state.previews).toBe(previews);
    expect(controller.state.rootBusy).toBe(true);
    expect(controller.state.rootMessage).toContain('Indexing folder…');
    expect(controller.state.rootMessage).toContain(
      String(root.entries.length + 7),
    );
    // A settled reply still replaces the tree inputs and the phase.
    const settled = cache({ ...index(2), name: 'fixture' }, 'ready');
    settled.status.sequence = 100;
    bridge.get.mockResolvedValueOnce(settled);
    await controller.recover();
    expect(controller.state.root).not.toBe(root);
    expect(controller.state.rootBusy).toBe(false);
    expect(controller.state.rootStatus).toBe('ready');
    expect(controller.state.rootMessage).toBe('Folder loaded.');
    controller.dispose();
  });
  it('cancels only collapsed owned work and ignores its late native response', async () => {
    const { controller, bridge, parse } = setup();
    await adoptRoot(bridge, controller, cache(index(2)));
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
    await adoptRoot(bridge, controller, cache(index(2)));
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
    await adoptRoot(
      bridge,
      controller,
      cache({ ...index(), scope: 10, revision: 2 }, 'ready'),
    );
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
  it('labels an unpublished working folder as indexing instead of excluded, and exposes the retained index meanwhile', async () => {
    const { controller, bridge } = setup();
    const doc = { snapshot: snapshot(), html: '', metadata: null };
    await adoptRoot(bridge, controller, cache(index(), 'loading'));
    expect(controller.state.rootBusy).toBe(true);
    bridge.siblings.mockResolvedValue({
      index: index(),
      active: null,
      inRoot: true,
      rootActive: null,
    });
    await controller.update(doc);
    expect(controller.state.siblingMessage).toBe('Indexing folder…');
    // Once the scan settles the same reply is a truthful exclusion.
    await adoptRoot(bridge, controller, cache(index(2)));
    await controller.update(doc);
    expect(controller.state.siblingMessage).toBe(
      'Displayed file is not a visible sibling; no neighbor is selected.',
    );
    controller.dispose();
  });
  it('derives the Quick Open scope from the working folder status alone', async () => {
    const { controller, bridge } = setup();
    expect(quickOpenScope(controller.state)).toEqual({
      index: null,
      busy: false,
    });
    await adoptRoot(bridge, controller, cache(index(), 'loading'));
    expect(quickOpenScope(controller.state)).toEqual({
      index: controller.state.root,
      busy: true,
    });
    await adoptRoot(bridge, controller, cache(index(2)));
    const ready = quickOpenScope(controller.state);
    expect(ready.busy).toBe(false);
    expect(ready.index?.revision).toBe(2);
    await adoptRoot(
      bridge,
      controller,
      cache(index(3), 'unavailable', 'Folder removed'),
    );
    expect(quickOpenScope(controller.state).busy).toBe(true);
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
