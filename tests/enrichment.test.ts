import { describe, expect, it, vi } from 'vitest';
import hljs from 'highlight.js/lib/common';
import { frontmatter } from '../src/reader/frontmatter';
import { parseMarkdown } from '../src/reader/parse';
import { sanitizeReading } from '../src/reader/sanitize';
import { isParsedMarkdown } from '../src/reader/protocol';
function host(source: string, context = 'd12-r3') {
  const parsed = parseMarkdown(source);
  expect(isParsedMarkdown(structuredClone(parsed))).toBe(true);
  const reading = sanitizeReading(parsed, context);
  const node = document.createElement('div');
  node.innerHTML = reading.html;
  return { node, reading, parsed };
}
describe('frontmatter production split and bounded presentation', () => {
  it.each([
    ['false', 'false'],
    ['0', '0'],
    ['null', 'null'],
    ['~', 'null'],
    ['""', '""'],
    ['2026-10-30', '2026-10-30T00:00:00.000Z'],
    ['!!binary SGk=', 'Binary (hex): 48 69'],
  ])('preserves meaningful scalar %s', (yaml, text) => {
    expect(
      frontmatter(`\uFEFF---\r\n${yaml}\r\n---\r\n# Body sentinel`).metadata,
    ).toEqual({ kind: 'value', value: { kind: 'scalar', text } });
  });
  it.each(['', '# comment\n', '[]', '{}'])(
    'omits only empty metadata %s',
    (yaml) => {
      const result = frontmatter(`---\n${yaml}\n---\nBody sentinel`);
      expect(result.metadata).toBeNull();
      expect(result.body).toBe('Body sentinel');
    },
  );
  it('keeps lists, nested mappings, hostile text and prototype-shaped keys as data', () => {
    const source =
      '---\n__proto__: hostile\n"<img src=x>": "<script>evil</script>"\nlist:\n  - 0\n  - false\n  - nested: null\n---\n# Body sentinel';
    const result = frontmatter(source);
    expect(result.body).toBe('# Body sentinel');
    expect(JSON.stringify(result.metadata)).toContain('<script>evil</script>');
    expect(result.metadata?.kind).toBe('value');
    expect(Object.prototype).not.toHaveProperty('hostile');
    expect(frontmatter('---\n- 0\n- false\n---\nBody').metadata?.kind).toBe(
      'value',
    );
  });
  it.each([
    ['malformed', 'title: [broken', true],
    ['tag', '!!js/function function() {}', true],
    ['cycle', 'root: &root [*root]', false],
    ['alias', 'a: &a {x: 1}\nb: *a', false],
    ['deep', `${'['.repeat(20)}0${']'.repeat(20)}`, false],
    ['parser limit', `${'['.repeat(110)}0${']'.repeat(110)}`, true],
    ['long', `title: ${'word '.repeat(4000)}`, false],
    ['binary', `!!binary ${'SGk='.repeat(5000)}`, false],
  ])(
    '%s retains complete raw YAML and independent body',
    (_name, yaml, malformed) => {
      const result = frontmatter(
        `\uFEFF---\r\n${yaml}\r\n---\r\n# Body sentinel`,
      );
      expect(result.body).toBe('# Body sentinel');
      expect(result.metadata).toMatchObject({
        kind: 'fallback',
        raw: `${yaml}\r\n`,
        malformed,
      });
    },
  );
  it('does not consume unmatched delimiters, ordinary thematic breaks or nonleading YAML', () => {
    for (const source of [
      '---\nnot closed\n# Body',
      'Body\n---\nx: 1\n---',
      '---\n\n# Body',
    ]) {
      expect(frontmatter(source)).toEqual({ body: source, metadata: null });
    }
  });
});
describe('real bundled Marked/footnote/highlight/sanitizer integration', () => {
  it('highlights real common languages and escapes unknown and Mermaid fences exactly', () => {
    const literal = '<img src="x" onerror="evil()"> & <script>evil()</script>';
    const { node } = host(
      `\`\`\`typescript\nconst count: number = 42; // readable\n\`\`\`\n\n\`\`\`unknown-language\n${literal}\n\`\`\`\n\n\`\`\`mermaid\n${literal}\n\`\`\``,
    );
    expect(node.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(node.querySelector('.hljs-number')?.textContent).toBe('42');
    const codes = node.querySelectorAll('code');
    expect(codes[1].textContent).toBe(literal);
    expect(codes[2].textContent).toBe(literal);
    expect(node.querySelector('img,script')).toBeNull();
  });
  it('escapes exactly when the real highlighter throws', () => {
    const highlight = vi.spyOn(hljs, 'highlight').mockImplementationOnce(() => {
      throw new Error('highlight unavailable');
    });
    try {
      const { node } = host('```js\n<script> & "literal"\n```');
      expect(node.querySelector('code')?.textContent).toBe(
        '<script> & "literal"',
      );
      expect(node.querySelector('script,span')).toBeNull();
    } finally {
      highlight.mockRestore();
    }
  });
  it('isolates hostile and colliding labels, repeated references and every return occurrence', () => {
    const labels = [
      'label',
      'ref-x',
      'x',
      'n1',
      'n2',
      '日本語',
      'x" onclick="evil()',
      '<img src=x>',
    ];
    const source = `${labels.map((label) => `See [^${label}] and [^${label}].`).join('\n\n')}\n\n${labels.map((label) => `[^${label}]: Definition for ${label}`).join('\n\n')}`;
    const { node, parsed } = host(source);
    expect(parsed.notes).toHaveLength(labels.length);
    expect(node.querySelectorAll('sup > a[id]')).toHaveLength(
      labels.length * 2,
    );
    const ids = [...node.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('reader-d12-r3-'))).toBe(true);
    for (const link of node.querySelectorAll('a[href]')) {
      const destination = link.getAttribute('href')?.slice(1);
      expect(
        [...node.querySelectorAll('[id]')].some(
          (element) => element.id === destination,
        ),
      ).toBe(true);
    }
    expect(
      node
        .querySelector('a[aria-label="Back to reference 1, occurrence 2"]')
        ?.getAttribute('href'),
    ).toBe(
      `#${node.querySelector('a[aria-label="Footnote 1, occurrence 2"]')?.id ?? 'missing'}`,
    );
    expect(node.querySelector('[onclick],img[src]')).toBeNull();
  });
  it('generates collision-free heading fragments, Unicode and raw-ID mapping without clobbering', () => {
    const { node } = host(
      '# Repeat\n\n# Repeat\n\n# Repeat-2\n\n# 日本語\n\n<h2 id="root">Raw</h2>\n\n[one](#repeat) [two](#repeat-2) [three](#repeat-2-2) [Unicode](#%E6%97%A5%E6%9C%AC%E8%AA%9E) [raw](#root) [missing](#outside)\n\n<p id="outside" class="hljs-keyword" data-reader-slot="0" data-action="open">Text</p>',
    );
    const headings = [...node.querySelectorAll('h1,h2')];
    const links = [...node.querySelectorAll('a')];
    for (let index = 0; index < 5; index++)
      expect(links[index]?.getAttribute('href')).toBe(
        `#${headings[index]?.id}`,
      );
    expect(
      node.querySelector(
        '#root,#outside,[data-action],[data-reader-slot],p[class]',
      ),
    ).toBeNull();
    expect(links[5]?.getAttribute('href')).toContain('missing-');
  });
  it('scopes destinations per document/revision and fresh extension state', () => {
    const source = '# Title\n\nNote[^label].\n\n[^label]: Definition';
    const a = host(source, 'd1-r1');
    const b = host(source, 'd1-r2');
    const sameRevision = host(source, 'd1-r1');
    expect(sameRevision.node.querySelector('h1')?.id).toBe(
      a.node.querySelector('h1')?.id,
    );
    expect(sameRevision.node.querySelector('a')?.id).toBe(
      a.node.querySelector('a')?.id,
    );
    const c = host('# Empty', 'd2-r1');
    expect(a.node.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Footnote 1, occurrence 1',
    );
    expect(b.node.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Footnote 1, occurrence 1',
    );
    expect(c.parsed.notes).toEqual([]);
    expect(a.node.querySelector('h1')?.id).not.toBe(
      b.node.querySelector('h1')?.id,
    );
  });
  it('removes author syntax classes even inside raw code, plus URLs and forged actions', () => {
    const { node, reading } = host(
      '<pre data-reader-code="forged"><code><span class="hljs-keyword">fake</span></code></pre>\n\n<a href="https://invalid.example" id="reader" data-action="open">Link</a>',
    );
    expect(
      node.querySelector(
        '[class],[id],a[href]:not([href="#"]),[data-action],[data-reader-code]',
      ),
    ).toBeNull();
    expect(reading.actions).toEqual([
      { slot: '0', href: 'https://invalid.example' },
    ]);
  });
});
