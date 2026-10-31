import type { EntryIntent, EntryBinding } from './navigation/types';
import type { Reading } from './reader/parse';
export interface Snapshot {
  documentId: number;
  contextId?: number;
  revision: number;
  name: string;
  location: string;
  format: 'markdown' | 'text';
  source: string;
}
export interface AppError {
  code: string;
  message: string;
  attempted?: string | null;
}
export type Selection =
  | { status: 'cancelled' }
  | { status: 'ready'; snapshot: Snapshot };
export type Activation =
  | { status: 'externalOpened' }
  | { status: 'anchor'; fragment: string }
  | { status: 'document'; snapshot: Snapshot; fragment: string | null };
export interface ResolvedMedia {
  id: string;
  mime: string;
}
export interface NativeReader {
  openEntry(requestId: number, binding: EntryBinding): Promise<Snapshot>;
  select(requestId: number): Promise<Selection>;
  reload(requestId: number, document: Snapshot): Promise<Snapshot>;
  commit(requestId: number): Promise<void>;
  cancel(requestId: number): Promise<void>;
  resolve(document: Snapshot, reference: string): Promise<ResolvedMedia>;
  activate(
    requestId: number,
    document: Snapshot,
    href: string,
  ): Promise<Activation>;
}
export interface Rendered extends Omit<Reading, 'html'> {
  requestId?: number;
  snapshot: Snapshot;
  html: string | null;
  fragment?: string | null;
  focus?: EntryIntent['focus'];
  headingKey?: number;
  previewChanged?: boolean;
}
export interface ReaderState {
  requestId: number;
  displayed: Rendered | null;
  phase: 'empty' | 'loading' | 'parsing' | 'committing' | 'ready' | 'error';
  message: string;
  stale: boolean;
  linkMessage?: string;
  previewEpoch?: number;
}
