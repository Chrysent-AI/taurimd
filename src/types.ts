export interface Snapshot {
  documentId: number;
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
export interface NativeReader {
  select(requestId: number): Promise<Selection>;
  reload(requestId: number, document: Snapshot): Promise<Snapshot>;
  commit(requestId: number): Promise<void>;
  cancel(requestId: number): Promise<void>;
}
export interface Rendered {
  snapshot: Snapshot;
  html: string | null;
}
export interface ReaderState {
  displayed: Rendered | null;
  phase: 'empty' | 'loading' | 'parsing' | 'committing' | 'ready' | 'error';
  message: string;
  stale: boolean;
}
