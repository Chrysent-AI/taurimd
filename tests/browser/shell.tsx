import mermaid from 'mermaid';
import { createRoot } from 'react-dom/client';
import {
  clearMocks,
  mockIPC,
  mockWindows,
  mockConvertFileSrc,
} from '@tauri-apps/api/mocks';
import type { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { App } from '../../src/App';
import { ReaderController } from '../../src/controller';
import { native } from '../../src/native';
import { parseInWorker } from '../../src/reader/worker';
import type { MenuPresentation } from '../../src/presentation';
import type { Siblings } from '../../src/navigation/types';
import type { AppError } from '../../src/types';
import {
  defaults,
  type SettingsRecord,
  type SettingsPatch,
} from '../../src/settings/model';

type Command =
  | 'select_root'
  | 'refresh_index'
  | 'get_siblings'
  | 'read_preview'
  | 'cancel_preview'
  | 'open_index_entry'
  | 'reveal_document'
  | 'select_document'
  | 'reload_document'
  | 'commit_document'
  | 'cancel_operation'
  | 'get_settings'
  | 'update_settings'
  | 'resolve_media'
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
const calls: Call[] = [];
const settled: Command[] = [];
const replies = new Map<Command, Reply[]>();
const pending = new Map<string, (outcome: Outcome) => void>();
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

// This is a browser-only backend double. It does not read files or emulate
// native grants, permissions, menus, dialogs or source-byte preservation.
mockWindows('reader');
// Browser-only HTTP transport double. Production uses the same convertFileSrc
// adapter with the native runtime's platform mapping, not this mock setting.
mockConvertFileSrc('windows');
mockIPC(
  async (command, payload) => {
    if (
      ![
        'select_root',
        'refresh_index',
        'get_siblings',
        'read_preview',
        'cancel_preview',
        'open_index_entry',
        'reveal_document',
        'select_document',
        'reload_document',
        'commit_document',
        'cancel_operation',
        'get_settings',
        'update_settings',
        'resolve_media',
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
    calls.push({ command: name, payload: structuredClone(payload) });
    try {
      const reply = replies.get(name)?.shift();
      const applyPresentation = () => {
        const next = (
          payload as { presentation: MenuPresentation & { sequence: number } }
        ).presentation;
        if (!presentation || next.sequence > presentation.sequence)
          presentation = structuredClone(next);
      };
      if (!reply && name === 'get_siblings')
        return structuredClone(siblingReply);
      if (!reply && (name === 'cancel_preview' || name === 'reveal_document'))
        return null;
      if (!reply && name === 'begin_export') return ++exportId;
      if (
        !reply &&
        (name === 'append_export_image' || name === 'cancel_export')
      )
        return null;
      if (!reply && name === 'finish_export') return { status: 'cancelled' };
      if (!reply && name === 'present_reader') {
        applyPresentation();
        return null;
      }
      if (!reply && (name === 'commit_document' || name === 'cancel_operation'))
        return null;
      if (!reply && name === 'get_settings') return structuredClone(settings);
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
      if (name === 'present_reader') applyPresentation();
      return structuredClone(outcome.value);
    } finally {
      settled.push(name);
    }
  },
  { shouldMockEvents: true },
);

// Failure injection stays in the browser's transport double; the App still
// subscribes through the installed event API and renders its real recovery UI.
if (
  '__TAURI_INTERNALS__' in window &&
  new URL(location.href).searchParams.has('menu-failure')
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
      args.event === 'menu_action'
    ) {
      if ('handler' in args && typeof args.handler === 'number')
        internals.unregisterCallback(args.handler);
      return Promise.reject(
        new Error('Browser-only menu subscription failure'),
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
  setSiblings: (value: Siblings) => {
    siblingReply = structuredClone(value);
  },
  workerParses: () => workerParses,
  enqueue(command: Command, reply: Reply) {
    const queue = replies.get(command) ?? [];
    queue.push(reply);
    replies.set(command, queue);
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
          'select_root',
          'refresh_index',
          'get_siblings',
          'read_preview',
          'cancel_preview',
          'open_index_entry',
          'reveal_document',
        ].includes(call.command),
      ),
    ),
  calls: () =>
    structuredClone(
      calls.filter(
        (call) =>
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
      | 'open-folder'
      | 'refresh-folder'
      | 'reveal'
      | 'sidebar'
      | 'sort-alpha'
      | 'sort-date'
      | 'previous'
      | 'next'
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
  ) => emit('menu_action', action),
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
  },
};
declare global {
  interface Window {
    readerFixture: typeof fixture;
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
