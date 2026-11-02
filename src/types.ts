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
  | { status: 'handedOff' }
  | { status: 'ready'; snapshot: Snapshot };
export type Activation =
  | { status: 'externalOpened' }
  | { status: 'anchor'; fragment: string }
  | { status: 'handedOff' };
export interface ResolvedMedia {
  id: string;
  mime: string;
  // A remote result also reports the canonical hosts that authorized it and
  // the attempt that produced it.
  hosts?: string[];
  slot?: string;
  attempt?: number;
}
// The application-owned binding of one remote image attempt. It carries no
// address: the reference travels separately and is authorized natively.
export interface RemoteBinding {
  slot: string;
  attempt: number;
}
export interface NativeReader {
  openEntry(
    requestId: number,
    binding: EntryBinding,
    newWindow?: boolean,
  ): Promise<Snapshot | { status: 'handedOff' }>;
  select(requestId: number): Promise<Selection>;
  reload(requestId: number, document: Snapshot): Promise<Snapshot>;
  commit(requestId: number): Promise<void>;
  cancel(requestId: number): Promise<void>;
  resolve(
    document: Snapshot,
    reference: string,
    binding?: RemoteBinding,
  ): Promise<ResolvedMedia>;
  // Retires one remote image attempt. The native side owns the attempt, so a
  // reader without it simply has nothing to retire.
  cancelRemote?(
    document: Snapshot,
    slot: string,
    attempt: number,
  ): Promise<null>;
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
  quietLink?: boolean;
  previewEpoch?: number;
}
