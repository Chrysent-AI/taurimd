import { parseInWorker } from '../reader/worker';
import type { ParseJob } from '../reader/worker';
import type { Rendered } from '../types';
import {
  binding,
  type FileIndex,
  type FileEntry,
  type NavigationBridge,
  type Preview,
  type Siblings,
} from './types';
interface NavigationState {
  root: FileIndex | null;
  choosing: boolean;
  rootBusy: boolean;
  rootStatus: 'none' | 'loading' | 'ready' | 'partial' | 'unavailable';
  rootMessage: string;
  message: string;
  error: boolean;
  siblings: Siblings | null;
  siblingDocument: Rendered | null;
  siblingMessage: string;
  previews: ReadonlyMap<number, Preview>;
  newest: boolean;
}
export class NavigationController {
  state: NavigationState = {
    root: null,
    choosing: false,
    rootBusy: false,
    rootStatus: 'none',
    rootMessage: '',
    message: '',
    error: false,
    siblings: null,
    siblingDocument: null,
    siblingMessage: '',
    previews: new Map(),
    newest: false,
  };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private siblingSequence = 0;
  private jobs = new Map<number, { request: number; job?: ParseJob }>();
  private disposed = false;
  private revealing = false;
  constructor(
    private bridge: NavigationBridge,
    private parse = parseInWorker,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private publish(patch: Partial<NavigationState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  notice(message: string, error = false) {
    this.publish({ message, error });
  }
  sort(newest: boolean) {
    this.publish({ newest });
  }
  async choose() {
    if (this.state.rootBusy) return;
    this.publish({
      choosing: true,
      rootBusy: true,
      message: 'Choosing folder…',
      error: false,
    });
    try {
      const result = await this.bridge.choose(++this.sequence);
      if (this.disposed) return;
      if (result.status === 'cancelled') {
        this.publish({
          choosing: false,
          rootBusy: false,
          message: 'Folder selection cancelled; folder unchanged.',
        });
        return;
      }
      this.invalidate();
      this.publish({
        root: result.index,
        rootStatus: 'loading',
        rootMessage: 'Loading folder…',
        siblings: null,
        choosing: false,
        rootBusy: false,
      });
      await this.refresh();
    } catch (error) {
      this.publish({
        choosing: false,
        rootBusy: false,
        message: `Could not choose folder: ${message(error)}`,
        error: true,
      });
    }
  }
  async refresh() {
    const root = this.state.root;
    if (!root || this.state.rootBusy) return;
    this.invalidate();
    this.publish({
      rootBusy: true,
      rootStatus: 'loading',
      rootMessage: 'Refreshing folder — retained entries are last known.',
      siblings: null,
      message: '',
      error: false,
    });
    try {
      const index = await this.bridge.refresh(root.scope, ++this.sequence);
      if (this.disposed || this.state.root !== root) return;
      this.publish({
        root: index,
        rootBusy: false,
        rootStatus: index.issues.length ? 'partial' : 'ready',
        rootMessage: index.issues.length
          ? 'Folder loaded with incomplete results; see folder issues.'
          : 'Folder loaded.',
      });
    } catch (error) {
      if (this.state.root !== root) return;
      this.publish({
        rootBusy: false,
        rootStatus: 'unavailable',
        rootMessage: `Folder unavailable (${message(error)}). Retained entries are last known. Use Navigate → Refresh Folder.`,
      });
    }
  }
  async update(document: Rendered | null) {
    const request = ++this.siblingSequence;
    this.publish({
      siblings: null,
      siblingDocument: null,
      siblingMessage: document ? 'Loading siblings…' : '',
    });
    if (!document) return;
    try {
      const siblings = await this.bridge.siblings(document.snapshot);
      if (request !== this.siblingSequence || this.disposed) return;
      this.publish({
        siblings,
        siblingDocument: document,
        siblingMessage:
          siblings.active === null
            ? 'Displayed file is not a visible sibling; no neighbor is selected.'
            : '',
      });
    } catch (error) {
      if (request === this.siblingSequence)
        this.publish({
          siblingDocument: document,
          siblingMessage: `Siblings unavailable: ${message(error)}`,
        });
    }
  }
  async preview(index: FileIndex, entry: FileEntry) {
    if (entry.kind !== 'markdown' || this.jobs.has(entry.uiId)) return;
    const request = ++this.sequence;
    const owned: { request: number; job?: ParseJob } = { request };
    this.jobs.set(entry.uiId, owned);
    this.setPreview(entry.uiId, { phase: 'loading', headings: [] });
    const current = () =>
      !this.disposed &&
      this.jobs.get(entry.uiId) === owned &&
      this.state.root === index;
    try {
      const snapshot = await this.bridge.preview(
        binding(index, entry),
        request,
      );
      if (!current()) return;
      owned.job = this.parse(
        snapshot.source,
        undefined,
        `preview-${String(index.scope)}-${String(index.revision)}-${String(entry.id)}-${String(snapshot.contextId)}-${String(snapshot.revision)}`,
      );
      const reading = await owned.job.result;
      if (!current()) return;
      this.setPreview(entry.uiId, {
        phase: 'ready',
        headings: reading.headings ?? [],
        snapshot,
      });
    } catch (error) {
      if (current())
        this.setPreview(entry.uiId, {
          phase: 'error',
          headings: [],
          message: message(error),
        });
    } finally {
      if (this.jobs.get(entry.uiId) === owned) this.jobs.delete(entry.uiId);
    }
  }
  private setPreview(key: number, preview?: Preview) {
    const previews = new Map(this.state.previews);
    if (preview) previews.set(key, preview);
    else previews.delete(key);
    this.publish({ previews });
  }
  collapse(key: number) {
    const owned = this.jobs.get(key);
    if (!owned) return;
    this.jobs.delete(key);
    owned.job?.cancel();
    void this.bridge.cancelPreview(owned.request).catch(() => {});
    this.setPreview(key);
  }
  invalidate = () => {
    for (const key of this.jobs.keys()) this.collapse(key);
    this.publish({ previews: new Map() });
  };
  async reveal(document: Rendered) {
    if (this.revealing) return;
    this.revealing = true;
    try {
      await this.bridge.reveal(document.snapshot);
      this.notice(`Sent ${document.snapshot.name} to the file manager.`);
    } catch (error) {
      this.notice(
        `Could not reveal ${document.snapshot.name}: ${message(error)}`,
        true,
      );
    } finally {
      this.revealing = false;
    }
  }
  dispose() {
    this.invalidate();
    this.disposed = true;
    this.siblingSequence++;
    this.listeners.clear();
  }
}
function message(error: unknown) {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : 'The operation could not finish.';
}
