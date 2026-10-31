import createDOMPurify from 'dompurify';
import type { ParsedMarkdown, Reading } from './parse';
import { localResource, type Resource, type ReadingAction } from './resources';
const DOMPurify = createDOMPurify(window);
// The hook sees nodes only inside DOMPurify's inert document. No URL/style
// attribute survives to a connected node; associations are rebuilt from this map.
let captured: Map<Element, Partial<Record<string, string>>> | null = null;
let captionedPlayers: Set<Element> | null = null;
DOMPurify.addHook('uponSanitizeElement', (node) => {
  if (!(node instanceof Element)) return;
  captured?.set(
    node,
    Object.fromEntries(
      [...node.attributes].map((attr) => [attr.name, attr.value]),
    ),
  );
  if (node.tagName === 'TRACK') {
    const player = node.closest('audio,video');
    if (player) captionedPlayers?.add(player);
    else
      node.before(
        document.createTextNode(
          '[Caption track unavailable — this resource type is not supported.]',
        ),
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
  'img',
  'audio',
  'video',
  'source',
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
  const raw = new Map<Element, Partial<Record<string, string>>>();
  const captions = new Set<Element>();
  captured = raw;
  captionedPlayers = captions;
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(html, {
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
        'alt',
        'width',
        'height',
      ],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      SANITIZE_NAMED_PROPS: true,
      RETURN_DOM_FRAGMENT: true,
    });
  } finally {
    captured = null;
    captionedPlayers = null;
  }
  const resources: Resource[] = [];
  const actions: ReadingAction[] = [];
  for (const element of fragment.querySelectorAll('img,audio,video')) {
    const kind = element.tagName.toLowerCase() as Resource['kind'];
    const attrs = raw.get(element) ?? {};
    const sources = [
      attrs.src,
      ...[...element.querySelectorAll('source')].map(
        (source) => raw.get(source)?.src,
      ),
    ].filter((value): value is string => value !== undefined);
    const warnings: string[] = [];
    if (captions.has(element))
      warnings.push(
        'Caption track unavailable — this resource type is not supported.',
      );
    const permitted = sources.filter((reference) => {
      if (localResource(reference)) return true;
      warnings.push(
        `Blocked ${kind}: automatic remote or unsafe resource disabled (${reference || 'empty reference'}).`,
      );
      return false;
    });
    if (
      attrs.srcset ||
      [...element.querySelectorAll('source')].some(
        (source) => raw.get(source)?.srcset,
      )
    )
      warnings.push('Blocked srcset — use a scoped local image source.');
    let poster: string | undefined;
    if (attrs.poster) {
      if (localResource(attrs.poster)) poster = attrs.poster;
      else
        warnings.push(
          'Blocked video poster — automatic remote or unsafe resource disabled.',
        );
    }
    for (const source of element.querySelectorAll('source')) source.remove();
    const slot = String(resources.length);
    resources.push({ slot, kind, sources: permitted, poster, warnings });
    // These adapter-created attributes are never taken from author data attrs.
    element.setAttribute('data-reader-media', slot);
    if (kind === 'img' && attrs.alt === undefined)
      element.setAttribute(
        'alt',
        `Local image: ${sources[0] || 'unnamed resource'}`,
      );
    if (kind !== 'img')
      element.setAttribute(
        'aria-label',
        attrs.alt ||
          `${kind === 'audio' ? 'Audio' : 'Video'}: ${sources[0] || 'local resource'}`,
      );
    for (const dimension of ['width', 'height']) {
      const value = attrs[dimension];
      if (value && /^[1-9]\d{0,4}$/.test(value))
        element.setAttribute(dimension, value);
      else element.removeAttribute(dimension);
    }
    if (kind !== 'img') {
      element.setAttribute('controls', '');
      element.setAttribute('preload', 'metadata');
    }
    const feedback = document.createElement('span');
    feedback.className = 'media-feedback';
    feedback.setAttribute('data-reader-media-feedback', slot);
    feedback.textContent = [
      ...warnings,
      permitted.length
        ? `Loading local ${kind}…`
        : `${kind} unavailable — no permitted local source.`,
    ].join(' ');
    element.after(feedback);
  }
  for (const source of fragment.querySelectorAll('source')) {
    source.replaceWith(
      document.createTextNode(
        '[Blocked source — no supported containing player.]',
      ),
    );
  }
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
        if (raw.get(backlink)?.href === `#${refId}`)
          assign(backlink, {
            href: `#${destination}`,
            'aria-label': `Back to reference ${String(note.number)}, occurrence ${String(occurrence + 1)}`,
          });
      }
    }
  }
  const usedSlugs = new Set<string>();
  const headings: NonNullable<Reading['headings']> = [];
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
    if (
      (heading.tagName === 'H1' || heading.tagName === 'H2') &&
      !heading.closest('pre,code')
    )
      headings.push({
        level: heading.tagName === 'H1' ? 1 : 2,
        label: heading.textContent,
        id,
        key: headingNumber,
      });
    if (!fragments.has(key)) fragments.set(key, id);
    const rawId = originalId(heading);
    if (rawId && !fragments.has(rawId)) fragments.set(rawId, id);
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = raw.get(link)?.href;
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
  const diagrams: NonNullable<Reading['diagrams']> = [];
  if (typeof parsed !== 'string') {
    for (const definition of parsed.diagrams) {
      const candidates = [
        ...fragment.querySelectorAll('pre[data-reader-code]'),
      ].filter(
        (node) => node.getAttribute('data-reader-code') === definition.slot,
      );
      const pre = candidates[0];
      if (
        candidates.length !== 1 ||
        pre.children.length !== 1 ||
        pre.firstElementChild?.tagName !== 'CODE' ||
        pre.textContent !== definition.source
      )
        continue;
      const slot = String(diagrams.length + 1);
      diagrams.push({ slot, source: definition.source });
      assign(pre, { 'data-reader-diagram': slot });
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
    } else {
      const slot = String(actions.length);
      actions.push({ slot, href });
      assign(link, { href: '#', 'data-reader-link': slot, tabindex: '0' });
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
  for (const feedback of fragment.querySelectorAll(
    '[data-reader-media-feedback]',
  ))
    feedback.className = 'media-feedback';
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
    resources,
    actions,
    fragments: Object.fromEntries(fragments),
    diagrams,
    headings,
  };
}
