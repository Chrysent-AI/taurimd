import { invoke } from '@tauri-apps/api/core';

export interface MenuPresentation {
  findAvailable: boolean;
  findMatches: boolean;
  statusVisible: boolean;
  sidebarVisible: boolean;
  hasRoot: boolean;
  previous: boolean;
  next: boolean;
  newest: boolean;
  busy: boolean;
  modal: 'none' | 'settings' | 'quickOpen' | 'other';
  composing: boolean;
  pageZoom: number;
}
let sequence = 0;
export function syncMenu(presentation: MenuPresentation) {
  return invoke<null>('present_reader', {
    presentation: { ...presentation, sequence: ++sequence },
  });
}
