// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  buildCorpus,
  DocumentFind,
  literalMatches,
  type FindState,
} from '../src/reader/find';

// These layout-free tests exercise offset/ownership algorithms, not visibility.
// Browser tests use the default computed-style/Range visibility implementation.
const include = () => true;
let root: HTMLElement;
let owner: DocumentFind | undefined;
afterEach(() => {
  owner?.dispose();
  owner = undefined;
  root.remove();
  document.querySelector('.find-bar')?.remove();
  vi.restoreAllMocks();
});
function fixture(html: string) {
  root = document.createElement('article');
  root.innerHTML = html;
  document.body.append(root);
  for (const pre of root.querySelectorAll('pre')) pre.style.whiteSpace = 'pre';
  return root;
}
it('literal Unicode UTF16 offsets, punctuation and nonoverlap never use transformed haystack offsets', () => {
  fixture('<p>İ😀 a.b [x]*+\\ (abc) ABabc sſ KK</p>');
  const corpus = buildCorpus(root, include);
  for (const query of ['😀', 'a.b', '[x]*+\\', '(abc)', 'sſ', 'KK']) {
    const matches = literalMatches(corpus, query);
    expect(matches).toHaveLength(1);
    expect(
      matches[0].segments
        .map(({ text, from, to }) => text.data.slice(from, to))
        .join(''),
    ).toBe(query);
  }
  expect(literalMatches(corpus, 'ab')).toHaveLength(3);
  expect(literalMatches(corpus, 'ss')).toHaveLength(1);
  expect(literalMatches(corpus, 'kk')).toHaveLength(1);
  expect(literalMatches(corpus, '')).toEqual([]);
});
it('cross-inline runs map collapsed whitespace back to every original span, not unrelated structural blocks', () => {
  fixture(
    '<p>ab<strong>cd</strong><a>ef</a> \n <em>\t gh</em></p><p>ij</p><ul><li>kl</li><li>mn</li></ul><table><tbody><tr><td>op</td><td>qr</td></tr></tbody></table><p>st<br>uv</p><pre>a  b\nc</pre>',
  );
  const corpus = buildCorpus(root, include);
  expect(literalMatches(corpus, 'abcdef gh')).toHaveLength(1);
  const match = literalMatches(corpus, 'ef gh')[0];
  expect(
    match.segments
      .map(({ text, from, to }) => text.data.slice(from, to))
      .join(''),
  ).toBe('ef \n \t gh');
  for (const query of ['ghij', 'gh\nij', 'klmn', 'opqr', 'stuv', 'a b'])
    expect(literalMatches(corpus, query)).toHaveLength(0);
  expect(literalMatches(corpus, 'a  b\nc')).toHaveLength(1);
});
it.each([false, true])(
  'owned splits restore original adjacent Text identities, author marks and directional selection (backward=%s)',
  (backward) => {
    fixture('<p><a>ab<strong>cd</strong>ef</a><mark> author </mark></p>');
    const p = root.querySelector('p');
    if (!p) throw new Error('missing p');
    p.append(
      document.createTextNode(' adjacent'),
      document.createTextNode(' separate'),
    );
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const originals: Text[] = [];
    while (walker.nextNode()) originals.push(walker.currentNode as Text);
    const data = originals.map((node) => node.data);
    const link = root.querySelector('a');
    const author = root.querySelector('mark');
    const strong = root.querySelector('strong');
    const selection = window.getSelection();
    const start = originals[0];
    const end = originals[2];
    selection?.setBaseAndExtent(
      backward ? end : start,
      1,
      backward ? start : end,
      1,
    );
    const selected = selection?.toString();
    let state: FindState | undefined;
    Element.prototype.scrollIntoView = vi.fn();
    owner = new DocumentFind(
      root,
      (result) => {
        state = result;
      },
      include,
    );
    owner.search('bcde');
    expect(state).toMatchObject({ total: 1, current: 1, error: '' });
    expect(root.querySelectorAll('.find-match')).toHaveLength(3);
    expect(selection?.toString()).toBe(selected);
    owner.move(-1);
    expect(state?.current).toBe(1);
    owner.search('ab');
    expect(selection?.toString()).toBe(selected);
    owner.search('');
    expect(originals.map((node) => node.data)).toEqual(data);
    expect(originals.every((node) => root.contains(node))).toBe(true);
    expect(p.lastChild).toBe(originals.at(-1));
    expect(root.querySelector('a')).toBe(link);
    expect(root.querySelector('strong')).toBe(strong);
    expect(root.querySelector('mark')).toBe(author);
    expect(selection?.anchorNode).toBe(backward ? end : start);
    expect(selection?.focusNode).toBe(backward ? start : end);
    expect(selection?.anchorOffset).toBe(1);
    expect(selection?.focusOffset).toBe(1);
  },
);
it('external feedback replacement is rebuilt; obsolete nodes are never reinserted on dispose or queued invalidation', async () => {
  fixture('<p>old feedback</p>');
  owner = new DocumentFind(root, () => {}, include);
  owner.search('feedback');
  const p = root.querySelector('p');
  if (!p) throw new Error('missing p');
  p.textContent = 'new feedback';
  await Promise.resolve();
  await Promise.resolve();
  expect(p.textContent).toBe('new feedback');
  expect(p.querySelectorAll('.find-match')).toHaveLength(1);
  owner.invalidate();
  owner.dispose();
  owner = undefined;
  await Promise.resolve();
  expect(p.textContent).toBe('new feedback');
  expect(root.querySelectorAll('.find-match')).toHaveLength(0);
});
it('partial mark transaction failure rolls back owned changes and reports no deceptive count', () => {
  fixture('<p>abc<strong>def</strong></p>');
  const original = root.innerHTML;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured for explicit apply(this) in the failure injection below.
  const append = Element.prototype.append;
  vi.spyOn(Element.prototype, 'append').mockImplementation(function (
    this: Element,
    ...nodes
  ) {
    if (this.tagName === 'MARK') throw new Error('injected marker failure');
    append.apply(this, nodes);
  });
  let result: FindState | undefined;
  owner = new DocumentFind(
    root,
    (state) => {
      result = state;
    },
    include,
  );
  owner.search('abcdef');
  expect(result).toMatchObject({
    total: 0,
    current: 0,
    error: 'injected marker failure',
  });
  expect(root.innerHTML).toBe(original);
});
it.each([false, true])(
  'dismissal retains the latest reading selection independently of Find control focus (backward=%s)',
  (backward) => {
    fixture('<p>alpha beta needle</p>');
    root.tabIndex = -1;
    const original = root.querySelector('p')?.firstChild;
    if (!(original instanceof Text)) throw new Error('missing text');
    const bar = document.createElement('section');
    bar.className = 'find-bar';
    bar.innerHTML = '<input><button>Close find</button>';
    root.after(bar);
    const input = bar.querySelector('input');
    const close = bar.querySelector('button');
    if (!input || !close) throw new Error('missing Find controls');
    const selection = window.getSelection();
    root.focus();
    selection?.setBaseAndExtent(original, 0, original, 5);
    Element.prototype.scrollIntoView = vi.fn();
    owner = new DocumentFind(root, () => {}, include);
    owner.search('needle');
    input.focus();
    root.focus();
    selection?.setBaseAndExtent(
      original,
      backward ? 10 : 6,
      original,
      backward ? 6 : 10,
    );
    expect(selection?.toString()).toBe('beta');
    // Focus leaves reading synchronously, before a queued selectionchange event.
    (backward ? input : close).focus();
    if (backward) {
      input.value = 'beta';
      input.setSelectionRange(2, 2);
      owner.search('beta');
      owner.search('');
      expect(input.selectionStart).toBe(2);
    }
    owner.dispose();
    root.focus({ preventScroll: true });
    owner.restoreSelection();
    expect(selection?.toString()).toBe('beta');
    expect(selection?.anchorNode).toBe(original);
    expect(selection?.anchorOffset).toBe(backward ? 10 : 6);
    expect(selection?.focusOffset).toBe(backward ? 6 : 10);
    expect(original.data).toBe('alpha beta needle');
    expect(root.querySelectorAll('.find-match')).toHaveLength(0);
  },
);

it('selection observation ignores input carets and owned transactions and retires with the Find owner', () => {
  fixture('<p>alpha beta needle</p>');
  root.tabIndex = -1;
  const original = root.querySelector('p')?.firstChild;
  if (!(original instanceof Text)) throw new Error('missing text');
  const bar = document.createElement('section');
  bar.className = 'find-bar';
  const input = document.createElement('input');
  bar.append(input);
  root.after(bar);
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');
  const rootAdded = vi.spyOn(root, 'addEventListener');
  const rootRemoved = vi.spyOn(root, 'removeEventListener');
  Element.prototype.scrollIntoView = vi.fn();
  root.focus();
  const selection = window.getSelection();
  selection?.setBaseAndExtent(original, 0, original, 5);
  owner = new DocumentFind(root, () => {}, include);
  owner.search('needle');
  selection?.setBaseAndExtent(original, 10, original, 6);
  document.dispatchEvent(new Event('selectionchange'));
  input.focus();
  input.value = 'beta';
  input.setSelectionRange(2, 2);
  owner.search('beta');
  document.dispatchEvent(new Event('selectionchange'));
  owner.search('');
  document.dispatchEvent(new Event('selectionchange'));
  expect(input.selectionStart).toBe(2);
  const selectionListeners = added.mock.calls.filter(
    ([event]) => event === 'selectionchange',
  );
  expect(selectionListeners).toHaveLength(1);
  const focusListeners = rootAdded.mock.calls.filter(
    ([event]) => event === 'focusout',
  );
  expect(focusListeners).toHaveLength(1);
  const closed = owner;
  closed.dispose();
  owner = undefined;
  expect(removed).toHaveBeenCalledWith(
    'selectionchange',
    selectionListeners[0][1],
  );
  expect(rootRemoved).toHaveBeenCalledWith('focusout', focusListeners[0][1]);
  root.focus();
  selection?.setBaseAndExtent(original, 0, original, 5);
  document.dispatchEvent(new Event('selectionchange'));
  closed.restoreSelection();
  expect(selection?.toString()).toBe('beta');
  expect(selection?.anchorOffset).toBe(10);
  expect(selection?.focusOffset).toBe(6);
  expect(original.data).toBe('alpha beta needle');
});

it('query edits and wrapped movement reuse the corpus; own markers never schedule an observer loop, disposal cancels coalesced work', async () => {
  fixture('<p>one one two</p>');
  const includeText = vi.fn(include);
  const publish = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  owner = new DocumentFind(root, publish, includeText);
  owner.search('one');
  const walks = includeText.mock.calls.length;
  owner.search('two');
  owner.move(1);
  owner.move(-1);
  owner.search('one');
  await Promise.resolve();
  await Promise.resolve();
  expect(includeText.mock.calls.length).toBe(walks);
  expect(publish).toHaveBeenCalledTimes(5);
  owner.invalidate();
  owner.invalidate();
  await Promise.resolve();
  await Promise.resolve();
  expect(includeText.mock.calls.length).toBe(walks * 2);
  expect(publish).toHaveBeenCalledTimes(6);
  owner.invalidate();
  owner.dispose();
  owner = undefined;
  await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(6);
  expect(root.querySelectorAll('.find-match')).toHaveLength(0);
});
