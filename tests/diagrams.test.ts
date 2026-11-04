import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
import { isParsedMarkdown } from '../src/reader/protocol';
import { checkedGeometry, trustedConfig } from '../src/diagrams/engine';

describe('generated Mermaid associations through the production worker boundary', () => {
  it('retains ordered distinct fences, not author class/data lookalikes', () => {
    const source = 'flowchart LR\n A-->B';
    const parsed = parseMarkdown(
      `<pre class="mermaid" data-reader-diagram="1"><code>flowchart LR\n X-->Y</code></pre>\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n\`\`\`MERMAID\n${source}\n\`\`\``,
    );
    expect(isParsedMarkdown(structuredClone(parsed))).toBe(true);
    const reading = sanitizeReading(parsed);
    expect(reading.diagrams).toEqual([
      { slot: '1', source },
      { slot: '2', source },
    ]);
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    expect(host.querySelectorAll('[data-reader-diagram]')).toHaveLength(2);
    expect(host.querySelector('.mermaid')).toBeNull();
    expect(
      isParsedMarkdown({
        ...parsed,
        diagrams: [...parsed.diagrams, parsed.diagrams[0]],
      }),
    ).toBe(false);
    expect(
      isParsedMarkdown({ ...parsed, diagrams: [{ slot: 'author', source }] }),
    ).toBe(false);
    expect(
      isParsedMarkdown({
        ...parsed,
        diagrams: [{ slot: parsed.codeKeys[0], source: 2 }],
      }),
    ).toBe(false);
    const tampered = {
      ...parsed,
      html: parsed.html.replace('A--&gt;B', 'changed'),
    };
    expect(sanitizeReading(tampered).diagrams).toHaveLength(1);
    const duplicate = { ...parsed, html: parsed.html + parsed.html };
    expect(sanitizeReading(duplicate).diagrams).toEqual([]);
  });
  it('keeps distinct diagram associations unique across one thousand blocks', () => {
    const fence = '```mermaid\ngraph LR\n A-->B\n```';
    const parsed = parseMarkdown(
      Array.from({ length: 1000 }, () => fence).join('\n\n'),
    );
    expect(parsed.diagrams).toHaveLength(1000);
    const reading = sanitizeReading(parsed, 'd1-r1');
    expect(reading.diagrams?.length).toBe(1000);
    expect(
      new Set((reading.diagrams ?? []).map((diagram) => diagram.slot)).size,
    ).toBe(1000);
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    expect(host.querySelectorAll('[data-reader-diagram]')).toHaveLength(1000);
    // The single-collection-pass wall-clock pin at four thousand blocks
    // lives in tests/browser/document-shapes.spec.ts, where the production
    // functions run in a real engine instead of jsdom's DOM.
  });
  it('checks finite viewBox extents without treating 100% width as intrinsic geometry', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', '-50 -20 300 200');
    expect(checkedGeometry(svg)).toEqual({
      width: 300,
      height: 200,
      viewBox: [-50, -20, 300, 200],
    });
    for (const value of [
      '0 0 0 10',
      '0 0 NaN 2',
      '0 0 Infinity 2',
      '0 0 10',
      '0 0 -2 10',
    ]) {
      svg.setAttribute('viewBox', value);
      expect(() => checkedGeometry(svg)).toThrow('finite positive');
    }
  });
  it('uses trusted strict configuration and recursive secure names', () => {
    const config = trustedConfig({
      page: '#ffffff',
      text: '#111111',
      panel: '#eeeeee',
      border: '#888888',
    });
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      journey: { textPlacement: 'tspan' },
      themeCSS: 'text.journey-section, text.task { fill: #111111; }',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
    });
    expect(config.secure).toEqual(
      expect.arrayContaining([
        'securityLevel',
        'htmlLabels',
        'textPlacement',
        'themeVariables',
        'themeCSS',
        'fontFamily',
        'maxEdges',
        'dompurifyConfig',
      ]),
    );
    expect(config.secure?.some((key) => key.includes('.'))).toBe(false);
    expect(trustedConfig({ text: '#eceff4' }).themeCSS).toBe(
      'text.journey-section, text.task { fill: #eceff4; }',
    );
  });
});
