import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ReaderController } from './controller';
import { preferences } from './native';
import { mountDiagram, type DiagramView } from './diagrams/view';
import { mountMedia } from './reader/media';
import { MetadataCard } from './reader/MetadataCard';
import type { Rendered } from './types';
import { SettingsController } from './settings/model';
import { SettingsDialog, SettingsFeedback } from './settings/SettingsDialog';
import { TemporaryDialog } from './TemporaryDialog';
import { Guide } from './Guide';
import { syncMenu } from './presentation';
import { version } from '../package.json';
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
  type Surface = 'settings' | 'guide' | 'information' | 'about';
  const [surface, setSurface] = useState<Surface | null>(null);
  const modalOpen = useRef<Surface | null>(null);
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const statusBar = useRef<HTMLElement>(null);
  const [composition, setComposition] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{
    message: string;
    state: typeof state;
  } | null>(null);
  const commandMessage =
    actionFeedback?.state === state ? actionFeedback.message : '';
  const [presentationError, setPresentationError] = useState(false);
  const [syncAttempt, setSyncAttempt] = useState(0);
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
  const [linkFeedback, setLinkFeedback] = useState<{
    document: Rendered;
    message: string;
  } | null>(null);
  const busy = ['loading', 'parsing', 'committing'].includes(state.phase);
  const focusReading = useCallback(() => {
    (article.current ?? main.current)?.focus({ preventScroll: true });
  }, []);
  const closeSurface = () => {
    modalOpen.current = null;
    setSurface(null);
    setActionFeedback(null);
  };
  const statusRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node && statusBar.current?.contains(window.document.activeElement))
        focusReading();
      statusBar.current = node;
    },
    [focusReading],
  );
  const dispatch = useCallback(
    (payload: string, invoker?: HTMLElement) => {
      const phase = controller.state.phase;
      const pending = ['loading', 'parsing', 'committing'].includes(phase);
      const zoom =
        payload === 'zoom-in' ||
        payload === 'zoom-out' ||
        payload === 'zoom-reset';
      if (
        composing.current ||
        pending ||
        (modalOpen.current && !(zoom && modalOpen.current === 'settings'))
      ) {
        setActionFeedback({
          message:
            'Command unavailable during composition, pending reading or an open dialog. Try again after finishing it.',
          state: controller.state,
        });
        return;
      }
      setActionFeedback(null);
      if (zoom) {
        settingsController.zoom(payload);
      } else if (payload === 'status-bar') {
        if (statusBar.current?.contains(window.document.activeElement))
          focusReading();
        settingsController.change({
          statusVisible: !settingsController.getState().settings.statusVisible,
        });
      } else if (
        payload === 'settings' ||
        payload === 'guide' ||
        payload === 'information' ||
        payload === 'about'
      ) {
        if (payload === 'information' && !controller.state.displayed) {
          setActionFeedback({
            message:
              'Document Information is unavailable until a document is open.',
            state: controller.state,
          });
          return;
        }
        const active = invoker ?? window.document.activeElement;
        setOrigin(
          active instanceof HTMLElement && active !== window.document.body
            ? active
            : null,
        );
        modalOpen.current = payload;
        setSurface(payload);
      } else if (payload === 'open' || payload === 'reload') {
        if (payload === 'reload' && !controller.state.displayed) {
          setActionFeedback({
            message: 'Reload is unavailable until a document is open.',
            state: controller.state,
          });
          return;
        }
        void controller.run(payload);
      }
    },
    [controller, settingsController, focusReading],
  );
  useEffect(() => {
    let disposed = false;
    void syncMenu({
      statusVisible: settings.statusVisible,
      busy,
      modal:
        surface === null
          ? 'none'
          : surface === 'settings'
            ? 'settings'
            : 'other',
      composing: composition,
      pageZoom: settings.pageZoom,
    })
      .then(() => {
        if (!disposed) setPresentationError(false);
      })
      .catch(() => {
        if (!disposed) setPresentationError(true);
      });
    return () => {
      disposed = true;
    };
  }, [
    settings.statusVisible,
    settings.pageZoom,
    busy,
    surface,
    composition,
    syncAttempt,
  ]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('menu_action', ({ payload }) => {
      dispatch(payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        if (!disposed)
          setMenuError(
            'Menu commands unavailable. Use these recovery controls.',
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dispatch]);
  useEffect(() => {
    const id = state.displayed?.snapshot.documentId;
    if (id !== undefined && id !== lastDocument.current) {
      lastDocument.current = id;
      const host = article.current;
      const document = state.displayed;
      if (document?.fragment && host) {
        let key = document.fragment;
        try {
          key = decodeURIComponent(key);
        } catch {
          /* Report missing target below. */
        }
        const target = window.document.getElementById(
          document.fragments?.[key] ?? '',
        );
        if (target && host.contains(target)) {
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'start' });
        } else {
          host.focus();
          setLinkFeedback({
            document,
            message: 'Section or footnote not found in this document.',
          });
        }
      } else {
        host?.focus();
        host?.scrollIntoView({ block: 'start' });
      }
    }
  }, [state.displayed]);
  useEffect(() => {
    const document = state.displayed;
    const host = article.current;
    if (!document || !host) return;
    const stopMedia = mountMedia(host, document, controller);
    // Native anchors already synthesize click on Enter; one delegated listener
    // handles pointer and keyboard activation without intercepting reader keys.
    const activate = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || !host.contains(link)) return;
      event.preventDefault();
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const action = document.actions?.find(
        (action) => action.slot === link.getAttribute('data-reader-link'),
      );
      if (action) {
        if (
          event.isTrusted &&
          !composing.current &&
          controller.state.displayed === document &&
          controller.state.phase !== 'committing' &&
          !modalOpen.current
        ) {
          setLinkFeedback(null);
          void controller.activate(document, action.href);
        }
        return;
      }
      const href = link.getAttribute('href');
      if (!href?.startsWith('#')) return;
      const target = window.document.getElementById(href.slice(1));
      if (!target || !host.contains(target)) {
        setLinkFeedback({
          document,
          message: 'Section or footnote not found in this document.',
        });
        return;
      }
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
      setLinkFeedback(null);
    };
    const preventEscape = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('a'))
        event.preventDefault();
    };
    host.addEventListener('click', activate);
    host.addEventListener('auxclick', preventEscape);
    return () => {
      stopMedia();
      host.removeEventListener('click', activate);
      host.removeEventListener('auxclick', preventEscape);
    };
  }, [state.displayed, controller]);
  const diagrams = useRef<DiagramView[]>([]);
  useEffect(() => {
    const document = state.displayed;
    const host = article.current;
    if (!document || !host) return;
    const context = `d${String(document.snapshot.documentId)}-r${String(document.snapshot.revision)}`;
    diagrams.current = (document.diagrams ?? []).flatMap((definition) => {
      const slot = host.querySelector(
        `[data-reader-diagram="${definition.slot}"]`,
      );
      return slot
        ? [
            mountDiagram(
              slot,
              definition,
              context,
              () =>
                !composing.current &&
                !modalOpen.current &&
                controller.state.phase !== 'committing' &&
                controller.state.displayed === document,
            ),
          ]
        : [];
    });
    return () => {
      for (const diagram of diagrams.current) diagram.dispose();
      diagrams.current = [];
    };
  }, [state.displayed, controller]);
  useEffect(() => {
    const lifetime = { retired: false };
    const views = diagrams.current;
    void (async () => {
      for (const view of views) {
        if (lifetime.retired) break;
        await view.palette(palette);
      }
    })();
    return () => {
      lifetime.retired = true;
      for (const view of views) view.retire();
    };
  }, [state.displayed, palette]);
  useEffect(() => {
    for (const diagram of diagrams.current) diagram.fit(settings.fitDiagrams);
  }, [state.displayed, settings.fitDiagrams]);
  useEffect(() => {
    if (surface || composition || state.phase === 'committing')
      for (const diagram of diagrams.current) diagram.interrupt();
  }, [surface, composition, state.phase]);
  const document = state.displayed;
  return (
    <div
      className="shell"
      onCompositionStartCapture={() => {
        composing.current = true;
        setComposition(true);
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
        setComposition(false);
      }}
    >
      <section className="sr-only" aria-label="Reader status">
        <p role="status">
          {(!surface && commandMessage) ||
            (state.phase === 'error' ||
            (state.phase === 'empty' && !state.message.includes('cancel'))
              ? ''
              : state.message)}
        </p>
      </section>
      {(busy ||
        state.phase === 'error' ||
        menuError ||
        presentationError ||
        preferenceState.status === 'error' ||
        preferenceState.notice) && (
        <aside className="recovery" aria-label="Reader recovery">
          {(busy || state.phase === 'error') && (
            <p role={state.phase === 'error' ? 'alert' : undefined}>
              {state.message}
            </p>
          )}
          {busy && state.phase !== 'committing' && (
            <button
              onClick={() => {
                void controller.cancel();
              }}
            >
              Cancel
            </button>
          )}
          {(menuError || state.phase === 'error') && (
            <>
              {menuError && <p role="alert">{menuError}</p>}
              <div className="commands">
                <button
                  disabled={busy || surface !== null}
                  onClick={() => {
                    dispatch('open');
                  }}
                >
                  Open File…
                </button>
                {document && (
                  <button
                    disabled={busy || surface !== null}
                    onClick={() => {
                      dispatch('reload');
                    }}
                  >
                    Reload
                  </button>
                )}
                {menuError && (
                  <button
                    disabled={busy || surface !== null}
                    onClick={(event) => {
                      dispatch('settings', event.currentTarget);
                    }}
                  >
                    Settings…
                  </button>
                )}
              </div>
            </>
          )}
          {(preferenceState.status === 'error' || preferenceState.notice) && (
            <SettingsFeedback
              recoveryOnly
              status={preferenceState.status}
              notice={preferenceState.notice}
              retry={settingsController.retry}
            />
          )}
          {presentationError && (
            <p role="alert">
              Menu presentation could not be synchronized; applied preferences
              remain in effect.{' '}
              <button
                onClick={() => {
                  setSyncAttempt((value) => value + 1);
                }}
              >
                Retry menu synchronization
              </button>
            </p>
          )}
        </aside>
      )}
      {surface && (
        <TemporaryDialog
          title={
            surface === 'settings'
              ? 'Settings'
              : surface === 'guide'
                ? 'User Guide'
                : surface === 'information'
                  ? 'Document Information'
                  : 'About MDViewerRSX'
          }
          close={closeSurface}
          composing={composing}
          origin={origin}
          fallback={focusReading}
          initialControl={surface === 'settings'}
        >
          {commandMessage && <p role="status">{commandMessage}</p>}
          {surface === 'settings' ? (
            <SettingsDialog
              controller={settingsController}
              settings={settings}
              slot={slot}
            >
              <SettingsFeedback
                status={preferenceState.status}
                notice={preferenceState.notice}
                retry={settingsController.retry}
              />
            </SettingsDialog>
          ) : surface === 'guide' ? (
            <Guide />
          ) : surface === 'information' && document ? (
            <dl className="document-information">
              <dt>Name</dt>
              <dd>{document.snapshot.name}</dd>
              <dt>Location</dt>
              <dd>{document.snapshot.location}</dd>
              <dt>Type</dt>
              <dd>
                {document.snapshot.format === 'text'
                  ? 'Plain text'
                  : 'Markdown'}
              </dd>
              <dt>Access</dt>
              <dd>Read only</dd>
              <dt>Content</dt>
              <dd>
                {state.stale
                  ? 'Stale: last loaded content'
                  : 'Last loaded content'}
                {document.snapshot.source.length === 0 ? ' · Empty file' : ''}
              </dd>
            </dl>
          ) : (
            <>
              <p>MDViewerRSX {version}</p>
              <p>Copyright © 2026 Chrysent. MIT licensed.</p>
              <p>
                Dependency distribution notices and native platform
                qualification remain separate checks.
              </p>
            </>
          )}
        </TemporaryDialog>
      )}
      <main ref={main} tabIndex={-1} aria-busy={busy}>
        {!document ? (
          <p className="empty hint">
            Open a document with File → Open File… (
            {/Mac/.test(navigator.platform) ? '⌘O' : 'Ctrl+O'}).
          </p>
        ) : (
          <>
            <p
              className="link-feedback"
              aria-live="polite"
              aria-label="Reading link status"
            >
              {linkFeedback?.document === document
                ? linkFeedback.message
                : (state.linkMessage ?? '')}
            </p>
            <article
              ref={article}
              data-zoom={settings.pageZoom}
              tabIndex={-1}
              aria-label={document.snapshot.name}
            >
              <MetadataCard
                key={`${String(document.snapshot.documentId)}-${String(document.snapshot.revision)}`}
                metadata={document.metadata}
              />
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
      {settings.statusVisible && (
        <footer
          ref={statusRef}
          className="status-bar"
          aria-label="Displayed document"
        >
          <strong>{document?.snapshot.name ?? 'No document open'}</strong>
          <span>
            {document
              ? `${document.snapshot.format === 'text' ? 'Plain text' : 'Markdown'} · Read only${document.snapshot.source.length === 0 ? ' · Empty file' : ''}${state.stale ? ' · Stale: last loaded content' : ''}`
              : 'Ready'}
          </span>
          {busy && <span>{state.message}</span>}
          {preferenceState.status === 'error' && (
            <span>Preferences not saved</span>
          )}
          {document && (
            <button
              disabled={busy || surface !== null}
              onClick={(event) => {
                dispatch('information', event.currentTarget);
              }}
            >
              Document Information…
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
