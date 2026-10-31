import { invoke } from '@tauri-apps/api/core';

export interface MenuPresentation {
  statusVisible: boolean;
  busy: boolean;
  modal: 'none' | 'settings' | 'other';
  composing: boolean;
  pageZoom: number;
}
let sequence = 0;
export function syncMenu(presentation: MenuPresentation) {
  return invoke<null>('present_reader', {
    presentation: { ...presentation, sequence: ++sequence },
  });
}
