export interface FindState {
  total: number;
  current: number;
  error: string;
}
interface Span {
  text: Text;
  from: number;
  to: number;
  start: number;
  end: number;
}
interface Chunk {
  value: string;
  spans: Span[];
}
export interface Segment {
  text: Text;
  from: number;
  to: number;
}
interface Match {
  segments: Segment[];
  marks: HTMLElement[];
}
interface Piece {
  node: Text;
  from: number;
  data: string;
}
interface Split {
  original: Text;
  parent: Node;
  data: string;
  pieces: Piece[];
  marks: HTMLElement[];
}
const excluded =
  '[data-reader-empty],button,input,select,textarea,audio,video,svg,img,script,style,template,[inert],[data-reader-diagram],.diagram-scene,.diagram-viewport,.diagram-instructions,.diagram .commands,.diagram details,.diagram figcaption,.diagram > button,.metadata > strong,.metadata summary';

// Visibility is evaluated per Text: visibility:hidden may have visible children,
// and display:contents has no box of its own. Offscreen reading is searchable.
export function visibleText(text: Text) {
  const parent = text.parentElement;
  if (!parent || parent.closest(excluded)) return false;
  for (
    let element: Element | null = parent;
    element;
    element = element.parentElement
  ) {
    if (
      element.hasAttribute('hidden') ||
      getComputedStyle(element).display === 'none' ||
      getComputedStyle(element).opacity === '0'
    )
      return false;
    if (element instanceof HTMLDetailsElement && !element.open) {
      const summary = [...element.children].find(
        (child) => child.tagName === 'SUMMARY',
      );
      if (!summary?.contains(text)) return false;
    }
  }
  const style = getComputedStyle(parent);
  if (style.visibility !== 'visible' || style.opacity === '0') return false;
  if (
    parent.closest('.diagram') &&
    !parent.textContent.includes('could not render:')
  )
    return false;
  const range = document.createRange();
  range.selectNodeContents(text);
  return [...range.getClientRects()].some(
    (rect) => rect.width > 0 && rect.height > 0,
  );
}

// Chunk boundaries have no searchable character: a literal newline in pre is
// real text, whereas unrelated paragraphs can never match across a separator.
export function buildCorpus(root: HTMLElement, visible = visibleText): Chunk[] {
  const chunks: Chunk[] = [];
  let chunk: Chunk = { value: '', spans: [] };
  let whitespace: Segment[] = [];
  const boundary = () => {
    if (chunk.value) chunks.push(chunk);
    chunk = { value: '', spans: [] };
    whitespace = [];
  };
  const append = (value: string, spans: Segment[]) => {
    const start = chunk.value.length;
    chunk.value += value;
    for (const span of spans)
      chunk.spans.push({ ...span, start, end: chunk.value.length });
  };
  const walk = (node: Node) => {
    if (node instanceof Text) {
      if (!visible(node)) return;
      const preserve = /^(pre|pre-wrap|break-spaces)$/.test(
        getComputedStyle(node.parentElement ?? root).whiteSpace,
      );
      if (preserve) {
        if (whitespace.length && chunk.value) append(' ', whitespace);
        whitespace = [];
        if (node.data)
          append(node.data, [{ text: node, from: 0, to: node.length }]);
      } else {
        for (const part of node.data.matchAll(/[\t\n\r\f ]+|[^\t\n\r\f ]+/g)) {
          const span = {
            text: node,
            from: part.index,
            to: part.index + part[0].length,
          };
          if (/^[\t\n\r\f ]/.test(part[0])) whitespace.push(span);
          else {
            if (whitespace.length && chunk.value) append(' ', whitespace);
            whitespace = [];
            append(part[0], [span]);
          }
        }
      }
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      node.matches(excluded) ||
      node.hasAttribute('hidden') ||
      getComputedStyle(node).display === 'none'
    )
      return;
    const display = getComputedStyle(node).display;
    const block =
      node.tagName === 'BR' ||
      /^(block|flow-root|flex|grid|list-item|table.*)$/.test(display) ||
      /^(P|DIV|LI|DT|DD|TH|TD|TR|H[1-6]|PRE|BLOCKQUOTE|SECTION|DETAILS|SUMMARY)$/.test(
        node.tagName,
      );
    if (block) boundary();
    for (const child of node.childNodes) walk(child);
    if (block) boundary();
  };
  walk(root);
  boundary();
  return chunks;
}
export function literalMatches(chunks: Chunk[], query: string): Match[] {
  if (!query) return [];
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'giu',
  );
  return chunks.flatMap((chunk) =>
    [...chunk.value.matchAll(expression)].map((found) => {
      const start = found.index;
      const end = start + found[0].length;
      const segments: Segment[] = [];
      for (const span of chunk.spans) {
        if (span.end <= start || span.start >= end) continue;
        const exact = span.to - span.from === span.end - span.start;
        const from = span.from + (exact ? Math.max(0, start - span.start) : 0);
        const to = span.to - (exact ? Math.max(0, span.end - end) : 0);
        const previous = segments.at(-1);
        if (previous?.text === span.text && previous.to === from)
          previous.to = to;
        else segments.push({ text: span.text, from, to });
      }
      return { segments, marks: [] };
    }),
  );
}

type Endpoint = { node: Node; offset: number; child?: Node; atEnd?: boolean };
export class DocumentFind {
  private corpus: Chunk[] = [];
  private matches: Match[] = [];
  private splits: Split[] = [];
  private index = 0;
  private query = '';
  private dirty = true;
  private retired = false;
  private queued = false;
  private changing = false;
  private readingSelection: [Endpoint, Endpoint] | null = null;
  private observer: MutationObserver;
  constructor(
    private root: HTMLElement,
    private publish: (state: FindState) => void,
    private isVisible = visibleText,
  ) {
    this.observer = new MutationObserver((records) => {
      if (records.some((record) => this.relevant(record))) this.invalidate();
    });
    this.rememberSelection();
    // selectionchange is asynchronous; focusout captures reading endpoints
    // before an input's native caret can replace the document selection.
    document.addEventListener('selectionchange', this.rememberSelection);
    this.root.addEventListener('focusout', this.rememberSelection);
    this.observe();
    window.addEventListener('resize', this.invalidate);
  }
  private rememberSelection = () => {
    if (
      this.retired ||
      this.changing ||
      !this.root.isConnected ||
      document.activeElement?.closest('.find-bar')
    )
      return;
    const selection = window.getSelection();
    if (
      !selection?.anchorNode?.isConnected ||
      !selection.focusNode?.isConnected ||
      !this.root.contains(selection.anchorNode) ||
      !this.root.contains(selection.focusNode)
    )
      return;
    const points: [Endpoint, Endpoint] = [
      this.endpoint(selection.anchorNode, selection.anchorOffset),
      this.endpoint(selection.focusNode, selection.focusOffset),
    ];
    const previous = this.readingSelection;
    if (
      previous &&
      points.every(
        (point, index) =>
          point.node === previous[index].node &&
          point.offset === previous[index].offset &&
          point.child === previous[index].child &&
          point.atEnd === previous[index].atEnd,
      )
    )
      return;
    this.readingSelection = points;
  };
  private relevant(record: MutationRecord) {
    const element =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement;
    // Geometry-only diagram interaction cannot change reading visibility.
    return !(
      element?.closest('.diagram .commands') ||
      (record.type === 'attributes' &&
        record.attributeName === 'style' &&
        element?.matches('.diagram-scene'))
    );
  }
  private observe() {
    if (!this.retired)
      this.observer.observe(this.root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['open', 'hidden', 'inert', 'class', 'style'],
      });
  }
  invalidate = () => {
    if (this.retired) return;
    this.dirty = true;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.retired && this.dirty) this.search(this.query, false);
    });
  };
  private endpoint(node: Node, offset: number): Endpoint {
    for (const split of this.splits) {
      const piece = split.pieces.find((piece) => piece.node === node);
      if (piece) return { node: split.original, offset: piece.from + offset };
      if (node instanceof HTMLElement && split.marks.includes(node)) {
        const text = node.firstChild;
        const part = split.pieces.find((piece) => piece.node === text);
        if (part)
          return {
            node: split.original,
            offset: part.from + (offset ? part.data.length : 0),
          };
      }
    }
    return node instanceof Text
      ? { node, offset }
      : {
          node,
          offset,
          child: node.childNodes[offset],
          atEnd: offset === node.childNodes.length,
        };
  }
  private resolve(point: Endpoint): [Node, number] {
    for (const split of this.splits) {
      if (point.node !== split.original) continue;
      const part = [...split.pieces]
        .reverse()
        .find((piece) => point.offset >= piece.from);
      if (part)
        return [
          part.node,
          Math.min(part.node.length, point.offset - part.from),
        ];
    }
    const offset =
      point.child?.parentNode === point.node
        ? [...point.node.childNodes].indexOf(point.child as ChildNode)
        : point.atEnd
          ? point.node.childNodes.length
          : point.offset;
    return [
      point.node,
      Math.min(
        offset,
        point.node instanceof Text
          ? point.node.length
          : point.node.childNodes.length,
      ),
    ];
  }
  private preserve(change: () => void) {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    const points =
      !document.activeElement?.closest('.find-bar') &&
      anchor &&
      focus &&
      (this.root.contains(anchor) || this.root.contains(focus))
        ? [
            this.endpoint(anchor, selection.anchorOffset),
            this.endpoint(focus, selection.focusOffset),
          ]
        : null;
    if (points) this.readingSelection = [points[0], points[1]];
    const scrolls: { node: Element; top: number; left: number }[] = [];
    for (const node of this.root.querySelectorAll('*'))
      if (node.scrollTop || node.scrollLeft)
        scrolls.push({ node, top: node.scrollTop, left: node.scrollLeft });
    for (let node: Element | null = this.root; node; node = node.parentElement)
      scrolls.push({ node, top: node.scrollTop, left: node.scrollLeft });
    const wasChanging = this.changing;
    this.changing = true;
    try {
      change();
    } finally {
      try {
        if (points && points.every((point) => point.node.isConnected)) {
          selection?.setBaseAndExtent(
            ...this.resolve(points[0]),
            ...this.resolve(points[1]),
          );
        }
        for (const { node, top, left } of scrolls) {
          node.scrollTop = top;
          node.scrollLeft = left;
        }
      } finally {
        this.changing = wasChanging;
      }
    }
  }
  private clear() {
    for (const split of this.splits) {
      const intact =
        split.original.isConnected &&
        this.root.contains(split.original) &&
        split.pieces.every(
          (piece) =>
            piece.node.data === piece.data &&
            (piece.node.parentNode === split.parent ||
              split.marks.some(
                (mark) =>
                  piece.node.parentNode === mark &&
                  mark.parentNode === split.parent,
              )),
        );
      for (const mark of split.marks)
        if (this.root.contains(mark)) mark.replaceWith(...mark.childNodes);
      if (!intact) {
        this.dirty = true;
        continue;
      }
      split.original.data = split.data;
      for (const piece of split.pieces)
        if (piece.node !== split.original) piece.node.remove();
    }
    this.splits = [];
    this.matches = [];
  }
  private mark() {
    const grouped = new Map<
      Text,
      { match: Match; from: number; to: number }[]
    >();
    for (const match of this.matches)
      for (const segment of match.segments) {
        const parts = grouped.get(segment.text) ?? [];
        parts.push({ match, from: segment.from, to: segment.to });
        grouped.set(segment.text, parts);
      }
    for (const [original, parts] of grouped) {
      const parent = original.parentNode;
      if (!parent || !this.root.contains(original))
        throw new Error('Reading text changed. Try Find again.');
      const split: Split = {
        original,
        parent,
        data: original.data,
        pieces: [],
        marks: [],
      };
      this.splits.push(split);
      const boundaries = [
        ...new Set(parts.flatMap((part) => [part.from, part.to])),
      ].sort((a, b) => b - a);
      let end = original.length;
      for (const from of boundaries) {
        const node = original.splitText(from);
        split.pieces.push({ node, from, data: split.data.slice(from, end) });
        end = from;
      }
      split.pieces.push({ node: original, from: 0, data: original.data });
      split.pieces.sort(
        (a, b) =>
          a.from - b.from ||
          Number(a.node !== original) - Number(b.node !== original),
      );
      for (const part of parts) {
        for (const piece of split.pieces) {
          if (!piece.data || piece.from < part.from || piece.from >= part.to)
            continue;
          const mark = document.createElement('mark');
          mark.className = 'find-match';
          split.marks.push(mark);
          part.match.marks.push(mark);
          piece.node.before(mark);
          mark.append(piece.node);
        }
      }
    }
  }
  search(query: string, navigate = true) {
    if (this.retired) return;
    if (this.observer.takeRecords().some((record) => this.relevant(record)))
      this.dirty = true;
    this.observer.disconnect();
    this.query = query;
    try {
      this.preserve(() => {
        this.clear();
        if (this.dirty) {
          this.corpus = buildCorpus(this.root, this.isVisible);
          this.dirty = false;
        }
        this.matches = literalMatches(this.corpus, query);
        this.index = Math.min(this.index, Math.max(0, this.matches.length - 1));
        if (navigate) this.index = 0;
        this.mark();
        this.paint();
      });
      if (navigate) this.scroll();
    } catch (error) {
      this.preserve(() => {
        this.clear();
      });
      this.dirty = true;
      this.publish({
        total: 0,
        current: 0,
        error:
          error instanceof Error
            ? error.message
            : 'Find could not finish. Try again.',
      });
    } finally {
      this.observe();
    }
  }
  private paint() {
    this.matches.forEach((match, index) => {
      for (const mark of match.marks)
        mark.classList.toggle('find-current', index === this.index);
    });
    this.publish({
      total: this.matches.length,
      current: this.matches.length ? this.index + 1 : 0,
      error: '',
    });
  }
  private scroll() {
    this.matches[this.index]?.marks[0]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }
  move(direction: number) {
    if (this.retired) return;
    if (this.observer.takeRecords().some((record) => this.relevant(record)))
      this.dirty = true;
    if (this.dirty) this.search(this.query, false);
    if (!this.matches.length) return;
    this.observer.disconnect();
    try {
      this.index =
        (this.index + direction + this.matches.length) % this.matches.length;
      this.paint();
      this.scroll();
    } finally {
      this.observe();
    }
  }
  restoreSelection() {
    const points = this.readingSelection;
    if (
      points?.every(
        (point) => point.node.isConnected && this.root.contains(point.node),
      )
    )
      window
        .getSelection()
        ?.setBaseAndExtent(
          ...this.resolve(points[0]),
          ...this.resolve(points[1]),
        );
  }
  dispose() {
    this.retired = true;
    this.observer.disconnect();
    window.removeEventListener('resize', this.invalidate);
    document.removeEventListener('selectionchange', this.rememberSelection);
    this.root.removeEventListener('focusout', this.rememberSelection);
    this.preserve(() => {
      this.clear();
    });
    this.corpus = [];
  }
}
