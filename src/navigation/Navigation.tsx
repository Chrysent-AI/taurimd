import {
  memo,
  useCallback,
  useMemo,
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
  siblingGroupRef: (node: HTMLDivElement | null) => void;
  sortKey: FileSortKey;
  sortDirection: FileSortDirection;
}
// Children are grouped and ordered once per index identity and sort
// preference instead of every directory re-filtering the whole flat index
// on every render.
const emptyChildren: ReadonlyMap<number | null, FileEntry[]> = new Map();
function childrenByParentOf(
  entries: FileEntry[],
  sortKey: FileSortKey,
  sortDirection: FileSortDirection,
): ReadonlyMap<number | null, FileEntry[]> {
  const grouped = new Map<number | null, FileEntry[]>();
  for (const entry of entries) {
    const children = grouped.get(entry.parent);
    if (children) children.push(entry);
    else grouped.set(entry.parent, [entry]);
  }
  for (const children of grouped.values())
    children.sort((a, b) => compareEntries(a, b, sortKey, sortDirection));
  return grouped;
}
interface TreeProps {
  index: FileIndex;
  childrenByParent: ReadonlyMap<number | null, FileEntry[]>;
  rootActive: number | null;
  rootBusy: boolean;
  disabled: boolean;
  allow: () => boolean;
  open: (intent: EntryIntent, invoker?: HTMLElement) => void;
  fallback: () => void;
}
// The retained tree re-renders only when what its rows display changes:
// the index identity, the child projection, the active entry, or the busy
// gate a row renders. Count-only scan progress changes none of these, so
// loading announcements skip the whole subtree instead of re-rendering
// thousands of established rows.
const Tree = memo(function Tree(props: TreeProps) {
  return <Rows {...props} parent={null} />;
});
export function Navigation(props: Props) {
  const { controller, document, disabled, allow, open, siblingGroupRef } =
    props;
  const state = controller.state;
  const rootHeading = useRef<HTMLHeadingElement>(null);
  const rootFallback = useCallback(
    () => rootHeading.current?.focus({ preventScroll: true }),
    [],
  );
  const childrenByParent = useMemo(
    () =>
      state.root
        ? childrenByParentOf(
            state.root.entries,
            props.sortKey,
            props.sortDirection,
          )
        : emptyChildren,
    [state.root, props.sortKey, props.sortDirection],
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
            <Tree
              index={state.root}
              childrenByParent={childrenByParent}
              rootActive={state.siblings?.rootActive ?? null}
              rootBusy={state.rootBusy}
              disabled={disabled}
              allow={allow}
              open={open}
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
function Rows(props: TreeProps & { parent: number | null }) {
  const children = props.childrenByParent.get(props.parent) ?? [];
  return children.map((entry) => (
    <Row {...props} key={entry.uiId} entry={entry} />
  ));
}
function Row(props: TreeProps & { entry: FileEntry; parent: number | null }) {
  const { entry, index, allow, disabled } = props;
  const [expanded, setExpanded] = useState(false);
  // Descendants of a folder the reader never opened are never mounted.
  // Once a folder has been opened its rows stay established while hidden,
  // preserving node identity and focus across collapse.
  const [opened, setOpened] = useState(false);
  const row = useRef<HTMLLIElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const id = `navigation-${String(index.scope)}-${String(entry.uiId)}`;
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
  // Collapsing while a child owns focus moves focus back to the folder
  // toggle itself. Only directories carry the toggle: every file row is a
  // single open control, and its sections live in the Table of Contents.
  const toggle = () => {
    if (!allow()) return;
    if (expanded && content.current?.contains(window.document.activeElement))
      disclosure.current?.focus({ preventScroll: true });
    if (expanded) setExpanded(false);
    else {
      setOpened(true);
      setExpanded(true);
    }
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
            aria-disabled={props.rootBusy || disabled}
            aria-current={props.rootActive === entry.id ? 'page' : undefined}
            aria-label={`Open ${entry.relative}`}
            onClick={() => {
              if (!props.rootBusy && allow())
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
      </div>
      {entry.kind === 'directory' && (
        <div ref={content} id={id} hidden={!expanded}>
          {opened && (
            <ul>
              <Rows {...props} parent={entry.id} fallback={childFallback} />
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
