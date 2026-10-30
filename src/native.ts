import { invoke } from '@tauri-apps/api/core';
import type { NativeReader, Selection, Snapshot } from './types';
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
