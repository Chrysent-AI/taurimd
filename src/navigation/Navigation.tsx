import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Rendered } from '../types';
import type { Heading } from '../reader/parse';
import type { NavigationController } from './model';
import {
  binding,
  compareEntries,
  siblingTargets,
  type EntryIntent,
  type FileEntry,
  type FileIndex,
  type FileSortDirection,
  type FileSortKey,
} from './types';
export function HeadingList({
  headings,
  render,
}: {
  headings: Heading[];
  render: (heading: Heading) => ReactNode;
}) {
  const groups: { heading: Heading; children: Heading[] }[] = [];
  for (const heading of headings) {
    const last = groups.at(-1);
    if (heading.level === 2 && last?.heading.level === 1)
      last.children.push(heading);
    else groups.push({ heading, children: [] });
  }
  return (
    <ul>
      {groups.map((group) => (
        <li key={group.heading.key}>
          {render(group.heading)}
          {group.children.length > 0 && (
            <ul>
              {group.children.map((heading) => (
                <li key={heading.key}>{render(heading)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
interface Props {
  controller: NavigationController;
  document: Rendered | null;
  disabled: boolean;
  allow: () => boolean;
  open: (intent: EntryIntent, invoker?: HTMLElement) => void;
  visible: boolean;
  siblingGroupRef: (node: HTMLDivElement | null) => void;
  sortKey: FileSortKey;
  sortDirection: FileSortDirection;
}
export function Navigation(props: Props) {
  const { controller, document, disabled, allow, open, siblingGroupRef } =
    props;
  const state = controller.state;
  const rootHeading = useRef<HTMLHeadingElement>(null);
  const rootFallback = useCallback(
    () => rootHeading.current?.focus({ preventScroll: true }),
    [],
  );
  const adjacent = siblingTargets(
    state.siblings,
    props.sortKey,
    props.sortDirection,
  );
  return (
    <nav aria-label="Files">
      <h2 ref={rootHeading} tabIndex={-1}>
        Files
      </h2>
      <p className="hint">{state.message}</p>
      {!state.root ? (
        state.rootMessage ? (
          <p className="warning">{state.rootMessage}</p>
        ) : (
          <p className="hint">Open a document to browse its folder.</p>
        )
      ) : (
        <div aria-busy={state.rootBusy}>
          <p className="hint">{state.rootMessage}</p>
          {state.watcherMessage && (
            <p className="warning">{state.watcherMessage}</p>
          )}
          <p className="hint">Working folder</p>
          <p className="folder-identity">{state.root.name}</p>
          {document &&
            state.siblings &&
            !state.siblings.inRoot &&
            state.rootStatus === 'ready' && (
              <p className="hint">
                Displayed file is outside this folder or excluded from
                navigation.
              </p>
            )}
          {!state.root.entries.some((entry) => entry.kind !== 'directory') &&
            state.rootStatus === 'ready' && (
              <p className="hint">No supported files.</p>
            )}
          <ul>
            <Rows
              {...props}
              index={state.root}
              parent={null}
              fallback={rootFallback}
            />
          </ul>
          {state.root.issues.map((issue, i) => (
            <p className="warning" key={i}>
              {issue.relative || 'Folder'}: {issue.code} — {issue.message}
            </p>
          ))}
        </div>
      )}
      {document && (
        <div
          className="sibling-controls"
          ref={siblingGroupRef}
          role="group"
          aria-label="Sibling navigation"
          tabIndex={-1}
        >
          <p>Files in the displayed file’s folder</p>
          <p>{state.siblingMessage}</p>
          <div className="commands">
            {(['previous', 'next'] as const).map((direction) => (
              <button
                key={direction}
                disabled={disabled || !adjacent[direction]}
                onClick={(event) => {
                  const entry = adjacent[direction];
                  if (!entry || !state.siblings || !allow()) return;
                  open(
                    {
                      binding: binding(state.siblings.index, entry),
                      name: entry.name,
                      focus: 'preserve',
                    },
                    event.currentTarget,
                  );
                }}
              >
                {direction === 'previous' ? 'Previous File' : 'Next File'}
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
function Rows(
  props: Props & {
    index: FileIndex;
    parent: number | null;
    fallback: () => void;
  },
) {
  return props.index.entries
    .filter((entry) => entry.parent === props.parent)
    .sort((a, b) => compareEntries(a, b, props.sortKey, props.sortDirection))
    .map((entry) => <Row {...props} key={entry.uiId} entry={entry} />);
}
function Row(
  props: Props & { index: FileIndex; entry: FileEntry; fallback: () => void },
) {
  const { entry, index, controller, allow, disabled } = props;
  const [expanded, setExpanded] = useState(false);
  const row = useRef<HTMLLIElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const consumed = useRef<string | null>(null);
  const preview = controller.state.previews.get(entry.uiId);
  const document = props.document;
  // A successful new open is identified by its native context and document.
  // A reload keeps the document identity, so it never re-opens a group.
  const identity =
    document && document.snapshot.contextId !== undefined
      ? `${String(document.snapshot.contextId)}:${String(document.snapshot.documentId)}`
      : null;
  const settled = controller.state.siblingDocument === document;
  const eligible =
    entry.kind === 'markdown' &&
    identity !== null &&
    settled &&
    document?.snapshot.contextId === entry.context &&
    controller.state.siblings?.rootActive === entry.id;
  useEffect(() => {
    if (!eligible) return;
    if (consumed.current === identity) return;
    consumed.current = identity;
    setExpanded(true);
  }, [eligible, identity]);
  useEffect(() => {
    if (!props.visible || !expanded) {
      controller.collapse(entry.uiId);
      return;
    }
    if (entry.kind === 'markdown' && !preview && !controller.state.rootBusy)
      void controller.preview(index, entry);
  }, [
    expanded,
    entry,
    index,
    preview,
    controller,
    controller.state.rootBusy,
    props.visible,
  ]);
  useEffect(
    () => () => {
      controller.collapse(entry.uiId);
    },
    [controller, entry.uiId],
  );
  const id = `navigation-${String(index.scope)}-${String(entry.uiId)}`;
  const active = controller.state.siblings?.rootActive === entry.id;
  const fallback = props.fallback;
  const rowRef = useCallback(
    (node: HTMLLIElement | null) => {
      if (!node && row.current?.contains(window.document.activeElement))
        fallback();
      row.current = node;
    },
    [fallback],
  );
  const childFallback = useCallback(() => {
    if (disclosure.current?.isConnected)
      disclosure.current.focus({ preventScroll: true });
    else fallback();
  }, [fallback]);
  // One toggle seam for both disclosure kinds; collapsing while a child owns
  // focus moves focus back to the disclosure control itself.
  const toggle = () => {
    if (!allow()) return;
    if (expanded && content.current?.contains(window.document.activeElement))
      disclosure.current?.focus({ preventScroll: true });
    if (expanded) controller.collapse(entry.uiId);
    setExpanded(!expanded);
  };
  return (
    <li ref={rowRef}>
      <div className="file-row">
        {entry.kind === 'directory' ? (
          <button
            ref={disclosure}
            className="tree-toggle"
            disabled={disabled}
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={`${
              expanded ? 'Collapse' : 'Expand'
            } folder ${entry.relative}`}
            onClick={toggle}
          >
            <span className="chevron" aria-hidden="true" />
            {entry.name}
          </button>
        ) : (
          <button
            disabled={disabled}
            aria-disabled={controller.state.rootBusy || disabled}
            aria-current={active ? 'page' : undefined}
            aria-label={`Open ${entry.relative}`}
            onClick={() => {
              if (!controller.state.rootBusy && allow())
                props.open({
                  binding: binding(index, entry),
                  name: entry.relative,
                  focus: 'start',
                });
            }}
          >
            {entry.name}
          </button>
        )}
        {entry.kind === 'markdown' && (
          <button
            ref={disclosure}
            className="headings-toggle"
            disabled={disabled}
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={`${expanded ? 'Hide' : 'Show'} headings for ${entry.relative}`}
            onClick={toggle}
          >
            <span className="chevron" aria-hidden="true" />
            Headings
          </button>
        )}
      </div>
      <div ref={content} id={id} hidden={!expanded}>
        {entry.kind === 'directory' ? (
          <ul>
            <Rows
              {...props}
              parent={entry.id}
              visible={props.visible && expanded}
              fallback={childFallback}
            />
          </ul>
        ) : (
          <div aria-busy={preview?.phase === 'loading'}>
            {!preview || preview.phase === 'loading' ? (
              <p className="hint">Loading headings…</p>
            ) : preview.phase === 'error' ? (
              <p>
                Could not read headings: {preview.message}{' '}
                <button
                  disabled={disabled}
                  onClick={() => {
                    if (allow()) void controller.preview(index, entry);
                  }}
                >
                  Retry headings
                </button>
              </p>
            ) : preview.headings.length === 0 ? (
              <p className="hint">No H1/H2 headings.</p>
            ) : (
              <HeadingList
                headings={preview.headings}
                render={(heading) => (
                  <button
                    disabled={disabled}
                    aria-label={`Open ${entry.relative} at ${heading.label}`}
                    onClick={() => {
                      if (!allow() || !preview.snapshot) return;
                      props.open({
                        binding: binding(index, entry),
                        name: entry.relative,
                        focus: 'heading',
                        preview: preview.snapshot,
                        key: heading.key,
                      });
                    }}
                  >
                    {heading.label || 'Untitled section'}
                  </button>
                )}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
