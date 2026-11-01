import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { NavigationController } from './model';
import type { QuickOpenController } from './quick-open';
import { binding, type EntryIntent } from './types';
export function QuickOpen({
  model,
  navigation,
  composing,
  input,
  accept,
  choose,
}: {
  model: QuickOpenController;
  navigation: NavigationController;
  composing: { current: boolean };
  input: { current: HTMLInputElement | null };
  accept: (intent: EntryIntent) => void;
  choose: (kind: 'file' | 'folder') => void;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const nav = useSyncExternalStore(navigation.subscribe, navigation.getState);
  const selectedOption = useRef<HTMLLIElement | null>(null);
  const optionRef = useCallback(
    (node: HTMLLIElement | null) => {
      if (!node && selectedOption.current === document.activeElement)
        input.current?.focus({ preventScroll: true });
      selectedOption.current = node;
    },
    [input],
  );
  const candidate = model.currentReply();
  const reply =
    candidate?.scope === nav.root?.scope &&
    candidate?.revision === nav.root?.revision &&
    !nav.rootBusy &&
    !nav.choosing
      ? candidate
      : null;
  const results = reply?.results ?? [];
  const selected = results.at(state.selected);
  const optionId = (id: number) =>
    `quick-${String(reply?.scope)}-${String(reply?.revision)}-${String(reply?.queryId)}-${String(id)}`;
  const isCurrent = () =>
    !!reply &&
    model.currentReply() === reply &&
    reply.scope === navigation.state.root?.scope &&
    reply.revision === navigation.state.root.revision &&
    !navigation.state.rootBusy &&
    !navigation.state.choosing;
  const activate = (position: number) => {
    if (composing.current || !isCurrent()) return;
    const root = navigation.state.root;
    const row = reply?.results.at(position);
    if (!row || !root) return;
    if (row.entry.kind === 'directory')
      model.enterDirectory(row.entry.relative, row.entry.id, row.entry.uiId);
    else
      accept({
        binding: binding(root, row.entry),
        name: row.entry.name,
        focus: 'start',
      });
  };
  useLayoutEffect(() => {
    selectedOption.current?.scrollIntoView({ block: 'nearest' });
  }, [state.selected, reply]);
  const summary = (() => {
    if (!nav.root) return 'Choose a folder to search its files.';
    if (nav.rootStatus === 'unavailable' || nav.rootBusy)
      return nav.rootMessage;
    if (state.phase === 'filtering') return 'Filtering…';
    if (state.phase === 'error') return state.message;
    if (reply?.status === 'authorizationRequired')
      return 'This location needs permission. Choose it to continue.';
    if (reply?.status === 'missing')
      return (
        state.message ||
        'This directory is not cached. Read this directory or refresh the folder.'
      );
    if (reply?.status === 'unavailable')
      return 'This directory could not be verified. Choose it explicitly or refresh.';
    if (reply?.status === 'indexing') return 'Indexing folder…';
    if (!reply) return 'Preparing search…';
    if (reply.total > 100)
      return `Showing first 100 results of ${String(reply.total)}.`;
    if (reply.total) return `${String(reply.total)} results.`;
    if (state.text)
      return `No files match ${state.text}${nav.rootStatus === 'partial' || nav.cache?.degraded ? ' in known results' : ''}.`;
    return nav.root.entries.length
      ? 'No supported files at this location.'
      : nav.rootStatus === 'partial'
        ? 'No supported files in known results; some folders could not be read.'
        : 'No supported files in this folder.';
  })();
  return (
    <section className="quick-open" aria-label="File lookup">
      <p className="quick-scope">
        <strong>Scope:</strong> {nav.root?.name ?? 'No folder selected'}
        <br />
        <strong>Location:</strong> {reply?.location || '.'}
      </p>
      <label htmlFor="quick-query">File name or path</label>
      <input
        id="quick-query"
        ref={input}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={true}
        aria-controls="quick-results"
        aria-activedescendant={
          selected ? optionId(selected.entry.id) : undefined
        }
        aria-describedby="quick-help"
        autoComplete="off"
        spellCheck={false}
        value={state.text}
        onChange={(event) => {
          model.text(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME engines can report 229 without isComposing.
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            (event.shiftKey && event.key !== 'Tab')
          )
            return;
          if (reply && !isCurrent()) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!results.length) return;
            event.preventDefault();
            model.select(
              Math.max(
                0,
                Math.min(
                  results.length - 1,
                  state.selected + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              ),
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (selected) activate(state.selected);
            else if (reply?.status === 'missing') void model.complete();
          } else if (event.key === 'Tab' && !event.shiftKey && selected) {
            if (selected.entry.kind === 'directory') {
              if (
                model.enterDirectory(
                  selected.entry.relative,
                  selected.entry.id,
                  selected.entry.uiId,
                )
              )
                event.preventDefault();
            } else {
              event.preventDefault();
              selectedOption.current?.focus({ preventScroll: true });
            }
          }
        }}
      />
      <p id="quick-help">
        Arrows select; Enter opens a file or enters a folder. Tab completes a
        folder or focuses the selected file. Escape closes.
      </p>
      {state.feedback && <p role="alert">{state.feedback}</p>}
      <p role="status" aria-live="polite">
        {summary}
      </p>
      {nav.rootStatus === 'partial' && (
        <p>Some folders could not be read; results are incomplete.</p>
      )}
      {nav.watcherMessage && <p>{nav.watcherMessage}</p>}
      <ul
        id="quick-results"
        role="listbox"
        aria-label="Files and folders"
        aria-busy={state.phase === 'filtering' || nav.rootBusy}
      >
        {results.map(({ entry, positions }, position) => (
          <li
            key={optionId(entry.id)}
            id={optionId(entry.id)}
            role="option"
            aria-selected={state.selected === position}
            tabIndex={
              state.selected === position && entry.kind !== 'directory' ? 0 : -1
            }
            ref={state.selected === position ? optionRef : undefined}
            onClick={() => {
              activate(position);
            }}
            onKeyDown={(event) => {
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME engines can report 229 without isComposing.
                event.keyCode === 229
              )
                return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                activate(position);
              }
            }}
          >
            <span className="quick-path">
              {Array.from(entry.relative).map((character, index) =>
                positions.includes(index) ? (
                  <strong className="quick-match" key={index}>
                    {character}
                  </strong>
                ) : (
                  character
                ),
              )}
            </span>
            <small>
              {entry.kind === 'directory'
                ? 'Folder'
                : entry.kind === 'markdown'
                  ? 'Markdown file'
                  : 'Plain text file'}
            </small>
          </li>
        ))}
      </ul>
      <div className="commands">
        {reply?.status === 'missing' && (
          <button
            onClick={() => {
              if (!composing.current) void model.complete();
            }}
          >
            Read this directory
          </button>
        )}
        {nav.root && (
          <button
            disabled={nav.rootBusy}
            onClick={() => {
              if (!composing.current) void navigation.refresh();
            }}
          >
            Refresh folder
          </button>
        )}
        <button
          onClick={() => {
            if (!composing.current) choose('file');
          }}
        >
          Choose File…
        </button>
        <button
          onClick={() => {
            if (!composing.current) choose('folder');
          }}
        >
          Choose Folder…
        </button>
      </div>
    </section>
  );
}
