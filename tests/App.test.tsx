import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ReaderController } from '../src/controller';
import type { Snapshot } from '../src/types';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
import { defaults } from '../src/settings/model';
import type { FileEntry, Siblings } from '../src/navigation/types';
const events = vi.hoisted(() => {
  let siblingsReply: unknown = null;
  return {
    receive: (_event: { payload: { actionId: string; sequence: number } }) => {
      void _event;
    },
    fail: false,
    setSiblings(reply: unknown) {
      siblingsReply = reply;
    },
    siblings: (): unknown => siblingsReply,
  };
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    listen: (
      name: string,
      receive: (event: {
        payload: { actionId: string; sequence: number };
      }) => void,
    ) => {
      if (name === 'menu_action') events.receive = receive;
      return events.fail && name === 'menu_action'
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve(() => {});
    },
  }),
}));
vi.mock('../src/native', () => ({
  documentRequests: {
    pending: () => Promise.resolve(null),
    receive: vi.fn(),
    dismiss: vi.fn(),
  },
  navigation: {
    get: () =>
      Promise.resolve({
        index: null,
        status: {
          scope: 0,
          revision: 0,
          sequence: 0,
          phase: '',
          degraded: false,
          message: '',
          scans: 0,
          traversals: 0,
          entries: 0,
        },
      }),
    listen: () => Promise.resolve(() => {}),
    query: vi.fn(),
    complete: vi.fn(),
    siblings: () =>
      Promise.resolve(
        (events.siblings() as Siblings | null) ?? {
          index: {
            scope: 1,
            revision: 1,
            name: 'fixture',
            entries: [],
            issues: [],
          },
          active: null,
          rootActive: null,
          inRoot: false,
        },
      ),
    quickScope: () =>
      Promise.resolve({
        scope: 2,
        revision: 1,
        name: 'fixture',
        entries: [],
        issues: [],
      }),
    choose: () => Promise.resolve({ status: 'cancelled' }),
    refresh: vi.fn(),
    preview: vi.fn(),
    cancelPreview: () => Promise.resolve(null),
    reveal: () => Promise.resolve(null),
  },
  preferences: {
    get: () =>
      Promise.resolve({
        version: 1,
        revision: 0,
        settings: defaults,
        notice: null,
      }),
    listen: () => Promise.resolve(() => {}),
    update: (_: number, patch: object) =>
      Promise.resolve({
        status: 'committed',
        record: {
          version: 1,
          revision: 1,
          settings: { ...defaults, ...patch },
          notice: null,
        },
      }),
  },
}));
vi.mock('../src/presentation', () => ({
  syncMenu: () => Promise.resolve(null),
}));
afterEach(() => {
  cleanup();
  events.fail = false;
  events.setSiblings(null);
});
Element.prototype.scrollIntoView = vi.fn();
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
let menuSequence = 0;
async function menu(payload: string) {
  await act(async () => {
    events.receive({
      payload: { actionId: payload, sequence: ++menuSequence },
    });
    await Promise.resolve();
  });
}
function reader(source: string, format: Snapshot['format'] = 'markdown') {
  const snapshot: Snapshot = {
    documentId: 1,
    revision: 1,
    name: format === 'text' ? 'literal.log' : 'metadata.md',
    location: 'fixture/document',
    format,
    source,
  };
  const bridge = {
    openEntry: vi
      .fn()
      .mockRejectedValue(new Error('No navigation selection queued')),
    select: vi.fn().mockResolvedValue({ status: 'ready', snapshot }),
    reload: vi.fn().mockRejectedValue({ message: 'File missing' }),
    commit: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn(),
    activate: vi.fn(),
  };
  const parse = vi.fn((source: string) => ({
    result: Promise.resolve(sanitizeReading(parseMarkdown(source))),
    cancel() {},
  }));
  const controller = new ReaderController(bridge, parse);
  render(<App controller={controller} />);
  return { controller, bridge, parse };
}
it('uses a quiet menu-first empty shell, literal article and last-good error recovery', async () => {
  const source = '# Literal\n<script>not executed</script>';
  const { parse } = reader(source, 'text');
  expect(screen.queryByRole('button', { name: 'Open File…' })).toBeNull();
  expect(screen.queryByText('Preferences saved.')).toBeNull();
  expect(screen.getByRole('main').textContent).toContain('File → Open File');
  await menu('reload');
  expect(screen.getByRole('status').textContent).toContain('unavailable');
  await menu('open');
  const article = await screen.findByRole('article', { name: 'literal.log' });
  expect(article.textContent).toBe(source);
  expect(article.querySelector('script')).toBeNull();
  expect(parse).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(article);
  await menu('status-bar');
  expect(screen.queryByLabelText('Displayed document')).toBeNull();
  await menu('reload');
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('Reload failed');
  });
  expect(article.textContent).toBe(source);
  expect(screen.getByRole('button', { name: 'Open File…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  await menu('status-bar');
  expect(screen.getByLabelText('Displayed document').textContent).toContain(
    'Stale',
  );
});
it.each([
  ['false', 'false'],
  ['0', '0'],
  ['null', 'null'],
  ['""', '""'],
  ['2026-10-30', '2026-10-30T00:00:00.000Z'],
  ['- first\n- 0\n- false', 'first'],
  ['"<img src=x>": "<script>literal</script>"', '<script>literal</script>'],
])(
  'actual App presents metadata %s as escaped text and independently renders the body',
  async (yaml, text) => {
    const { controller } = reader(
      `\uFEFF---\r\n${yaml}\r\n---\r\n# Body sentinel`,
    );
    await menu('open');
    const metadata = await screen.findByRole('region', {
      name: 'Document metadata',
    });
    expect(metadata.textContent).toContain(text);
    expect(metadata.querySelector('script,img,a,h1,h2')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Body sentinel' })).toBeTruthy();
    expect(controller.state.displayed?.snapshot.source).toContain(yaml);
  },
);
it.each(['[]', '{}', '# comment only'])(
  'actual App omits empty metadata %s',
  async (yaml) => {
    reader(`---\n${yaml}\n---\n# Body sentinel`);
    await menu('open');
    await screen.findByRole('heading', { name: 'Body sentinel' });
    expect(
      screen.queryByRole('region', { name: 'Document metadata' }),
    ).toBeNull();
  },
);
it.each([
  'broken: [unfinished',
  'cycle: &cycle [*cycle]',
  `${'['.repeat(20)}null${']'.repeat(20)}`,
])('actual App keeps complete raw fallback and body for %s', async (yaml) => {
  reader(`---\n${yaml}\n---\n# Body sentinel`);
  await menu('open');
  await screen.findByRole('heading', { name: 'Body sentinel' });
  const metadata = screen.getByRole('region', { name: 'Document metadata' });
  expect(metadata.querySelector('pre')?.textContent).toBe(`${yaml}\n`);
  expect(metadata.querySelector('details')).not.toBeNull();
});
it('menu subscription failure exposes exceptional direct actions instead of referring to removed controls', async () => {
  events.fail = true;
  reader('literal', 'text');
  await screen.findByText(
    'Menu commands unavailable. Use these recovery controls.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
  await screen.findByRole('article');
  expect(screen.getByRole('button', { name: 'Settings…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

function siblingEntry(id: number, name: string, alphaRank: number): FileEntry {
  return {
    id,
    uiId: id,
    parent: null,
    name,
    relative: name,
    kind: 'markdown',
    context: id,
    alphaRank,
    dateRank: 0,
    sizeRank: 0,
  };
}

// Window-level key presses as the keydown owner receives them; the event
// reference exposes defaultPrevented for ownership assertions.
async function pressKey(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

// The keydown owner reads navigator.platform; jsdom's own value is
// environment-dependent, so each scenario pins one explicitly.
async function withPlatform(platform: string, run: () => Promise<void>) {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    await run();
  } finally {
    delete (window.navigator as unknown as Record<string, unknown>).platform;
  }
}

it('app keys own Cmd/Ctrl+Arrow first/last navigation only with exact modifiers and never inside editable controls', async () => {
  const { bridge } = reader('# Body\n\nSentinel paragraph.');
  await menu('open');
  await screen.findByRole('article', { name: 'metadata.md' });
  // Non-macOS: Ctrl is the only primary modifier and excludes the rest.
  await withPlatform('Linux x86_64', async () => {
    expect((await pressKey({ key: 'ArrowUp' })).defaultPrevented).toBe(false);
    expect(
      (await pressKey({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }))
        .defaultPrevented,
    ).toBe(false);
    expect(
      (await pressKey({ key: 'ArrowDown', metaKey: true })).defaultPrevented,
    ).toBe(false);
    // Exact modifiers are consumed and routed through dispatch even when the
    // sibling projection has no target; the navigation refuses without one.
    expect(
      (await pressKey({ key: 'ArrowUp', ctrlKey: true })).defaultPrevented,
    ).toBe(true);
  });
  // macOS: Cmd is primary and Ctrl never matches.
  await withPlatform('MacIntel', async () => {
    expect(
      (await pressKey({ key: 'ArrowDown', ctrlKey: true })).defaultPrevented,
    ).toBe(false);
    expect(
      (await pressKey({ key: 'ArrowUp', metaKey: true })).defaultPrevented,
    ).toBe(true);
  });
  expect(bridge.openEntry).not.toHaveBeenCalled();
  // An editable control keeps the keys for text cursor movement.
  await menu('find');
  const input = await screen.findByRole('textbox', {
    name: 'Find in document',
  });
  expect(document.activeElement).toBe(input);
  await withPlatform('MacIntel', async () => {
    expect(
      (await pressKey({ key: 'ArrowDown', metaKey: true })).defaultPrevented,
    ).toBe(false);
  });
  expect(bridge.openEntry).not.toHaveBeenCalled();
});

it('Cmd/Ctrl+Arrow keys open the first and last sibling through the same dispatch path as the Navigate menu', async () => {
  events.setSiblings({
    index: {
      scope: 1,
      revision: 1,
      name: 'fixture',
      entries: [
        siblingEntry(10, 'alpha.md', 0),
        siblingEntry(20, 'beta.md', 1),
        siblingEntry(30, 'gamma.md', 2),
      ],
      issues: [],
    },
    active: 20,
    rootActive: null,
    inRoot: true,
  });
  const { bridge } = reader('# Body\n\nSentinel paragraph.');
  await menu('open');
  await screen.findByRole('article', { name: 'metadata.md' });
  bridge.openEntry.mockImplementation(
    (_request: number, binding: { entry: number }) => {
      const name = binding.entry === 10 ? 'alpha.md' : 'gamma.md';
      return Promise.resolve({
        documentId: binding.entry,
        revision: 1,
        name,
        location: `fixture/${name}`,
        format: 'markdown' as const,
        source: `# ${name}\n\nBody.`,
      } satisfies Snapshot);
    },
  );
  await withPlatform('MacIntel', async () => {
    expect(
      (await pressKey({ key: 'ArrowUp', metaKey: true })).defaultPrevented,
    ).toBe(true);
  });
  expect(await screen.findByRole('article', { name: 'alpha.md' })).toBeTruthy();
  await withPlatform('Linux x86_64', async () => {
    expect(
      (await pressKey({ key: 'ArrowDown', ctrlKey: true })).defaultPrevented,
    ).toBe(true);
  });
  expect(await screen.findByRole('article', { name: 'gamma.md' })).toBeTruthy();
  // One keypress, one navigation: no duplicated or wrapped outcomes.
  expect(bridge.openEntry).toHaveBeenCalledTimes(2);
});
