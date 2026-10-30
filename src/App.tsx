import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ReaderController } from './controller';
import { preferences } from './native';
import { SettingsController } from './settings/model';
import { SettingsDialog, SettingsFeedback } from './settings/SettingsDialog';
export function App({ controller }: { controller: ReaderController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const readingHTML = useMemo(
    () => ({ __html: state.displayed?.html ?? '' }),
    [state.displayed],
  );
  const [settingsController] = useState(
    () => new SettingsController(preferences),
  );
  const preferenceState = useSyncExternalStore(
    settingsController.subscribe,
    settingsController.getState,
  );
  const settings = preferenceState.settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const modalOpen = useRef(false);
  useEffect(() => {
    modalOpen.current = settingsOpen;
  }, [settingsOpen]);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const slot =
    settings.mode === 'system'
      ? systemDark
        ? 'dark'
        : 'light'
      : settings.mode;
  const palette =
    slot === 'light' ? settings.lightPalette : settings.darkPalette;
  useEffect(() => settingsController.connect(), [settingsController]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => {
      setSystemDark(media.matches);
    };
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
    };
  }, []);
  useEffect(() => {
    window.document.documentElement.dataset.palette = palette;
  }, [palette]);
  const article = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const lastDocument = useRef<number | null>(null);
  const [menuError, setMenuError] = useState('');
  const busy = ['loading', 'parsing', 'committing'].includes(state.phase);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('menu_action', ({ payload }) => {
      if (composing.current) return;
      if (payload === 'settings') {
        setSettingsOpen(true);
        return;
      }
      if (
        payload === 'zoom-in' ||
        payload === 'zoom-out' ||
        payload === 'zoom-reset'
      ) {
        settingsController.zoom(payload);
        return;
      }
      if (modalOpen.current || controller.state.phase === 'loading') return;
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
            'Native menu events are unavailable. Use the visible reader and Settings controls.',
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [controller, settingsController]);
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
          <button
            onClick={() => {
              setSettingsOpen(true);
            }}
          >
            Settings…
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
      <SettingsFeedback
        status={preferenceState.status}
        notice={preferenceState.notice}
        retry={settingsController.retry}
      />
      <SettingsDialog
        open={settingsOpen}
        close={() => {
          setSettingsOpen(false);
        }}
        controller={settingsController}
        settings={settings}
        slot={slot}
        composing={composing}
      >
        <SettingsFeedback
          status={preferenceState.status}
          notice={preferenceState.notice}
          retry={settingsController.retry}
        />
      </SettingsDialog>
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
              data-zoom={settings.pageZoom}
              tabIndex={-1}
              aria-label={document.snapshot.name}
            >
              {document.snapshot.source.length === 0 ? (
                <p className="empty">This file is empty.</p>
              ) : document.html === null ? (
                <pre className="literal">{document.snapshot.source}</pre>
              ) : (
                <div dangerouslySetInnerHTML={readingHTML} />
              )}
            </article>
          </>
        )}
      </main>
    </div>
  );
}
