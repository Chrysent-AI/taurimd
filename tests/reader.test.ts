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
