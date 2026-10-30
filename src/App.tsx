import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ReaderController } from './controller';
export function App({ controller }: { controller: ReaderController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const article = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const lastDocument = useRef<number | null>(null);
  const [menuError, setMenuError] = useState('');
  const busy = ['loading', 'parsing', 'committing'].includes(state.phase);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('menu_action', ({ payload }) => {
      if (composing.current || controller.state.phase === 'loading') return;
      if (payload === 'open' || payload === 'reload')
        void controller.run(payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        if (!disposed)
          setMenuError(
            'Native menu events are unavailable. Use the visible Open File and Reload controls.',
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [controller]);
  useEffect(() => {
    const id = state.displayed?.snapshot.documentId;
    if (id !== undefined && id !== lastDocument.current) {
      lastDocument.current = id;
      article.current?.focus();
      article.current?.scrollIntoView({ block: 'start' });
    }
  }, [state.displayed]);
  const document = state.displayed;
  return (
    <div
      className="shell"
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
    >
      <header>
        <h1 className="brand">MDViewerRSX</h1>
        <div className="commands">
          <button
            disabled={state.phase === 'loading' || state.phase === 'committing'}
            onClick={() => {
              void controller.run('open');
            }}
          >
            Open File…
          </button>
          <button disabled aria-describedby="folder-help">
            Open Folder…
          </button>
          <button
            disabled={!document || busy}
            onClick={() => {
              void controller.run('reload');
            }}
          >
            Reload
          </button>
          {busy && state.phase !== 'committing' && (
            <button
              onClick={() => {
                void controller.cancel();
              }}
            >
              Cancel
            </button>
          )}
        </div>
        <p id="folder-help" className="hint">
          Folder browsing is not available in this version. Open individual
          files instead.
        </p>
        <div className="identity" aria-label="Displayed document">
          <strong>{document?.snapshot.name ?? 'No document open'}</strong>
          {document && (
            <>
              <span>{document.snapshot.location}</span>
              <span>
                {document.snapshot.format === 'text'
                  ? 'Plain text — read only'
                  : 'Markdown — read only'}
                {state.stale ? ' · Stale: last loaded content' : ''}
              </span>
            </>
          )}
        </div>
      </header>
      <section className="feedback" aria-label="Reader status">
        <p role={state.phase === 'error' ? 'alert' : 'status'}>
          {state.message}
        </p>
        {menuError && <p>{menuError}</p>}
      </section>
      <main aria-busy={busy}>
        {!document ? (
          <section className="empty">
            <h2>Read local documents, without changing them.</h2>
            <p>
              Choose Markdown (.md, .markdown, .mdown, .mkd, .mkdown), .txt or
              .log. Files must be UTF-8.
            </p>
            <p>
              Use File → Open File (⌘O on macOS, Ctrl+O elsewhere). Reload is ⌘R
              / Ctrl+R.
            </p>
          </section>
        ) : (
          <>
            {document.snapshot.format === 'markdown' && (
              <p className="reading-note">
                Links and media are inactive. Metadata, syntax colors, footnotes
                and diagrams are not yet enhanced; their source remains
                readable.
              </p>
            )}
            <article
              ref={article}
              tabIndex={-1}
              aria-label={document.snapshot.name}
            >
              {document.snapshot.source.length === 0 ? (
                <p className="empty">This file is empty.</p>
              ) : document.html === null ? (
                <pre className="literal">{document.snapshot.source}</pre>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: document.html }} />
              )}
            </article>
          </>
        )}
      </main>
    </div>
  );
}
