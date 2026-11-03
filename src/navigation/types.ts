import type { Snapshot } from '../types';
import type { Heading } from '../reader/parse';
import type { FileSortDirection, FileSortKey } from '../settings/model';
export type { FileSortDirection, FileSortKey };
export interface EntryBinding {
  scope: number;
  revision: number;
  entry: number;
}
export interface FileEntry {
  id: number;
  uiId: number;
  parent: number | null;
  name: string;
  relative: string;
  kind: 'directory' | 'markdown' | 'text';
  context: number;
  alphaRank: number;
  dateRank: number | null;
  sizeRank: number | null;
}
export interface FileIndex {
  scope: number;
  revision: number;
  name: string;
  entries: FileEntry[];
  issues: { relative: string; code: string; message: string }[];
}
export interface Siblings {
  index: FileIndex;
  active: number | null;
  inRoot: boolean;
  rootActive: number | null;
}
export interface PickerScope {
  index: FileIndex | null;
  busy: boolean;
}
export interface EntryIntent {
  binding: EntryBinding;
  name: string;
  focus: 'start' | 'preserve' | 'heading';
  preview?: Snapshot;
  key?: number;
}
export interface Preview {
  phase: 'loading' | 'ready' | 'error';
  headings: Heading[];
  snapshot?: Snapshot;
  message?: string;
}
export interface IndexStatus {
  sequence: number;
  scope: number;
  revision: number;
  phase: '' | 'loading' | 'ready' | 'partial' | 'unavailable';
  degraded: boolean;
  message: string;
  scans: number;
  traversals: number;
  entries: number;
}
export interface IndexSnapshot {
  index: FileIndex | null;
  status: IndexStatus;
}
export interface QueryRequest {
  scope: number;
  revision: number;
  queryId: number;
  text: string;
  directory?: number;
}
export interface QueryReply extends QueryRequest {
  status:
    | 'ready'
    | 'indexing'
    | 'authorizationRequired'
    | 'missing'
    | 'unavailable';
  location: string;
  results: { entry: FileEntry; positions: number[] }[];
  total: number;
  message: string;
}
export interface NavigationBridge {
  get(): Promise<IndexSnapshot>;
  listen(receive: (status: IndexStatus) => void): Promise<() => void>;
  query(request: QueryRequest): Promise<QueryReply>;
  complete(request: QueryRequest): Promise<QueryReply>;
  choose(
    requestId: number,
  ): Promise<
    { status: 'cancelled' } | { status: 'ready'; snapshot: IndexSnapshot }
  >;
  refresh(scopeId: number): Promise<IndexSnapshot>;
  siblings(document: Snapshot): Promise<Siblings>;
  // `reuse` adopts the native scope already published by a directory
  // traversal instead of rescanning it away; overlay opens omit it.
  quickScope(document: Snapshot, reuse?: boolean): Promise<FileIndex>;
  preview(binding: EntryBinding, requestId: number): Promise<Snapshot>;
  cancelPreview(requestId: number): Promise<unknown>;
  reveal(document: Snapshot): Promise<unknown>;
}
export function binding(index: FileIndex, entry: FileEntry): EntryBinding {
  return { scope: index.scope, revision: index.revision, entry: entry.id };
}
export interface SiblingTargets {
  previous?: FileEntry;
  next?: FileEntry;
  first?: FileEntry;
  last?: FileEntry;
}
// A missing native value sorts after every known value in both directions.
function knownRank(
  a: number | null,
  b: number | null,
  direction: FileSortDirection,
) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}
export function compareEntries(
  a: FileEntry,
  b: FileEntry,
  key: FileSortKey,
  direction: FileSortDirection,
) {
  const folderA = a.kind === 'directory';
  const folderB = b.kind === 'directory';
  if (folderA !== folderB) return folderA ? -1 : 1;
  if (folderA) {
    // Folders keep their native name order and never carry a byte total.
    return key === 'name' && direction === 'desc'
      ? b.alphaRank - a.alphaRank
      : a.alphaRank - b.alphaRank;
  }
  if (key === 'name')
    return direction === 'asc'
      ? a.alphaRank - b.alphaRank
      : b.alphaRank - a.alphaRank;
  const primary =
    key === 'modified'
      ? knownRank(a.dateRank, b.dateRank, direction)
      : knownRank(a.sizeRank, b.sizeRank, direction);
  if (primary !== 0) return primary;
  // Equal or missing metadata keeps the native name and path order.
  return a.alphaRank - b.alphaRank;
}
export function siblingTargets(
  siblings: Siblings | null,
  key: FileSortKey,
  direction: FileSortDirection,
): SiblingTargets {
  const entries =
    siblings?.index.entries
      .filter((entry) => entry.kind !== 'directory')
      .sort((a, b) => compareEntries(a, b, key, direction)) ?? [];
  const position = entries.findIndex((entry) => entry.id === siblings?.active);
  if (position < 0) return {};
  return {
    previous: position > 0 ? entries[position - 1] : undefined,
    next: position < entries.length - 1 ? entries[position + 1] : undefined,
    first: position > 0 ? entries[0] : undefined,
    last:
      position < entries.length - 1 ? entries[entries.length - 1] : undefined,
  };
}
