import type { NavigationBridge, EntryBinding } from './navigation/types';
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
import type { ExportMode } from './diagrams/export';
import type { Snapshot as ExportSnapshot } from './types';
export interface ExportBinding {
  exportId: number;
  documentId: number;
  revision: number;
  mode: ExportMode;
}
export type ExportOutcome =
  | { status: 'cancelled' }
  | { status: 'committed'; location: string; count: number };
export const diagramExport = {
  begin: (document: ExportSnapshot, mode: ExportMode, ordinals: number[]) =>
    invoke<number>('begin_export', {
      request: {
        documentId: document.documentId,
        revision: document.revision,
        mode,
        ordinals,
      },
    }),
  append: (binding: ExportBinding, ordinal: number, bytes: Uint8Array) =>
    invoke<null>('append_export_image', { image: { binding, ordinal, bytes } }),
  finish: (binding: ExportBinding) =>
    invoke<ExportOutcome>('finish_export', { binding }),
  cancel: (binding: ExportBinding) =>
    invoke<null>('cancel_export', { binding }),
};
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
export const navigation: NavigationBridge = {
  choose: (requestId) => invoke('select_root', { requestId }),
  refresh: (scopeId, requestId) =>
    invoke('refresh_index', { scopeId, requestId }),
  siblings: (document) =>
    invoke('get_siblings', {
      documentId: document.documentId,
      revision: document.revision,
    }),
  preview: (binding, requestId) =>
    invoke('read_preview', { binding, requestId }),
  cancelPreview: (requestId) => invoke('cancel_preview', { requestId }),
  reveal: (document) =>
    invoke('reveal_document', {
      documentId: document.documentId,
      revision: document.revision,
    }),
};
export const native: NativeReader = {
  openEntry: (requestId: number, binding: EntryBinding) =>
    invoke<Snapshot>('open_index_entry', { requestId, binding }),
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
