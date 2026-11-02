import type { NavigationBridge, EntryBinding } from './navigation/types';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  SettingsBridge,
  SettingsRecord,
  SettingsUpdate,
} from './settings/model';
import type {
  AppError,
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
  get: () => invoke('get_index'),
  listen: (receive) =>
    getCurrentWebviewWindow().listen<import('./navigation/types').IndexStatus>(
      'index_status',
      ({ payload }) => {
        receive(payload);
      },
    ),
  query: (request) => invoke('query_index', { request }),
  complete: (request) => invoke('complete_path', { request }),
  choose: (requestId) => invoke('select_root', { requestId }),
  refresh: (scopeId) => invoke('refresh_index', { scopeId }),
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
export type DocumentRequest =
  | { kind: 'open'; token: number }
  | {
      kind: 'focus';
      token: number;
      document_id: number;
      revision: number;
      fragment: string | null;
    }
  | { kind: 'error'; token: number; error: AppError };
export const documentRequests = {
  pending: () => invoke<DocumentRequest | null>('pending_document'),
  receive: (token: number, requestId: number) =>
    invoke<{ snapshot: Snapshot; fragment: string | null }>(
      'receive_document',
      { token, requestId },
    ),
  dismiss: (token: number) => invoke<null>('dismiss_document', { token }),
};
export const native: NativeReader = {
  openEntry: async (
    requestId: number,
    binding: EntryBinding,
    newWindow = false,
  ) => {
    const result = await invoke<
      { status: 'ready'; snapshot: Snapshot } | { status: 'handedOff' }
    >('open_index_entry', { requestId, binding, newWindow });
    return result.status === 'ready' ? result.snapshot : result;
  },
  select: (requestId) => invoke<Selection>('select_document', { requestId }),
  reload: (requestId, document) =>
    invoke<Snapshot>('reload_document', {
      requestId,
      documentId: document.documentId,
      revision: document.revision,
    }),
  commit: (requestId) => invoke('commit_document', { requestId }),
  cancel: (requestId) => invoke('cancel_operation', { requestId }),
  resolve: (document, relativeReference, binding) =>
    invoke<ResolvedMedia>('resolve_media', {
      documentId: document.documentId,
      revision: document.revision,
      relativeReference,
      // A local resolution keeps its exact payload; a remote one carries the
      // application-owned binding and the address travels separately.
      ...(binding ? { remoteBinding: binding } : {}),
    }),
  cancelRemote: (document, slot, attempt) =>
    invoke<null>('cancel_remote_image', {
      documentId: document.documentId,
      revision: document.revision,
      slot,
      attempt,
    }),
  activate: (requestId, document, href) =>
    invoke<Activation>('activate_link', {
      requestId,
      documentId: document.documentId,
      revision: document.revision,
      href,
    }),
};
