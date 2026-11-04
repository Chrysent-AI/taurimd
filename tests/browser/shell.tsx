import mermaid from 'mermaid';
import { createRoot } from 'react-dom/client';
import {
  clearMocks,
  mockIPC,
  mockWindows,
  mockConvertFileSrc,
} from '@tauri-apps/api/mocks';
import type { invoke } from '@tauri-apps/api/core';
import { emit, emitTo, type Event } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  FixtureEvents,
  type EventIPC,
  type ReaderEvent,
} from './event-transport';
import { App } from '../../src/App';
import { ReaderController } from '../../src/controller';
import { native, type DocumentRequest } from '../../src/native';
import type { Snapshot } from '../../src/types';
import { parseInWorker } from '../../src/reader/worker';
import type { MenuPresentation } from '../../src/presentation';
import type {
  Siblings,
  FileIndex,
  IndexSnapshot,
  QueryRequest,
  QueryReply,
} from '../../src/navigation/types';
import type { AppError } from '../../src/types';
import {
  defaults,
  type SettingsRecord,
  type SettingsPatch,
} from '../../src/settings/model';
import type { RemoteBinding } from '../../src/types';

type Command =
  | 'pending_document'
  | 'receive_document'
  | 'dismiss_document'
  | 'get_index'
  | 'query_index'
  | 'complete_path'
  | 'refresh_index'
  | 'get_siblings'
  | 'open_index_entry'
  | 'reveal_document'
  | 'select_document'
  | 'reload_document'
  | 'commit_document'
  | 'cancel_operation'
  | 'get_settings'
  | 'update_settings'
  | 'resolve_media'
  | 'cancel_remote_image'
  | 'present_reader'
  | 'activate_link'
  | 'begin_export'
  | 'append_export_image'
  | 'finish_export'
  | 'cancel_export';
type Outcome = { value: unknown } | { error: AppError };
type Reply = Outcome | { hold: string };
interface Call {
  command: Command;
  payload: unknown;
}
const openings: { command: string; dialog: boolean; focused: string | null }[] =
  [];
const calls: Call[] = [];
const settled: Command[] = [];
const replies = new Map<Command, Reply[]>();
const remoteReplies: Outcome[] = [];
const pending = new Map<string, (outcome: Outcome) => void>();
let indexSequence = 0;
function indexSnapshot(
  index: FileIndex | null,
  phase: IndexSnapshot['status']['phase'] = index
    ? index.issues.length
      ? 'partial'
      : 'ready'
    : '',
  message = '',
): IndexSnapshot {
  return {
    index,
    status: {
      sequence: ++indexSequence,
      scope: index?.scope ?? 0,
      revision: index?.revision ?? 0,
      phase,
      degraded: false,
      message,
      scans: index?.revision ?? 0,
      traversals: 0,
      entries: index?.entries.length ?? 0,
    },
  };
}
let cachedIndex = indexSnapshot(null);
// The working folder the double installs when a document commit adopts it,
// mirroring how the native side establishes the watched root at file open.
// A null value keeps the cached index untouched, so reader-only flows can
// open documents without populating the explorer.
let workingFolder: FileIndex | null = null;
function queryReply(request: QueryRequest): QueryReply {
  // Matching here is only a transport double; native policy is tested in Rust.
  const outside =
    request.text.startsWith('/') ||
    request.text.startsWith('~') ||
    request.text.startsWith('..');
  const source = cachedIndex.index;
  const results = (source?.entries ?? [])
    .flatMap((entry) => {
      const characters = Array.from(entry.relative);
      const positions: number[] = [];
      let offset = 0;
      for (const char of request.text.toLowerCase()) {
        const found = characters.findIndex(
          (candidate, index) =>
            index >= offset && candidate.toLowerCase() === char,
        );
        if (found < 0) return [];
        positions.push(found);
        offset = found + 1;
      }
      return [{ entry, positions }];
    })
    .sort(
      (a, b) =>
        Number(a.entry.kind !== 'directory') -
          Number(b.entry.kind !== 'directory') ||
        a.entry.alphaRank - b.entry.alphaRank,
    );
  return {
    ...request,
    status: outside ? 'authorizationRequired' : 'ready',
    location: '.',
    total: outside ? 0 : results.length,
    results: outside ? [] : results.slice(0, 100),
    message: '',
  };
}
let parses = 0;
let workerParses = 0;
let siblingReply: Siblings = {
  index: { scope: 1, revision: 1, name: 'fixture', entries: [], issues: [] },
  active: null,
  rootActive: null,
  inRoot: false,
};
const diagramRenders: { id: string; config: unknown }[] = [];
let diagramInitializations = 0;
let diagramBindings = 0;
let diagramConfig: unknown;
let holdDiagram = false;
let releaseDiagram: (() => void) | undefined;
const initializeDiagram = mermaid.initialize;
mermaid.initialize = (config) => {
  diagramInitializations++;
  diagramConfig = structuredClone(config);
  initializeDiagram(config);
};
const renderDiagram = mermaid.render;
mermaid.render = async (id, source, container) => {
  diagramRenders.push({
    id,
    config: diagramConfig,
  });
  if (holdDiagram) {
    holdDiagram = false;
    await new Promise<void>((resolve) => {
      releaseDiagram = resolve;
    });
    releaseDiagram = undefined;
  }
  const result = await renderDiagram(id, source, container);
  return {
    ...result,
    bindFunctions: (element) => {
      diagramBindings++;
      result.bindFunctions?.(element);
    },
  };
};
let workerMode: 'normal' | 'fail' | 'hold' = 'normal';
const activeWorkers = new Set<Worker>();
class ObservedWorker extends Worker {
  private mode = workerMode;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workerMode = 'normal';
    activeWorkers.add(this);
  }
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(
    message: unknown,
    options?: StructuredSerializeOptions,
  ): void;
  override postMessage(
    message: unknown,
    options: Transferable[] | StructuredSerializeOptions = [],
  ): void {
    workerParses++;
    if (this.mode === 'hold') return;
    if (this.mode === 'fail') {
      queueMicrotask(() => {
        this.dispatchEvent(new ErrorEvent('error'));
      });
      return;
    }
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
  override terminate() {
    activeWorkers.delete(this);
    super.terminate();
  }
}
window.Worker = ObservedWorker;
let exportId = 0;
let presentation: (MenuPresentation & { sequence: number }) | null = null;
let settings: SettingsRecord = (JSON.parse(
  sessionStorage.getItem('mock-preferences') ?? 'null',
) as SettingsRecord | null) ?? {
  version: 1,
  revision: 0,
  settings: { ...defaults },
  notice: null,
};
function retain(record: SettingsRecord) {
  if (record.revision >= settings.revision) {
    settings = structuredClone(record);
    sessionStorage.setItem('mock-preferences', JSON.stringify(settings));
  }
}

// The browser-only double of the native remote-image owner. It answers a
// remote resolution from the same committed host list the Settings dialog
// writes, so an unpermitted host is denied before any request is made.
const remoteImageId = '0'.repeat(31) + '9';
function remoteHost(reference: string) {
  const rest = reference.replace(/^https:\/\//i, '');
  const end = rest.search(/[/?#]/);
  return (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
}
function remoteOutcome(payload: unknown) {
  const request = payload as {
    relativeReference: string;
    remoteBinding: RemoteBinding;
  };
  const host = remoteHost(request.relativeReference);
  if (!settings.settings.remoteImageHosts.includes(host)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects a command with the serialized AppError DTO.
    throw {
      code: 'blockedHost',
      message: `Image blocked — ${host} is not permitted. Manage hosts in Settings.`,
    };
  }
  return {
    id: remoteImageId,
    mime: 'image/svg+xml',
    hosts: [host],
    slot: request.remoteBinding.slot,
    attempt: request.remoteBinding.attempt,
  };
}

// This is a browser-only backend double. It does not read files or emulate
// native grants, permissions, menus, dialogs or source-byte preservation.
let incoming: DocumentRequest | null = new URL(location.href).searchParams.has(
  'cold-document',
)
  ? { kind: 'open', token: 1 }
  : null;
let received: { snapshot: Snapshot; fragment: string | null } | null = incoming
  ? {
      snapshot: {
        documentId: 1,
        revision: 1,
        name: 'cold.md',
        location: 'fixture/cold.md',
        format: 'markdown',
        source:
          '# Cold document\n\n## Section\n\n```mermaid\nflowchart LR\n A --> B\n```',
      },
      fragment: 'section',
    }
  : null;
let menuSequence = 0;
mockWindows(new URL(location.href).searchParams.get('reader') ?? 'reader-1');
const eventBroker = new FixtureEvents();
const eventOwner = {};
const eventCalls: EventIPC[] = [];
const eventMetadata = () => ({
  currentWindow: { label: getCurrentWindow().label },
  currentWebview: { label: getCurrentWebview().label },
});
function deliverEvent(callback: number, event: Event<unknown>) {
  const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
  if (typeof internals !== 'object' || internals === null)
    throw new Error('Missing installed event bridge');
  const deliver: unknown = Reflect.get(internals, 'runCallback');
  if (typeof deliver !== 'function')
    throw new Error('Installed event callback bridge unavailable');
  (deliver as (id: number, value: Event<unknown>) => void)(callback, event);
}
function nativeEvent(event: ReaderEvent, payload: unknown) {
  if (window.readerEventIPC)
    return window.readerEventIPC({
      command: 'fixture:native_emit',
      payload: { event, payload },
      metadata: eventMetadata(),
    });
  return emitTo(
    { kind: 'WebviewWindow', label: eventMetadata().currentWindow.label },
    event,
    payload,
  );
}
// Browser-only HTTP transport double. Production uses the same convertFileSrc
// adapter with the native runtime's platform mapping, not this mock setting.
mockConvertFileSrc('windows');
mockIPC(async (command, payload) => {
  if (command.startsWith('plugin:event|')) {
    const request = { command, payload, metadata: eventMetadata() };
    eventCalls.push(structuredClone(request));
    return window.readerEventIPC
      ? window.readerEventIPC(request)
      : eventBroker.invoke(eventOwner, request, deliverEvent);
  }
  if (
    ![
      'pending_document',
      'receive_document',
      'dismiss_document',
      'get_index',
      'query_index',
      'complete_path',
      'refresh_index',
      'get_siblings',
      'open_index_entry',
      'reveal_document',
      'select_document',
      'reload_document',
      'commit_document',
      'cancel_operation',
      'get_settings',
      'update_settings',
      'resolve_media',
      'cancel_remote_image',
      'activate_link',
      'present_reader',
      'begin_export',
      'append_export_image',
      'finish_export',
      'cancel_export',
    ].includes(command)
  )
    throw new Error(`Unexpected fixture command: ${command}`);
  const name = command as Command;
  if (name === 'open_index_entry' || name === 'select_document')
    openings.push({
      command: name,
      dialog: !!document.querySelector('dialog[open]'),
      focused:
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.tagName ??
        null,
    });
  calls.push({ command: name, payload: structuredClone(payload) });
  try {
    const binding =
      name === 'resolve_media'
        ? (payload as { remoteBinding?: RemoteBinding }).remoteBinding
        : undefined;
    // A remote resolution owns its own queue: the local media queue keeps
    // its exact order.
    const reply = binding ? undefined : replies.get(name)?.shift();
    const applyPresentation = () => {
      const next = (
        payload as { presentation: MenuPresentation & { sequence: number } }
      ).presentation;
      if (!presentation || next.sequence > presentation.sequence)
        presentation = structuredClone(next);
    };
    if (!reply && name === 'pending_document') return structuredClone(incoming);
    if (!reply && name === 'dismiss_document') {
      incoming = null;
      return null;
    }
    if (name === 'receive_document') {
      if (
        !incoming ||
        incoming.kind !== 'open' ||
        (payload as { token: number }).token !== incoming.token
      )
        throw new Error('Stale incoming request');
      incoming = null;
      if (!reply && received) return structuredClone(received);
    }
    if (!reply && name === 'get_index') return structuredClone(cachedIndex);
    if (!reply && (name === 'query_index' || name === 'complete_path'))
      return queryReply((payload as { request: QueryRequest }).request);
    if (!reply && name === 'get_siblings') return structuredClone(siblingReply);
    if (!reply && name === 'reveal_document') return null;
    if (!reply && name === 'begin_export') return ++exportId;
    if (!reply && (name === 'append_export_image' || name === 'cancel_export'))
      return null;
    if (!reply && name === 'finish_export') return { status: 'cancelled' };
    if (!reply && name === 'present_reader') {
      applyPresentation();
      return null;
    }
    if (!reply && name === 'cancel_operation') return null;
    if (!reply && name === 'commit_document') {
      // The native side adopts the committed document's folder as the
      // watched working folder and announces it through index_status.
      if (workingFolder) {
        cachedIndex = indexSnapshot(workingFolder);
        await nativeEvent('index_status', cachedIndex.status);
      }
      return null;
    }
    if (!reply && name === 'get_settings') return structuredClone(settings);
    if (!reply && name === 'cancel_remote_image') return null;
    if (!reply && name === 'resolve_media' && binding) {
      const queued = remoteReplies.shift();
      if (queued) {
        if ('error' in queued) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects a command with the serialized AppError DTO.
          throw queued.error;
        }
        return structuredClone(queued.value);
      }
      return remoteOutcome(payload);
    }
    if (!reply && name === 'update_settings') {
      const args = payload as {
        expectedRevision: number;
        patch: SettingsPatch;
      };
      if (args.expectedRevision !== settings.revision)
        return { status: 'conflict', record: structuredClone(settings) };
      retain({
        version: 1,
        revision: settings.revision + 1,
        settings: { ...settings.settings, ...args.patch },
        notice: null,
      });
      await emit('settings_changed', structuredClone(settings));
      return { status: 'committed', record: structuredClone(settings) };
    }
    if (!reply) throw new Error(`Queue a backend response for ${name}`);
    const outcome =
      'hold' in reply
        ? await new Promise<Outcome>((resolve) => {
            pending.set(reply.hold, resolve);
          })
        : reply;
    if ('error' in outcome) {
      // Tauri rejects commands with the serialized AppError DTO, not a JS Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw outcome.error;
    }
    if (name === 'refresh_index')
      cachedIndex = structuredClone(outcome.value as IndexSnapshot);
    if (name === 'present_reader') applyPresentation();
    if (
      name === 'open_index_entry' &&
      typeof outcome.value === 'object' &&
      outcome.value !== null &&
      'documentId' in outcome.value
    )
      return { status: 'ready', snapshot: structuredClone(outcome.value) };
    return structuredClone(outcome.value);
  } finally {
    settled.push(name);
  }
});

// Failure injection stays in the browser's transport double; the App still
// subscribes through the installed event API and renders its real recovery UI.
const subscriptionFailures = new URL(location.href).searchParams;
if (
  '__TAURI_INTERNALS__' in window &&
  (subscriptionFailures.has('menu-failure') ||
    subscriptionFailures.has('index-failure'))
) {
  const internals = window.__TAURI_INTERNALS__ as {
    invoke: typeof invoke;
    unregisterCallback: (id: number) => void;
  };
  const original = internals.invoke;
  internals.invoke = (command, args, options) => {
    if (
      command === 'plugin:event|listen' &&
      args &&
      'event' in args &&
      ((args.event === 'menu_action' &&
        subscriptionFailures.has('menu-failure')) ||
        (args.event === 'index_status' &&
          subscriptionFailures.has('index-failure')))
    ) {
      if ('handler' in args && typeof args.handler === 'number')
        internals.unregisterCallback(args.handler);
      return Promise.reject(
        new Error(
          args.event === 'index_status'
            ? 'Browser-only index subscription failure'
            : 'Browser-only menu subscription failure',
        ),
      );
    }
    return original(command, args, options);
  };
}

const controller = new ReaderController(native, (source, snapshot) => {
  parses += 1;
  return parseInWorker(source, snapshot);
});
const container = document.getElementById('root');
if (!container) throw new Error('Fixture root missing');
const root = createRoot(container);
let mounted = true;
root.render(<App controller={controller} />);
function unmount() {
  if (!mounted) return;
  mounted = false;
  root.unmount();
  controller.dispose();
}
function listenerCount() {
  // The installed mock stores real event API callbacks in this map. Inspect
  // only callback count, not a substitute application event dispatcher.
  if ('__TAURI_INTERNALS__' in window) {
    const internals = window.__TAURI_INTERNALS__;
    if (
      typeof internals === 'object' &&
      internals !== null &&
      'callbacks' in internals &&
      internals.callbacks instanceof Map
    )
      return internals.callbacks.size;
  }
  return 0;
}
const fixture = {
  deliverEvent,
  eventCalls: () => structuredClone(eventCalls),
  readerNotice: (message: string) => nativeEvent('reader_notice', message),
  documentRequest: (request: DocumentRequest, document?: Snapshot) => {
    incoming = structuredClone(request);
    received = document
      ? { snapshot: structuredClone(document), fragment: null }
      : null;
    return nativeEvent('document_requested', null);
  },
  documentCalls: () =>
    structuredClone(
      calls.filter((call) =>
        ['pending_document', 'receive_document', 'dismiss_document'].includes(
          call.command,
        ),
      ),
    ),
  menuEnvelope: (actionId: string, sequence: number) =>
    nativeEvent('menu_action', { actionId, sequence }),
  openings: () => structuredClone(openings),
  indexSnapshot,
  queryReply,
  indexEvent: async (snapshot: IndexSnapshot) => {
    cachedIndex = structuredClone(snapshot);
    await nativeEvent('index_status', snapshot.status);
  },
  nativeIndex: () => structuredClone(cachedIndex),
  indexGets: () => calls.filter((call) => call.command === 'get_index').length,
  setSiblings: (value: Siblings) => {
    siblingReply = structuredClone(value);
  },
  workingFolder: (value: FileIndex | null) => {
    workingFolder = value === null ? null : structuredClone(value);
  },
  workerParses: () => workerParses,
  enqueue(command: Command, reply: Reply) {
    const queue = replies.get(command) ?? [];
    queue.push(reply);
    replies.set(command, queue);
  },
  enqueueRemote(reply: Outcome) {
    remoteReplies.push(reply);
  },
  release(key: string, outcome: Outcome) {
    const resolve = pending.get(key);
    if (!resolve) throw new Error(`No pending response: ${key}`);
    pending.delete(key);
    resolve(outcome);
  },
  navigationCalls: () =>
    structuredClone(
      calls.filter((call) =>
        [
          'refresh_index',
          'get_siblings',
          'open_index_entry',
          'reveal_document',
        ].includes(call.command),
      ),
    ),
  calls: () =>
    structuredClone(
      calls.filter(
        (call) =>
          call.command !== 'pending_document' &&
          call.command !== 'get_index' &&
          call.command !== 'get_siblings' &&
          call.command !== 'get_settings' &&
          call.command !== 'update_settings' &&
          call.command !== 'present_reader',
      ),
    ),
  presentation: () => structuredClone(presentation),
  presentationCalls: () =>
    structuredClone(calls.filter((call) => call.command === 'present_reader')),
  workerMode: (mode: typeof workerMode) => {
    workerMode = mode;
  },
  activeWorkers: () => activeWorkers.size,
  settingsCalls: () =>
    structuredClone(
      calls.filter(
        (call) =>
          call.command === 'get_settings' || call.command === 'update_settings',
      ),
    ),
  settings: () => structuredClone(settings),
  retain,
  settingsEvent: (record: SettingsRecord) => {
    retain(record);
    return emit('settings_changed', record);
  },
  settled: () => [...settled],
  diagrams: () => ({
    renders: structuredClone(diagramRenders),
    initializations: diagramInitializations,
    bindings: diagramBindings,
    held: !!releaseDiagram,
  }),
  holdDiagram: () => {
    holdDiagram = true;
  },
  releaseDiagram: () => {
    releaseDiagram?.();
  },
  parses: () => parses,
  pending: () => [...pending.keys()],
  listenerCount,
  menu: (
    action:
      | 'appearance-system'
      | 'appearance-light'
      | 'appearance-dark'
      | 'fit-diagrams'
      | 'fit-view'
      | 'find'
      | 'find-next'
      | 'find-previous'
      | 'quick-open'
      | 'toc'
      | 'refresh-folder'
      | 'reveal'
      | 'sidebar'
      | 'sort-name'
      | 'sort-modified'
      | 'sort-size'
      | 'sort-asc'
      | 'sort-desc'
      | 'previous'
      | 'next'
      | 'first'
      | 'last'
      | 'open'
      | 'reload'
      | 'settings'
      | 'zoom-in'
      | 'zoom-out'
      | 'zoom-reset'
      | 'status-bar'
      | 'guide'
      | 'information'
      | 'about'
      | 'export-svg'
      | 'export-png',
  ) =>
    nativeEvent('menu_action', { actionId: action, sequence: ++menuSequence }),
  state: () => controller.getState(),
  unmount,
  cleanup() {
    releaseDiagram?.();
    unmount();
    for (const resolve of pending.values())
      resolve({ error: { code: 'stale', message: 'Browser fixture closed' } });
    pending.clear();
    for (const worker of activeWorkers) worker.terminate();
    clearMocks();
    eventBroker.removeOwner(eventOwner);
  },
};
declare global {
  interface Window {
    readerFixture: typeof fixture;
    readerEventIPC?: (request: EventIPC) => Promise<unknown>;
  }
}
window.readerFixture = fixture;
window.addEventListener(
  'pagehide',
  () => {
    fixture.cleanup();
  },
  { once: true },
);
