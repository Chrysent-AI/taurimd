import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
describe('production Markdown and sanitizer boundary', () => {
  it('keeps readable GFM and disabled read-only tasks', () => {
    const safe = sanitizeReading(
      parseMarkdown(
        '# Local reader\n\n| Key | Value |\n| :--- | :---: |\n| A | B |\n\n- [x] Done\n\n```js\nconst local = true;\n```',
      ),
    );
    const host = document.createElement('div');
    host.innerHTML = safe.html;
    expect(host.querySelector('h1')?.textContent).toBe('Local reader');
    expect(host.querySelector('td')?.textContent).toBe('A');
    expect(host.querySelector('input')?.disabled).toBe(true);
    expect(host.querySelector('code')?.textContent).toContain('const local');
    // GFM column alignment reaches the article as the legacy align
    // attribute with marked's exact emitted values.
    const heads = host.querySelectorAll('th');
    expect(heads[0].getAttribute('align')).toBe('left');
    expect(heads[1].getAttribute('align')).toBe('center');
  });
  it('removes active markup, document URLs/CSS/IDs and bridge lookalikes', () => {
    const hostile = `<script>window.__TAURI_INTERNALS__.invoke('select_document')</script>
      <iframe src="https://invalid.example/frame"></iframe><object data="file:///blocked"></object>
      <form action="https://invalid.example"><button>send</button></form>
      <meta http-equiv="refresh" content="0;url=https://invalid.example">
      <style>@import 'https://invalid.example/style';</style>
      <img src="https://invalid.example/image" srcset="file:///blocked 2x" onerror="alert(1)" align="middle" alt="Remote figure">
      <video poster="https://invalid.example/poster"><source src="file:///blocked"></video>
      <svg><a xlink:href="javascript:alert(1)">bad</a></svg>
      <p id="root" data-action="open" style="background:url(https://invalid.example/css)" onclick="alert(1)" align="center">safe text</p>
      <p align="javascript:alert(1)">hostile alignment value</p>

      | Centered | Right |
      | :---: | ---: |
      | a | b |

      <a href="javascript:alert(1)">unsafe</a><a href="file:///blocked">file</a>
      <input type="text" value="not a task">`;
    const safe = sanitizeReading(parseMarkdown(hostile.replace(/^ {6}/gm, '')));
    const host = document.createElement('div');
    host.innerHTML = safe.html;
    expect(
      host.querySelector(
        'script,iframe,object,form,button,meta,style,source,svg,input',
      ),
    ).toBeNull();
    expect(
      host.querySelector(
        '[src],[srcset],a[href]:not([href="#"]),[style],[id],[data-action],[onclick],[onerror]',
      ),
    ).toBeNull();
    expect(host.textContent).toContain('safe text');
    expect(host.textContent).toContain('Blocked srcset');
    expect(host.textContent).toContain('Blocked video poster');
    // Legacy align survives on raw HTML and marked-emitted table cells,
    // while every dangerous attribute on the same elements still fails —
    // including a URI-shaped align value, which DOMPurify drops.
    expect(host.querySelector('p[align="center"]')?.textContent).toBe(
      'safe text',
    );
    expect(host.querySelector('img[align="middle"]')).not.toBeNull();
    expect(host.querySelector('p[align="javascript:alert(1)"]')).toBeNull();
    const heads = host.querySelectorAll('th');
    expect(heads[0].getAttribute('align')).toBe('center');
    expect(host.querySelector('td[align="right"]')).not.toBeNull();
    expect(
      host.querySelector('[style],[id],[data-action],[onclick],[onerror]'),
    ).toBeNull();
    expect(
      safe.resources?.every((resource) => resource.sources.length === 0),
    ).toBe(true);
    // An HTTPS image is not a local source and never reaches the document
    // as an attribute. It stays a candidate whose host the native owner
    // authorizes before any request is made.
    const image = safe.resources?.find((resource) => resource.kind === 'img');
    expect(image?.remote).toBe('https://invalid.example/image');
    expect(image?.warnings).toEqual([
      'Blocked srcset — use a scoped local image source.',
    ]);
    expect(host.querySelector('img[src], img[srcset]')).toBeNull();
    expect(safe.actions?.map((action) => action.href)).toEqual([
      'javascript:alert(1)',
      'file:///blocked',
    ]);
  });
});
describe('duplicate-heading slug allocation', () => {
  it('keeps one thousand identical headings unique with the stable first-collision suffix order', () => {
    const count = 1000;
    const parsed = parseMarkdown(
      Array.from({ length: count }, () => '## Repeat').join('\n\n'),
    );
    const reading = sanitizeReading(parsed, 'd2-r2');
    const headings = reading.headings ?? [];
    expect(headings).toHaveLength(count);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(count);
    expect(headings.map((heading) => heading.key)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    const fragmentKeys = Object.keys(reading.fragments ?? {}).filter((key) =>
      key.startsWith('repeat'),
    );
    expect(fragmentKeys).toHaveLength(count);
    expect(fragmentKeys[0]).toBe('repeat');
    expect(fragmentKeys[1]).toBe('repeat-2');
    expect(fragmentKeys[2]).toBe('repeat-3');
    expect(fragmentKeys.at(-1)).toBe(`repeat-${String(count)}`);
    // The wall-clock pin for the per-base counter at eight thousand
    // headings lives in tests/browser/document-shapes.spec.ts, where the
    // production functions run in a real engine instead of jsdom's DOM.
  });
  it('keeps explicit heading-text collisions on the same stable suffix order', () => {
    const reading = sanitizeReading(
      parseMarkdown('## A\n\n## A\n\n## A-2\n\n## A\n\n## A-2'),
      'd3-r3',
    );
    const fragments = Object.keys(reading.fragments ?? {}).filter((key) =>
      key.startsWith('a'),
    );
    expect(fragments).toEqual(['a', 'a-2', 'a-2-2', 'a-3', 'a-2-3']);
    const ids = reading.fragments ?? {};
    const headingIds = (reading.headings ?? []).map((heading) => heading.id);
    expect(headingIds).toHaveLength(5);
    expect(new Set(headingIds).size).toBe(5);
    for (const key of fragments) expect(headingIds).toContain(ids[key]);
  });
  it('projects H1/H2 from the single sanitized H1-H6 allocation with unique destinations and no metadata/code/footnote/SVG headings', () => {
    const source =
      '---\noutline: "# Not a heading"\n---\n# Repeat\n### Between\n## Repeat\n# Repeat\n# Δοκιμή 日本語\n\n```md\n# Code\n```\n\n<pre><h2>Raw pre</h2></pre>\n\n<div><code><h2>Raw code</h2></code></div>\n\n<h2 id="author-id">Custom</h2>\n\nA note[^a].\n\n[^a]: Definition';
    const parsed = parseMarkdown(source);
    const current = sanitizeReading(parsed, 'd1-r1');
    const second = sanitizeReading(parsed, 'reading-d1-r1-again');
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
      second.headings?.map((h) => h.key),
    );
    expect(new Set(headings.map((h) => h.id)).size).toBe(headings.length);
    expect(headings.map((h) => h.id)).not.toEqual(
      second.headings?.map((h) => h.id),
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
});
