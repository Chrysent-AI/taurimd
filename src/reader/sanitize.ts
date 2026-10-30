import createDOMPurify from 'dompurify';
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
  'details',
  'summary',
  'sup',
  'sub',
  'kbd',
];
export function sanitizeReading(html: string): string {
  // No document URL, CSS, ID or app-action attribute survives this boundary.
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
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  });
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
  for (const link of fragment.querySelectorAll('a')) {
    link.append(document.createTextNode(' [link inactive]'));
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
