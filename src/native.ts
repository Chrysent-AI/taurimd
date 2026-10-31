import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  SettingsBridge,
  SettingsRecord,
  SettingsUpdate,
} from './settings/model';
import type {
  Activation,
  ResolvedMedia,
  NativeReader,
  Selection,
  Snapshot,
} from './types';
export const preferences: SettingsBridge = {
  get: () => invoke<SettingsRecord>('get_settings'),
  update: (expectedRevision, patch) =>
    invoke<SettingsUpdate>('update_settings', { expectedRevision, patch }),
  listen: (receive) =>
    listen<SettingsRecord>('settings_changed', ({ payload }) => {
      receive(payload);
    }),
};
export function mediaURL(value: ResolvedMedia) {
  if (
    !/^[a-f0-9]{32}$/.test(value.id) ||
    !/^(image|audio|video)\/[a-z0-9.+-]+$/.test(value.mime)
  )
    throw new Error('Invalid native media response.');
  return convertFileSrc(value.id, 'reader-media');
}
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
  resolve: (document, relativeReference) =>
    invoke<ResolvedMedia>('resolve_media', {
      documentId: document.documentId,
      revision: document.revision,
      relativeReference,
    }),
  activate: (requestId, document, href) =>
    invoke<Activation>('activate_link', {
      requestId,
      documentId: document.documentId,
      revision: document.revision,
      href,
    }),
};
