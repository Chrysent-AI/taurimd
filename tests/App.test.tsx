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
Element.prototype.scrollIntoView = vi.fn();
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
