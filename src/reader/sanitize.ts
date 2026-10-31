import createDOMPurify from 'dompurify';
import type { ParsedMarkdown, Reading } from './parse';
const DOMPurify = createDOMPurify(window);
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (['img', 'audio', 'video', 'source', 'track'].includes(data.tagName)) {
    const label = node instanceof Element ? node.getAttribute('alt') : null;
    node.parentNode?.insertBefore(
      document.createTextNode(
        `[Blocked ${data.tagName}${label ? `: ${label}` : ''}]`,
      ),
      node,
    );
  }
});
const readingTags = [
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'em',
  'strong',
  'del',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'input',
  'span',
  'div',
  'section',
  'details',
  'summary',
  'sup',
  'sub',
  'kbd',
];
function slug(text: string) {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-') || 'section'
  );
}
export function sanitizeReading(
  parsed: ParsedMarkdown | string,
  context = 'd0-r0',
): Reading {
  const html = typeof parsed === 'string' ? parsed : parsed.html;
  const prefix = typeof parsed === 'string' ? '' : parsed.prefix;
  const namespace = `reader-${context}-`;
  // DOMPurify parses into its inert document first. Even an inert template in
  // the live document can cause a Chromium CSP diagnostic for raw style attrs.
  // IDs/classes/fragments here remain untrusted until reconstructed below.
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: readingTags,
    ALLOWED_ATTR: [
      'type',
      'checked',
      'disabled',
      'colspan',
      'rowspan',
      'scope',
      'start',
      'open',
      'id',
      'class',
      'href',
      'data-reader-code',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  });
  const originalId = (node: Element) => node.id.replace(/^user-content-/, '');
  const findGenerated = (id: string) =>
    fragment.getElementById(`user-content-${id}`);
  const attributes = new Map<Element, Record<string, string>>();
  const fragments = new Map<string, string>();
  const links = new Map<Element, string>();
  function assign(node: Element, attrs: Record<string, string>) {
    attributes.set(node, { ...attributes.get(node), ...attrs });
  }
  const notes = typeof parsed === 'string' ? [] : parsed.notes;
  for (const note of notes) {
    const definition = findGenerated(`${prefix}${note.key}`);
    if (!definition || definition.tagName !== 'LI') continue;
    const id = `${namespace}note-${String(note.number)}`;
    assign(definition, { id, tabindex: '-1' });
    fragments.set(`footnote-${note.label}`, id);
    for (let occurrence = 0; occurrence < note.occurrences; occurrence++) {
      const suffix = occurrence ? `-${String(occurrence + 1)}` : '';
      const refId = `${prefix}ref-${note.key}${suffix}`;
      const reference = findGenerated(refId);
      const destination = `${namespace}ref-${String(note.number)}-${String(occurrence + 1)}`;
      if (reference?.tagName === 'A')
        assign(reference, {
          id: destination,
          href: `#${id}`,
          'aria-label': `Footnote ${String(note.number)}, occurrence ${String(occurrence + 1)}`,
        });
      for (const backlink of definition.querySelectorAll('a')) {
        if (backlink.getAttribute('href') === `#${refId}`)
          assign(backlink, {
            href: `#${destination}`,
            'aria-label': `Back to reference ${String(note.number)}, occurrence ${String(occurrence + 1)}`,
          });
      }
    }
  }
  const usedSlugs = new Set<string>();
  let headingNumber = 0;
  for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (prefix && originalId(heading) === `${prefix}label`) {
      assign(heading, { id: `${namespace}notes-title`, tabindex: '-1' });
      continue;
    }
    const base = slug(heading.textContent);
    let key = base;
    let duplicate = 1;
    while (usedSlugs.has(key)) key = `${base}-${String(++duplicate)}`;
    usedSlugs.add(key);
    const id = `${namespace}heading-${String(++headingNumber)}`;
    assign(heading, { id, tabindex: '-1' });
    if (!fragments.has(key)) fragments.set(key, id);
    const rawId = originalId(heading);
    if (rawId && !fragments.has(rawId)) fragments.set(rawId, id);
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (href) links.set(link, href);
  }
  const codeKeys = new Set(typeof parsed === 'string' ? [] : parsed.codeKeys);
  for (const pre of fragment.querySelectorAll('pre[data-reader-code]')) {
    if (!codeKeys.has(pre.getAttribute('data-reader-code') ?? '')) continue;
    for (const span of pre.querySelectorAll('code span')) {
      const classes = [...span.classList].filter(
        (name) =>
          /^hljs-[a-z0-9_-]+$/.test(name) || /^[a-z][a-z0-9_-]*_$/.test(name),
      );
      if (classes.length) assign(span, { class: classes.join(' ') });
    }
  }
  let missing = 0;
  for (const [link, href] of links) {
    const attrs = attributes.get(link);
    if (attrs?.href) {
      assign(link, { tabindex: '0' });
      continue;
    }
    if (href.startsWith('#')) {
      let key = href.slice(1);
      try {
        key = decodeURIComponent(key);
      } catch {
        /* Unresolvable fragment stays local. */
      }
      const id =
        fragments.get(key) ?? `${namespace}missing-${String(++missing)}`;
      assign(link, { href: `#${id}`, tabindex: '0' });
    }
  }
  for (const node of fragment.querySelectorAll('*')) {
    // No author IDs/classes/URLs/action attributes reach the mounted article.
    for (const name of ['id', 'class', 'href', 'data-reader-code'])
      node.removeAttribute(name);
    const attrs = attributes.get(node);
    if (attrs)
      for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, value);
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') {
      input.remove();
      continue;
    }
    input.disabled = true;
    input.setAttribute(
      'aria-label',
      input.checked
        ? 'Completed task (read only)'
        : 'Incomplete task (read only)',
    );
  }
  for (const link of fragment.querySelectorAll('a:not([href])'))
    link.append(document.createTextNode(' [link inactive]'));
  const container = document.createElement('div');
  container.append(fragment);
  return {
    html: container.innerHTML,
    metadata: typeof parsed === 'string' ? null : parsed.metadata,
  };
}
