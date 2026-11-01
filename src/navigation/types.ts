import type { Snapshot } from '../types';
import type { Heading } from '../reader/parse';
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
  dateRank: number;
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
  preview(binding: EntryBinding, requestId: number): Promise<Snapshot>;
  cancelPreview(requestId: number): Promise<unknown>;
  reveal(document: Snapshot): Promise<unknown>;
}
export function binding(index: FileIndex, entry: FileEntry): EntryBinding {
  return { scope: index.scope, revision: index.revision, entry: entry.id };
}
export function neighbors(siblings: Siblings | null, newest: boolean) {
  const entries =
    siblings?.index.entries
      .filter((e) => e.kind !== 'directory')
      .sort((a, b) =>
        newest ? a.dateRank - b.dateRank : a.alphaRank - b.alphaRank,
      ) ?? [];
  const position = entries.findIndex((e) => e.id === siblings?.active);
  return {
    previous: position > 0 ? entries[position - 1] : undefined,
    next: position >= 0 ? entries[position + 1] : undefined,
  };
}
