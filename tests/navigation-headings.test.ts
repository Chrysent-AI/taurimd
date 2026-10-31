import { expect, it, vi } from 'vitest';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
import { ReaderController } from '../src/controller';
import type { NativeReader, Snapshot } from '../src/types';
const source =
  '---\noutline: "# Not a heading"\n---\n# Repeat\n### Between\n## Repeat\n# Repeat\n# Δοκιμή 日本語\n\n```md\n# Code\n```\n\n<pre><h2>Raw pre</h2></pre>\n\n<div><code><h2>Raw code</h2></code></div>\n\n<h2 id="author-id">Custom</h2>\n\nA note[^a].\n\n[^a]: Definition';
it('projects H1/H2 from the single sanitized H1-H6 allocation with unique destinations and no metadata/code/footnote/SVG headings', () => {
  const parsed = parseMarkdown(source);
  const current = sanitizeReading(parsed, 'd1-r1');
  const preview = sanitizeReading(parsed, 'preview-7-9');
  const headings = current.headings ?? [];
  expect(headings.map((h) => h.label)).toEqual([
    'Repeat',
    'Repeat',
    'Repeat',
    'Δοκιμή 日本語',
    'Custom',
  ]);
  expect(headings.map((h) => h.key)).toEqual([1, 3, 4, 5, 8]);
  expect(headings.map((h) => h.key)).toEqual(
    preview.headings?.map((h) => h.key),
  );
  expect(new Set(headings.map((h) => h.id)).size).toBe(headings.length);
  expect(headings.map((h) => h.id)).not.toEqual(
    preview.headings?.map((h) => h.id),
  );
  const host = document.createElement('article');
  host.innerHTML = current.html;
  for (const heading of headings)
    expect(
      [...host.querySelectorAll('[id]')].filter(
        (node) => node.id === heading.id,
      ),
    ).toHaveLength(1);
  expect(current.fragments?.['author-id']).toBe(headings.at(-1)?.id);
  expect(
    headings.some((h) => h.label.includes('Code') || h.label.includes('Raw')),
  ).toBe(false);
});
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
      sanitizeReading(
        parseMarkdown(source),
        `d${String(snapshot.documentId)}-r${String(snapshot.revision)}`,
      ),
    ),
    cancel: vi.fn(),
  }));
  return { controller, bridge, snapshot };
}
it.each(['same', 'changed-source', 'changed-context'] as const)(
  'fulfills preview intents only for exact fresh context/source: %s',
  async (mode) => {
    const { controller, bridge, snapshot } = setup();
    await controller.run('open');
    const preview = {
      ...snapshot,
      documentId: 0,
      source: '# Repeat\n### Between\n## Repeat',
    };
    const fresh = {
      ...preview,
      documentId: 2,
      revision: 2,
      contextId: mode === 'changed-context' ? 11 : 10,
      source:
        mode === 'changed-source'
          ? '# Repeat\n### Between\n## Other'
          : preview.source,
    };
    bridge.openEntry.mockResolvedValueOnce(fresh);
    await controller.openEntry({
      binding: { scope: 7, revision: 1, entry: 9 },
      name: 'next.md',
      preview,
      focus: 'heading',
      key: 3,
    });
    expect(controller.state.displayed?.snapshot).toBe(fresh);
    expect(bridge.commit).toHaveBeenLastCalledWith(2);
    expect(controller.state.displayed?.headingKey).toBe(
      mode === 'same' ? 3 : undefined,
    );
    if (mode !== 'same')
      expect(controller.state.message).toBe(
        'File changed; choose a heading again.',
      );
  },
);
it('native commit rejection retains last-good content and reload invalidates previews even when the read fails', async () => {
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
  const epoch = controller.state.previewEpoch ?? 0;
  await controller.run('reload');
  expect(controller.state.previewEpoch).toBe(epoch + 1);
  expect(controller.state.displayed).toBe(old);
  expect(controller.state.message).toContain('Reload failed');
});
