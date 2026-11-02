import { invoke } from '@tauri-apps/api/core';
import type { FileSortDirection, FileSortKey } from './settings/model';

export interface MenuPresentation {
  findAvailable: boolean;
  findMatches: boolean;
  statusVisible: boolean;
  sidebarVisible: boolean;
  hasRoot: boolean;
  previous: boolean;
  next: boolean;
  first: boolean;
  last: boolean;
  fileSortKey: FileSortKey;
  fileSortDirection: FileSortDirection;
  editing: boolean;
  busy: boolean;
  modal: 'none' | 'settings' | 'quickOpen' | 'other';
  composing: boolean;
  pageZoom: number;
  appearance: 'system' | 'light' | 'dark';
  fitDiagrams: boolean;
}
let sequence = 0;
export function syncMenu(presentation: MenuPresentation) {
  return invoke<null>('present_reader', {
    presentation: { ...presentation, sequence: ++sequence },
  });
}
