import { expect, it } from 'vitest';
import source from '../src/guide.md?raw';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';

it('the authored bundled guide uses the production parser/sanitizer with only dialog-scoped text, code and section links', () => {
  const reading = sanitizeReading(parseMarkdown(source), 'guide');
  expect(reading.metadata).toBeNull();
  expect(reading.resources).toEqual([]);
  expect(reading.actions).toEqual([]);
  const host = document.createElement('div');
  host.innerHTML = reading.html;
  expect(host.querySelectorAll('pre code').length).toBeGreaterThan(0);
  expect(
    host.querySelector('img,audio,video,source,input,style,script,[style]'),
  ).toBeNull();
  const ids = new Set(
    [...host.querySelectorAll('[id]')].map((node) => node.id),
  );
  expect([...ids].every((id) => id.startsWith('reader-guide-'))).toBe(true);
  for (const link of host.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('#reader-guide-')).toBe(true);
    expect(ids.has(href.slice(1))).toBe(true);
  }
  expect(reading.html).not.toContain('reader-d0-r0-');
});
