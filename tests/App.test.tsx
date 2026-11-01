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
const events = vi.hoisted(() => ({
  receive: (_event: { payload: string }) => {
    void _event;
  },
  fail: false,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_: string, receive: (event: { payload: string }) => void) => {
    events.receive = receive;
    return events.fail
      ? Promise.reject(new Error('unavailable'))
      : Promise.resolve(() => {});
  },
}));
vi.mock('../src/native', () => ({
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
      Promise.resolve({
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
});
Element.prototype.scrollIntoView = vi.fn();
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
async function menu(payload: string) {
  await act(async () => {
    events.receive({ payload });
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
