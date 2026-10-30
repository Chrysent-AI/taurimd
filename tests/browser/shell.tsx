import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { App } from '../../src/App';
import { ReaderController } from '../../src/controller';
import { native } from '../../src/native';
import { parseInWorker } from '../../src/reader/worker';
import type { AppError } from '../../src/types';
import {
  defaults,
  type SettingsRecord,
  type SettingsPatch,
} from '../../src/settings/model';

type Command =
  | 'select_document'
  | 'reload_document'
  | 'commit_document'
  | 'cancel_operation'
  | 'get_settings'
  | 'update_settings';
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
mockIPC(
  async (command, payload) => {
    if (
      ![
        'select_document',
        'reload_document',
        'commit_document',
        'cancel_operation',
        'get_settings',
        'update_settings',
      ].includes(command)
    )
      throw new Error(`Unexpected fixture command: ${command}`);
    const name = command as Command;
    calls.push({ command: name, payload: structuredClone(payload) });
    try {
      const reply = replies.get(name)?.shift();
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
      return structuredClone(outcome.value);
    } finally {
      settled.push(name);
    }
  },
  { shouldMockEvents: true },
);

const controller = new ReaderController(native, (source) => {
  parses += 1;
  return parseInWorker(source);
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
  calls: () =>
    structuredClone(
      calls.filter(
        (call) =>
          call.command !== 'get_settings' && call.command !== 'update_settings',
      ),
    ),
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
  parses: () => parses,
  pending: () => [...pending.keys()],
  listenerCount,
  menu: (
    action:
      | 'open'
      | 'reload'
      | 'settings'
      | 'zoom-in'
      | 'zoom-out'
      | 'zoom-reset',
  ) => emit('menu_action', action),
  state: () => controller.getState(),
  unmount,
  cleanup() {
    unmount();
    for (const resolve of pending.values())
      resolve({ error: { code: 'stale', message: 'Browser fixture closed' } });
    pending.clear();
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
