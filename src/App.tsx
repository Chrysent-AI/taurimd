import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { ReaderController } from './controller';
import {
  preferences,
  documentRequests,
  navigation as navigationBridge,
} from './native';
import { NavigationController } from './navigation/model';
import { Navigation } from './navigation/Navigation';
import { QuickOpen } from './navigation/QuickOpen';
import { QuickOpenController } from './navigation/quick-open';
import { binding, neighbors, type EntryIntent } from './navigation/types';
import { useDiagramExport } from './diagrams/useExport';
import { mountDiagram, type DiagramView } from './diagrams/view';
import { mountMedia } from './reader/media';
import { MetadataCard } from './reader/MetadataCard';
import type { Rendered } from './types';
import { SettingsController } from './settings/model';
import { SettingsDialog, SettingsFeedback } from './settings/SettingsDialog';
import { TemporaryDialog } from './TemporaryDialog';
import { Guide } from './Guide';
import { syncMenu } from './presentation';
import { DocumentFind, type FindState } from './reader/find';
import { FindBar } from './FindBar';
import { version } from '../package.json';
function usableFocus(
  node: HTMLElement | null | undefined,
): node is HTMLElement {
  if (
    !node?.isConnected ||
    node === window.document.body ||
    node.closest('[hidden],[inert]') ||
    node.matches(':disabled')
  )
    return false;
  for (
    let element: HTMLElement | null = node;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      (Number(style.opacity) === 0 && style.opacity !== '')
    )
      return false;
    if (
      element instanceof HTMLDetailsElement &&
      !element.open &&
      !element.querySelector('summary')?.contains(node)
    )
      return false;
  }
  return (
    getComputedStyle(node).visibility !== 'hidden' &&
    getComputedStyle(node).visibility !== 'collapse'
  );
}
export function App({ controller }: { controller: ReaderController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [navigation] = useState(
    () => new NavigationController(navigationBridge),
  );
  const navigationState = useSyncExternalStore(
    navigation.subscribe,
    navigation.getState,
  );
  const [picker] = useState(
    () =>
      new QuickOpenController(navigationBridge, () => {
        void navigation.recover();
      }),
  );
  const readerMounted = useRef(true);
  const pickerInput = useRef<HTMLInputElement | null>(null);
  const pickerHandoff = useRef(false);
  const [pickerNative, setPickerNative] = useState(false);
  useEffect(() => navigation.connect(), [navigation]);
  useLayoutEffect(() => {
    picker.update(
      navigationState.root,
      navigationState.rootBusy ||
        navigationState.choosing ||
        navigationState.rootStatus === 'unavailable',
    );
  }, [
    picker,
    navigationState.root,
    navigationState.rootBusy,
    navigationState.rootStatus,
    navigationState.choosing,
  ]);
  const sidebar = useRef<HTMLElement | null>(null);
  const siblingGroup = useRef<HTMLDivElement>(null);
  const siblingGroupRef = useCallback((node: HTMLDivElement | null) => {
    siblingGroup.current = node;
  }, []);
  const focusIntent = useRef<{
    requestId: number;
    anchor: HTMLElement | null;
    before: Rendered | null;
    action: 'entry' | 'reload';
    inSiblings: boolean;
  } | null>(null);
  const rootFocus = useRef<{
    anchor: HTMLElement | null;
    scope: number | undefined;
    inSidebar: boolean;
  } | null>(null);
  const [section, setSection] = useState<number | null>(null);
  useEffect(
    () => () => {
      readerMounted.current = false;
      navigation.dispose();
      picker.close();
    },
    [navigation, picker],
  );
  useEffect(() => {
    if (
      !navigationState.choosing &&
      !['loading', 'parsing', 'committing'].includes(state.phase)
    )
      void navigation.update(state.displayed);
  }, [
    navigation,
    state.displayed,
    state.phase,
    navigationState.root,
    navigationState.rootBusy,
    navigationState.choosing,
  ]);
  useEffect(() => {
    navigation.invalidate();
  }, [navigation, state.previewEpoch]);
  useEffect(() => {
    if (state.displayed?.previewChanged) {
      navigation.invalidate();
      navigation.notice('File changed; choose a heading again.', true);
    }
  }, [navigation, state.displayed]);
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
  type Surface =
    | 'settings'
    | 'guide'
    | 'information'
    | 'about'
    | 'export'
    | 'quick-open';
  const [surface, setSurface] = useState<Surface | null>(null);
  const modalOpen = useRef<Surface | null>(null);
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  const surfaceOrigin = useRef<HTMLElement | null>(null);
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
  const focusReading = useCallback(() => {
    (article.current ?? main.current)?.focus({ preventScroll: true });
  }, []);
  const [findOpen, setFindOpen] = useState(false);
  const findLive = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  const findOrigin = useRef<HTMLElement | null>(null);
  const findQuery = useRef('');
  const [query, setQuery] = useState('');
  const [findResult, setFindResult] = useState<FindState>({
    total: 0,
    current: 0,
    error: '',
  });
  const finder = useRef<DocumentFind | null>(null);
  const closeFind = useCallback(
    (restore = true) => {
      if (!findLive.current) return;
      const owner = finder.current;
      owner?.dispose();
      finder.current = null;
      findLive.current = false;
      if (restore) {
        if (usableFocus(findOrigin.current))
          findOrigin.current.focus({ preventScroll: true });
        else focusReading();
        owner?.restoreSelection();
      }
      findOrigin.current = null;
      setFindOpen(false);
    },
    [focusReading],
  );
  // Actual displayed revisions retire old maps without overriding request focus.
  useLayoutEffect(
    () => () => {
      closeFind(false);
    },
    [state.displayed, closeFind],
  );
  useEffect(() => {
    finder.current?.invalidate();
  }, [
    palette,
    settings.pageZoom,
    settings.sidebarDefault,
    settings.statusVisible,
  ]);
  const lastDocument = useRef<Rendered | null>(null);
  const [menuError, setMenuError] = useState('');
  const [linkFeedback, setLinkFeedback] = useState<{
    document: Rendered;
    message: string;
  } | null>(null);
  const busy = ['loading', 'parsing', 'committing'].includes(state.phase);
  const rootProblem =
    navigationState.rootStatus === 'unavailable' ||
    navigationState.rootStatus === 'partial' ||
    !!navigationState.watcherMessage;
  const sidebarRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node && sidebar.current?.contains(window.document.activeElement))
        focusReading();
      sidebar.current = node;
    },
    [focusReading],
  );
  useLayoutEffect(() => {
    const pending = rootFocus.current;
    if (!pending || navigationState.choosing) return;
    rootFocus.current = null;
    if (pending.inSidebar && pending.scope !== navigationState.root?.scope)
      sidebar.current
        ?.querySelector<HTMLElement>('nav h2')
        ?.focus({ preventScroll: true });
    else if (
      pending.anchor?.isConnected &&
      !pending.anchor.closest('[hidden]') &&
      !pending.anchor.matches(':disabled')
    )
      pending.anchor.focus({ preventScroll: true });
    else if (pending.inSidebar) focusReading();
  }, [navigationState.choosing, navigationState.root?.scope, focusReading]);
  useLayoutEffect(() => {
    if (
      !settings.sidebarDefault &&
      sidebar.current?.contains(window.document.activeElement)
    )
      focusReading();
  }, [settings.sidebarDefault, focusReading]);
  const diagrams = useRef<DiagramView[]>([]);
  const exportSurface = useCallback(
    (phase: 'preparing' | 'native' | 'closed') => {
      modalOpen.current = phase === 'closed' ? null : 'export';
      if (phase === 'native') {
        // Save must never open beneath the DOM modal, even with deferred React work.
        flushSync(() => {
          setSurface(null);
        });
      } else setSurface(phase === 'preparing' ? 'export' : null);
    },
    [],
  );
  const exporting = useDiagramExport(
    state.displayed,
    palette,
    diagrams,
    exportSurface,
    focusReading,
  );
  const startExport = exporting.start;
  const closeSurface = () => {
    if (composing.current || pickerHandoff.current) return;
    if (modalOpen.current === 'quick-open') picker.close();
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
  const allowNavigation = useCallback(() => {
    if (
      composing.current ||
      modalOpen.current ||
      navigation.state.choosing ||
      ['loading', 'parsing', 'committing'].includes(controller.state.phase)
    ) {
      setActionFeedback({
        message:
          'Command unavailable during composition, pending reading or an open dialog. Try again after finishing it.',
        state: controller.state,
      });
      return false;
    }
    return true;
  }, [controller, navigation]);
  const jump = useCallback(
    (key: number) => {
      const heading = controller.state.displayed?.headings?.find(
        (h) => h.key === key,
      );
      const target =
        heading &&
        [
          ...(article.current?.querySelectorAll<HTMLElement>('[id]') ?? []),
        ].find((node) => node.id === heading.id);
      if (!target) {
        navigation.notice('This section is no longer present.', true);
        return;
      }
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
      setSection(key);
    },
    [controller, navigation],
  );
  const openNavigation = useCallback(
    (intent: EntryIntent, invoker?: HTMLElement) => {
      if (!allowNavigation()) return;
      const indexes = [navigation.state.root, navigation.state.siblings?.index];
      if (
        !indexes.some(
          (index) =>
            index?.scope === intent.binding.scope &&
            index.revision === intent.binding.revision &&
            index.entries.some((e) => e.id === intent.binding.entry),
        )
      ) {
        navigation.notice('Folder changed; choose the file again.', true);
        return;
      }
      const document = controller.state.displayed;
      if (
        intent.key !== undefined &&
        intent.preview &&
        document?.snapshot.contextId !== undefined &&
        document.snapshot.contextId === intent.preview.contextId &&
        document.snapshot.source === intent.preview.source
      ) {
        jump(intent.key);
        return;
      }
      const anchor =
        invoker ??
        (window.document.activeElement instanceof HTMLElement
          ? window.document.activeElement
          : null);
      void controller.openEntry(intent);
      focusIntent.current = {
        requestId: controller.state.requestId,
        anchor,
        before: document,
        action: 'entry',
        inSiblings: !!anchor && !!siblingGroup.current?.contains(anchor),
      };
    },
    [allowNavigation, controller, jump, navigation],
  );
  const acceptPickerFile = useCallback(
    (intent: EntryIntent) => {
      const reply = picker.currentReply();
      const root = navigation.state.root;
      if (
        modalOpen.current !== 'quick-open' ||
        pickerHandoff.current ||
        composing.current ||
        navigation.state.choosing ||
        navigation.state.rootBusy ||
        ['loading', 'parsing', 'committing'].includes(controller.state.phase) ||
        !reply ||
        !root ||
        reply.scope !== root.scope ||
        reply.revision !== root.revision ||
        intent.binding.scope !== root.scope ||
        intent.binding.revision !== root.revision ||
        !reply.results.some(
          ({ entry }) =>
            entry.id === intent.binding.entry && entry.kind !== 'directory',
        )
      )
        return;
      pickerHandoff.current = true;
      picker.close();
      // Dismiss and restore the origin before the already-authorized transaction.
      flushSync(() => {
        setSurface(null);
      });
      // Navigation controls become disabled during handoff. Retire that focus
      // now, before native activation, never on the destination acknowledgement.
      if (
        sidebar.current?.contains(window.document.activeElement) ||
        window.document.activeElement?.closest('.recovery')
      )
        focusReading();
      void controller.openEntry(intent, true);
      modalOpen.current = null;
      pickerHandoff.current = false;
    },
    [controller, navigation, picker, focusReading],
  );
  const chooseFromPicker = useCallback(
    async (kind: 'file' | 'folder') => {
      if (
        modalOpen.current !== 'quick-open' ||
        pickerHandoff.current ||
        composing.current ||
        navigation.state.choosing ||
        ['loading', 'parsing', 'committing'].includes(controller.state.phase)
      )
        return;
      pickerHandoff.current = true;
      picker.close(true);
      flushSync(() => {
        setPickerNative(true);
        setSurface(null);
      });
      if (
        kind === 'file' &&
        (sidebar.current?.contains(window.document.activeElement) ||
          window.document.activeElement?.closest('.recovery'))
      )
        focusReading();
      const outcome =
        kind === 'file'
          ? await controller.run('open')
          : await navigation.choose();
      if (!readerMounted.current) return;
      pickerHandoff.current = false;
      setPickerNative(false);
      if (outcome === 'cancelled' || kind === 'folder') {
        picker.open(
          navigation.state.root,
          navigation.state.rootBusy ||
            navigation.state.rootStatus === 'unavailable',
        );
        if (outcome === 'failed') picker.notice(navigation.state.message);
        setSurface('quick-open');
      } else modalOpen.current = null;
    },
    [controller, navigation, picker, focusReading],
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
        payload === 'find' ||
        payload === 'find-next' ||
        payload === 'find-previous'
      ) {
        const eligibleSurface = modalOpen.current !== 'export';
        if (
          composing.current ||
          pending ||
          pickerHandoff.current ||
          navigation.state.choosing ||
          !eligibleSurface ||
          !controller.state.displayed
        ) {
          setActionFeedback({
            message:
              'Find unavailable during composition, pending reading or a native dialog. Try again after finishing it.',
            state: controller.state,
          });
          return;
        }
        if (payload !== 'find') {
          if (!modalOpen.current && findLive.current)
            finder.current?.move(payload === 'find-next' ? 1 : -1);
          else
            setActionFeedback({
              message: 'Open Find in Document to navigate matches.',
              state: controller.state,
            });
          return;
        }
        if (!findLive.current) {
          const active = modalOpen.current
            ? surfaceOrigin.current
            : (invoker ?? window.document.activeElement);
          findOrigin.current = active instanceof HTMLElement ? active : null;
          if (modalOpen.current) {
            if (modalOpen.current === 'quick-open') picker.close();
            modalOpen.current = null;
            flushSync(() => {
              setSurface(null);
            });
          }
          findLive.current = true;
          flushSync(() => {
            setFindOpen(true);
          });
          if (article.current) {
            finder.current = new DocumentFind(article.current, (result) => {
              setFindResult((previous) =>
                previous.total === result.total &&
                previous.current === result.current &&
                previous.error === result.error
                  ? previous
                  : result,
              );
            });
            finder.current.search(findQuery.current);
          }
        }
        setActionFeedback(null);
        findInput.current?.focus({ preventScroll: true });
        findInput.current?.select();
        return;
      }
      if (
        payload === 'quick-open' &&
        modalOpen.current === 'quick-open' &&
        !pending &&
        !composing.current &&
        !pickerHandoff.current &&
        !navigation.state.choosing
      ) {
        pickerInput.current?.focus({ preventScroll: true });
        return;
      }
      if (
        composing.current ||
        pickerHandoff.current ||
        pending ||
        navigation.state.choosing ||
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
      if (
        [
          'quick-open',
          'settings',
          'guide',
          'information',
          'about',
          'export-svg',
          'export-png',
          'open',
          'reload',
          'open-folder',
        ].includes(payload)
      )
        closeFind();
      if (payload === 'quick-open') {
        const active = invoker ?? window.document.activeElement;
        surfaceOrigin.current =
          active instanceof HTMLElement && active !== window.document.body
            ? active
            : null;
        setOrigin(surfaceOrigin.current);
        modalOpen.current = 'quick-open';
        picker.open(
          navigation.state.root,
          navigation.state.rootBusy ||
            navigation.state.rootStatus === 'unavailable',
        );
        setSurface('quick-open');
      } else if (payload === 'open-folder') {
        if (!navigation.state.rootBusy) {
          const active = invoker ?? window.document.activeElement;
          rootFocus.current = {
            anchor: active instanceof HTMLElement ? active : null,
            scope: navigation.state.root?.scope,
            inSidebar: !!sidebar.current?.contains(active),
          };
        }
        void navigation.choose();
      } else if (payload === 'refresh-folder') {
        void navigation.refresh();
      } else if (payload === 'reveal' && controller.state.displayed) {
        void navigation.reveal(controller.state.displayed);
      } else if (payload === 'sidebar') {
        if (sidebar.current?.contains(window.document.activeElement))
          focusReading();
        settingsController.change({
          sidebarDefault:
            !settingsController.getState().settings.sidebarDefault,
        });
      } else if (payload === 'sort-alpha' || payload === 'sort-date') {
        navigation.sort(payload === 'sort-date');
      } else if (payload === 'previous' || payload === 'next') {
        const siblings = navigation.state.siblings;
        const entry = neighbors(siblings, navigation.state.newest)[payload];
        if (entry && siblings)
          openNavigation({
            binding: binding(siblings.index, entry),
            name: entry.name,
            focus: 'preserve',
          });
        else navigation.notice('No file in that direction.');
      } else if (payload === 'export-svg' || payload === 'export-png') {
        startExport(payload === 'export-svg' ? 'svg' : 'png');
      } else if (zoom) {
        settingsController.zoom(payload);
      } else if (payload === 'fit-diagrams') {
        settingsController.change({
          fitDiagrams: !settingsController.getState().settings.fitDiagrams,
        });
      } else if (
        payload === 'appearance-system' ||
        payload === 'appearance-light' ||
        payload === 'appearance-dark'
      ) {
        settingsController.change({
          mode:
            payload === 'appearance-system'
              ? 'system'
              : payload === 'appearance-light'
                ? 'light'
                : 'dark',
        });
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
        surfaceOrigin.current =
          active instanceof HTMLElement && active !== window.document.body
            ? active
            : null;
        setOrigin(surfaceOrigin.current);
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
        const anchor =
          invoker ??
          (window.document.activeElement instanceof HTMLElement
            ? window.document.activeElement
            : null);
        const before = controller.state.displayed;
        if (
          payload === 'open' &&
          (sidebar.current?.contains(window.document.activeElement) ||
            window.document.activeElement?.closest('.recovery'))
        )
          focusReading();
        void controller.run(payload);
        focusIntent.current =
          payload === 'reload'
            ? {
                requestId: controller.state.requestId,
                anchor,
                before,
                action: 'reload',
                inSiblings:
                  !!anchor && !!siblingGroup.current?.contains(anchor),
              }
            : null;
      }
    },
    [
      controller,
      settingsController,
      focusReading,
      startExport,
      navigation,
      openNavigation,
      picker,
      closeFind,
    ],
  );
  useEffect(() => {
    let disposed = false;
    void syncMenu({
      findAvailable: !!state.displayed && modalOpen.current !== 'export',
      findMatches: findOpen && findResult.total > 0 && !findResult.error,
      statusVisible: settings.statusVisible,
      sidebarVisible: settings.sidebarDefault,
      hasRoot: !!navigationState.root && !navigationState.rootBusy,
      previous: !!neighbors(navigationState.siblings, navigationState.newest)
        .previous,
      next: !!neighbors(navigationState.siblings, navigationState.newest).next,
      newest: navigationState.newest,
      busy:
        busy ||
        exporting.progress !== null ||
        navigationState.choosing ||
        pickerNative ||
        pickerHandoff.current,
      modal:
        surface === 'quick-open'
          ? 'quickOpen'
          : modalOpen.current === 'export' || pickerNative
            ? 'other'
            : surface === null
              ? 'none'
              : surface === 'settings'
                ? 'settings'
                : 'other',
      composing: composition,
      pageZoom: settings.pageZoom,
      appearance: settings.mode,
      fitDiagrams: settings.fitDiagrams,
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
    settings.sidebarDefault,
    navigationState,
    settings.pageZoom,
    settings.mode,
    settings.fitDiagrams,
    busy,
    surface,
    composition,
    exporting.progress,
    pickerNative,
    syncAttempt,
    state.displayed,
    findOpen,
    findResult,
  ]);
  const dispatchLatest = useRef(dispatch);
  useLayoutEffect(() => {
    dispatchLatest.current = dispatch;
  }, [dispatch]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let sequence = 0;
    void getCurrentWebviewWindow()
      .listen<{ actionId: string; sequence: number }>(
        'menu_action',
        ({ payload }) => {
          if (disposed) return;
          if (
            !Number.isSafeInteger(payload.sequence) ||
            payload.sequence <= sequence
          )
            return;
          sequence = payload.sequence;
          dispatchLatest.current(payload.actionId);
        },
      )
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
  }, []);
  const receiveLatest = useRef<() => Promise<void>>(async () => {});
  useLayoutEffect(() => {
    receiveLatest.current = async () => {
      const request = await documentRequests.pending();
      if (!request || !readerMounted.current) return;
      if (request.kind === 'error') {
        controller.notice(
          request.error.attempted
            ? `${request.error.attempted}: ${request.error.message}`
            : request.error.message,
        );
        await documentRequests.dismiss(request.token);
        return;
      }
      if (!allowNavigation()) {
        await documentRequests.dismiss(request.token);
        const message =
          'Incoming document or section unavailable during composition, pending reading or a native dialog. Use Open File or try again after finishing it.';
        controller.notice(message);
        if (modalOpen.current && modalOpen.current !== 'export')
          setActionFeedback({ message, state: controller.state });
        return;
      }
      if (request.kind === 'open') {
        closeFind();
        // The destination controller owns parsing after native acceptance;
        // notification handling must remain free to reject later busy actions.
        void controller.receive((requestId) =>
          documentRequests.receive(request.token, requestId),
        );
      } else {
        const displayed = controller.state.displayed;
        if (
          !displayed ||
          displayed.snapshot.documentId !== request.document_id ||
          displayed.snapshot.revision !== request.revision
        ) {
          await documentRequests.dismiss(request.token);
          controller.notice(
            'This section belongs to a replaced document. Open the link again.',
          );
          return;
        }
        await documentRequests.dismiss(request.token);
        // Recheck actual owners after IPC, including logical native Save with no DOM modal.
        if (!allowNavigation() || controller.state.displayed !== displayed)
          return;
        if (request.fragment) {
          closeFind();
          let fragment = request.fragment;
          try {
            fragment = decodeURIComponent(fragment);
          } catch {
            /* Missing section feedback below. */
          }
          const target = window.document.getElementById(
            displayed.fragments?.[fragment] ?? '',
          );
          if (target && article.current?.contains(target)) {
            target.focus({ preventScroll: true });
            target.scrollIntoView({ block: 'start' });
          } else
            controller.notice(
              'Section or footnote not found in this document.',
            );
        }
      }
    };
  }, [controller, allowNavigation, closeFind]);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let failed = false;
    let again = false;
    const stops: (() => void)[] = [];
    const receive = async () => {
      if (disposed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await receiveLatest.current().catch(() => {
          if (!disposed)
            controller.notice(
              'Native document delivery could not finish. Use Open File to recover.',
            );
        });
      } finally {
        running = false;
        if (again) {
          again = false;
          void receive();
        }
      }
    };
    const register = async (subscription: Promise<() => void>) => {
      const stop = await subscription;
      if (disposed || failed) stop();
      else stops.push(stop);
    };
    void Promise.all([
      register(
        getCurrentWebviewWindow().listen('document_requested', () => {
          void receive();
        }),
      ),
      register(
        getCurrentWebviewWindow().listen<string>(
          'reader_notice',
          ({ payload }) => {
            if (!disposed) controller.notice(payload);
          },
        ),
      ),
    ])
      .then(() => {
        if (!disposed) void receive();
      })
      .catch(() => {
        failed = true;
        stops.splice(0).forEach((stop) => {
          stop();
        });
        if (!disposed)
          controller.notice(
            'Native document notifications unavailable. Use Open File to recover.',
          );
      });
    return () => {
      disposed = true;
      stops.forEach((stop) => {
        stop();
      });
    };
  }, [controller]);
  useEffect(() => {
    const document = state.displayed;
    if (document && document !== lastDocument.current) {
      const previous = lastDocument.current;
      lastDocument.current = document;
      const host = article.current;
      const pending = focusIntent.current;
      const ownsFocus =
        pending !== null && pending.requestId === document.requestId;
      if (document.headingKey !== undefined) {
        focusIntent.current = null;
        jump(document.headingKey);
      } else if (
        ownsFocus &&
        (document.focus === 'preserve' || pending.action === 'reload')
      ) {
        // Resolve after the matching sibling projection settles, not against
        // controls that still describe the previous displayed document.
      } else if (
        document.focus === 'preserve' ||
        previous?.snapshot.documentId === document.snapshot.documentId
      ) {
        focusIntent.current = null;
        host?.focus({ preventScroll: true });
      } else if (document.fragment && host) {
        focusIntent.current = null;
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
        focusIntent.current = null;
        host?.focus();
        host?.scrollIntoView({ block: 'start' });
      }
    }
  }, [state.displayed, jump]);
  useEffect(() => {
    const pending = focusIntent.current;
    if (!pending || busy) return;
    if (modalOpen.current || composing.current || navigationState.choosing) {
      focusIntent.current = null;
      return;
    }
    const document = state.displayed;
    if (
      state.requestId !== pending.requestId ||
      (document?.requestId !== pending.requestId && document !== pending.before)
    ) {
      focusIntent.current = null;
      return;
    }
    if (pending.inSiblings && navigation.state.siblingDocument !== document)
      return;
    focusIntent.current = null;
    if (usableFocus(pending.anchor))
      pending.anchor.focus({ preventScroll: true });
    else if (pending.inSiblings && usableFocus(siblingGroup.current)) {
      const remaining = siblingGroup.current.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      );
      (usableFocus(remaining) ? remaining : siblingGroup.current).focus({
        preventScroll: true,
      });
    } else focusReading();
  }, [
    busy,
    state.requestId,
    state.displayed,
    navigation,
    navigationState.siblings,
    navigationState.siblingDocument,
    navigationState.choosing,
    surface,
    exporting.progress,
    composition,
    focusReading,
  ]);
  useEffect(() => {
    const host = article.current;
    const root = main.current;
    if (
      !host ||
      !root ||
      !state.displayed ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const headings = state.displayed.headings ?? [];
    const targets = [...host.querySelectorAll<HTMLElement>('[id]')].flatMap(
      (node) => {
        const heading = headings.find((h) => h.id === node.id);
        return heading ? [{ node, key: heading.key }] : [];
      },
    );
    const observer = new IntersectionObserver(
      () => {
        const top = root.getBoundingClientRect().top + 60;
        const current =
          targets
            .filter((t) => t.node.getBoundingClientRect().top <= top)
            .at(-1) ?? targets.at(0);
        setSection(current?.key ?? null);
      },
      { root },
    );
    for (const target of targets) observer.observe(target.node);
    return () => {
      observer.disconnect();
    };
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
          void controller.activate(document, action.href).then((result) => {
            if (
              typeof result !== 'object' ||
              result.status !== 'anchor' ||
              controller.state.displayed !== document
            )
              return;
            if (!allowNavigation()) {
              controller.notice(
                'Section navigation is unavailable while another action owns this reader.',
              );
              return;
            }
            closeFind();
            let fragment = result.fragment;
            try {
              fragment = decodeURIComponent(fragment);
            } catch {
              /* Missing section feedback below. */
            }
            const target = window.document.getElementById(
              document.fragments?.[fragment] ?? '',
            );
            if (target && host.contains(target)) {
              controller.notice('');
              target.focus({ preventScroll: true });
              target.scrollIntoView({ block: 'start' });
            } else
              controller.notice(
                'Section or footnote not found in this document.',
              );
          });
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
  }, [state.displayed, controller, allowNavigation, closeFind]);
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
        <p aria-live="polite" aria-label="Folder status">
          {surface === 'quick-open' || (!settings.sidebarDefault && rootProblem)
            ? ''
            : `${navigationState.rootMessage}${navigationState.watcherMessage ? ` ${navigationState.watcherMessage}` : ''}`}
        </p>
        <p aria-live="polite" aria-label="Navigation status">
          {(navigationState.error && !settings.sidebarDefault) ||
          navigationState.message === state.message
            ? ''
            : navigationState.message}
        </p>
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
        exporting.feedback ||
        exporting.progress?.phase === 'native' ||
        ((navigationState.error || rootProblem) && !settings.sidebarDefault) ||
        menuError ||
        presentationError ||
        preferenceState.status === 'error' ||
        preferenceState.notice) && (
        <aside className="recovery" aria-label="Reader recovery">
          {rootProblem && !settings.sidebarDefault && (
            <p role="alert">
              {navigationState.rootMessage} {navigationState.watcherMessage}
            </p>
          )}
          {navigationState.error && !settings.sidebarDefault && (
            <p role="alert">{navigationState.message}</p>
          )}
          {exporting.progress?.phase === 'native' && (
            <p role="status">{exporting.progress.message}</p>
          )}
          {exporting.feedback && (
            <div>
              <p role={exporting.feedback.error ? 'alert' : 'status'}>
                {exporting.feedback.message}
              </p>
              <button onClick={exporting.dismiss}>
                Dismiss export message
              </button>
            </div>
          )}
          {!document && busy && state.linkMessage && (
            <p role="alert">{state.linkMessage}</p>
          )}
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
            surface === 'quick-open'
              ? 'Quick Open'
              : surface === 'settings'
                ? 'Settings'
                : surface === 'guide'
                  ? 'User Guide'
                  : surface === 'information'
                    ? 'Document Information'
                    : surface === 'export'
                      ? `Export diagrams — ${exporting.progress?.mode.toUpperCase() ?? ''} ZIP`
                      : 'About taurimd'
          }
          close={surface === 'export' ? exporting.cancel : closeSurface}
          restoreFocus={surface !== 'export'}
          dismissDisabled={
            surface === 'export' && exporting.progress?.phase === 'cancelling'
          }
          footer={
            surface === 'export' ? (
              <div className="commands">
                <button
                  disabled={exporting.progress?.phase === 'cancelling'}
                  onClick={() => {
                    if (!composing.current) exporting.cancel();
                  }}
                >
                  Cancel
                </button>
                {exporting.progress?.phase === 'partial' && (
                  <button
                    onClick={() => {
                      if (!composing.current) exporting.confirm();
                    }}
                  >
                    Export {exporting.progress.count} diagrams…
                  </button>
                )}
              </div>
            ) : undefined
          }
          composing={composing}
          origin={origin}
          fallback={focusReading}
          initialControl={surface === 'settings'}
          initialInput={surface === 'quick-open'}
          className={surface === 'guide' ? 'guide-dialog' : undefined}
        >
          {commandMessage && <p role="status">{commandMessage}</p>}
          {surface === 'quick-open' ? (
            <QuickOpen
              model={picker}
              navigation={navigation}
              composing={composing}
              input={pickerInput}
              accept={acceptPickerFile}
              choose={(kind) => {
                void chooseFromPicker(kind);
              }}
            />
          ) : surface === 'export' ? (
            <>
              <p>{document?.snapshot.name}</p>
              <p
                role="status"
                aria-busy={exporting.progress?.phase === 'preparing'}
              >
                {exporting.progress?.message}
              </p>
              {exporting.progress?.mode === 'svg' && (
                <p>
                  SVG files may reference resources another viewer can load.
                </p>
              )}
            </>
          ) : surface === 'settings' ? (
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
              <p>taurimd {version}</p>
              <p>Copyright © 2026 Chrysent. MIT licensed.</p>
              <p>
                Dependency distribution notices and native platform
                qualification remain separate checks.
              </p>
            </>
          )}
        </TemporaryDialog>
      )}
      <div className="workspace">
        <aside
          hidden={!settings.sidebarDefault}
          className="navigation"
          aria-label="Document navigation"
          ref={sidebarRef}
        >
          <Navigation
            controller={navigation}
            document={document}
            disabled={
              busy ||
              surface !== null ||
              exporting.progress !== null ||
              navigationState.choosing ||
              composition
            }
            allow={allowNavigation}
            open={openNavigation}
            jump={jump}
            visible={settings.sidebarDefault}
            siblingGroupRef={siblingGroupRef}
            section={section}
          />
        </aside>
        <div className="reading-pane">
          {findOpen && (
            <FindBar
              input={findInput}
              query={query}
              result={findResult}
              composing={composing}
              change={(value) => {
                findQuery.current = value;
                setQuery(value);
                finder.current?.search(value);
              }}
              move={(direction) => {
                if (!composing.current) finder.current?.move(direction);
              }}
              close={() => {
                if (!composing.current) closeFind();
              }}
            />
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
                  className={
                    state.quietLink && linkFeedback?.document !== document
                      ? 'link-feedback sr-only'
                      : 'link-feedback'
                  }
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
                    <p className="empty" data-reader-empty>
                      This file is empty.
                    </p>
                  ) : document.html === null ? (
                    <pre key={document.requestId} className="literal">
                      {document.snapshot.source}
                    </pre>
                  ) : (
                    <div dangerouslySetInnerHTML={readingHTML} />
                  )}
                </article>
              </>
            )}
          </main>
        </div>
      </div>
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
