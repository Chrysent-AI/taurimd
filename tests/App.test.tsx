import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { App } from '../src/App';
import { ReaderController } from '../src/controller';
import type { Snapshot } from '../src/types';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));
afterEach(cleanup);
function markdownController(source: string) {
  const snapshot: Snapshot = {
    documentId: 1,
    revision: 1,
    name: 'metadata.md',
    location: 'fixture/metadata.md',
    format: 'markdown',
    source,
  };
  const bridge = {
    select: vi.fn().mockResolvedValue({ status: 'ready', snapshot }),
    reload: vi.fn().mockResolvedValue(snapshot),
    commit: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return new ReaderController(bridge, (source) => ({
    result: Promise.resolve(sanitizeReading(parseMarkdown(source))),
    cancel() {},
  }));
}

Element.prototype.scrollIntoView = vi.fn();
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
it('renders literal text through the actual article and preserves identity on errors', async () => {
  const snapshot: Snapshot = {
    documentId: 1,
    revision: 1,
    name: 'literal.log',
    location: 'fixture/literal.log',
    format: 'text',
    source: '# Literal\n<script>not executed</script>',
  };
  const bridge = {
    select: vi.fn().mockResolvedValue({ status: 'ready', snapshot }),
    reload: vi.fn().mockRejectedValue({ message: 'File missing' }),
    commit: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const parser = vi.fn((source: string) => ({
    result: Promise.resolve(sanitizeReading(parseMarkdown(source))),
    cancel: () => {},
  }));
  render(<App controller={new ReaderController(bridge, parser)} />);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Reload' }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
  const article = await screen.findByRole('article', { name: 'literal.log' });
  expect(article.textContent).toBe(snapshot.source);
  expect(article.querySelector('script')).toBeNull();
  expect(parser).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(article);
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('Reload failed');
  });
  expect(article.textContent).toBe(snapshot.source);
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
    const controller = markdownController(
      `\uFEFF---\r\n${yaml}\r\n---\r\n# Body sentinel`,
    );
    render(<App controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
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
    render(
      <App
        controller={markdownController(`---\n${yaml}\n---\n# Body sentinel`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
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
  render(
    <App
      controller={markdownController(`---\n${yaml}\n---\n# Body sentinel`)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
  await screen.findByRole('heading', { name: 'Body sentinel' });
  const metadata = screen.getByRole('region', { name: 'Document metadata' });
  expect(metadata.querySelector('pre')?.textContent).toBe(`${yaml}\n`);
  expect(metadata.querySelector('details')).not.toBeNull();
});
