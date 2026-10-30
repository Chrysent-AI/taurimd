import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  SettingsBridge,
  SettingsRecord,
  SettingsUpdate,
} from './settings/model';
import type { NativeReader, Selection, Snapshot } from './types';
export const preferences: SettingsBridge = {
  get: () => invoke<SettingsRecord>('get_settings'),
  update: (expectedRevision, patch) =>
    invoke<SettingsUpdate>('update_settings', { expectedRevision, patch }),
  listen: (receive) =>
    listen<SettingsRecord>('settings_changed', ({ payload }) => {
      receive(payload);
    }),
};
export const native: NativeReader = {
  select: (requestId) => invoke<Selection>('select_document', { requestId }),
  reload: (requestId, document) =>
    invoke<Snapshot>('reload_document', {
      requestId,
      documentId: document.documentId,
      revision: document.revision,
    }),
  commit: (requestId) => invoke('commit_document', { requestId }),
  cancel: (requestId) => invoke('cancel_operation', { requestId }),
};
