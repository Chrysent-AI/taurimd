import type { Resource, ReadingAction } from './resources';
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import hljs from 'highlight.js/lib/common';
import { frontmatter, type Metadata } from './frontmatter';

export interface Note {
  label: string;
  key: string;
  number: number;
  occurrences: number;
}
export interface DiagramDefinition {
  slot: string;
  source: string;
}
export interface ParsedMarkdown {
  html: string;
  metadata: Metadata;
  prefix: string;
  notes: Note[];
  codeKeys: string[];
  diagrams: DiagramDefinition[];
}
export interface Heading {
  level: 1 | 2;
  label: string;
  id: string;
  key: number;
}
export interface Reading {
  headings?: Heading[];
  html: string;
  metadata: Metadata;
  resources?: Resource[];
  actions?: ReadingAction[];
  fragments?: Record<string, string>;
  diagrams?: DiagramDefinition[];
}
export function escapeCode(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function parseMarkdown(source: string): ParsedMarkdown {
  const { body, metadata } = frontmatter(source);
  // Unpredictable per-job markers distinguish generated markup from raw HTML.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const prefix = `mdr-${nonce}-`;
  const notes = new Map<string, Note>();
  const codeKeys: string[] = [];
  const diagrams: DiagramDefinition[] = [];
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use(
    markedFootnote({
      prefixId: prefix,
      backRefLabel: 'Back to reference',
      keepLabels: false,
      sectionClass: '',
      headingClass: '',
    }),
  );
  parser.use({
    walkTokens(token) {
      if (token.type !== 'footnote' && token.type !== 'footnoteRef') return;
      const label: unknown = token.label;
      if (typeof label !== 'string') throw new Error('Invalid footnote token');
      let note = notes.get(label);
      if (!note) {
        note = {
          label,
          key: `n${String(notes.size + 1)}`,
          number: 0,
          occurrences: 0,
        };
        notes.set(label, note);
      }
      if (token.type === 'footnoteRef') {
        const id: unknown = token.id;
        if (typeof id !== 'string' || !/^\d+$/.test(id))
          throw new Error('Invalid footnote reference');
        note.number = Number(id);
        note.occurrences += 1;
      }
      // The published plugin shares these token objects with its end section.
      // Synthetic labels keep its heading/definition/reference roles disjoint.
      token.label = note.key;
    },
    renderer: {
      code({ text, lang, codeBlockStyle }) {
        let code = escapeCode(text);
        const language = lang?.trim().split(/\s+/)[0]?.toLowerCase();
        if (language && language !== 'mermaid' && hljs.getLanguage(language)) {
          try {
            code = hljs.highlight(text, {
              language,
              ignoreIllegals: true,
            }).value;
          } catch {
            // Highlight failure never changes the literal code content.
          }
        } else if (!language && codeBlockStyle !== 'indented') {
          // Unlabelled fences are detected with the bundled common languages.
          try {
            code = hljs.highlightAuto(text).value;
          } catch {
            // Highlight failure never changes the literal code content.
          }
        }
        const key = `${prefix}code-${String(codeKeys.length + 1)}`;
        codeKeys.push(key);
        if (language === 'mermaid') diagrams.push({ slot: key, source: text });
        return `<pre data-reader-code="${key}"><code>${code}</code></pre>\n`;
      },
    },
  });
  return {
    html: parser.parse(body, { async: false }),
    metadata,
    prefix,
    notes: [...notes.values()].filter((note) => note.occurrences > 0),
    codeKeys,
    diagrams,
  };
}
