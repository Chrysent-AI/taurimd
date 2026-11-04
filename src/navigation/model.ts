import { parseInWorker } from '../reader/worker';
import type { ParseJob } from '../reader/worker';
import type { Rendered } from '../types';
import {
  binding,
  type FileIndex,
  type FileEntry,
  type NavigationBridge,
  type PickerScope,
  type Preview,
  type Siblings,
  type IndexSnapshot,
  type IndexStatus,
} from './types';
interface NavigationState {
  cache: IndexStatus | null;
  watcherMessage: string;
  root: FileIndex | null;
  rootBusy: boolean;
  rootStatus: 'none' | 'loading' | 'ready' | 'partial' | 'unavailable';
  rootMessage: string;
  message: string;
  error: boolean;
  siblings: Siblings | null;
  siblingDocument: Rendered | null;
  siblingMessage: string;
  previews: ReadonlyMap<number, Preview>;
}
export class NavigationController {
  state: NavigationState = {
    cache: null,
    watcherMessage: '',
    root: null,
    rootBusy: false,
    rootStatus: 'none',
    rootMessage: '',
    message: '',
    error: false,
    siblings: null,
    siblingDocument: null,
    siblingMessage: '',
    previews: new Map(),
  };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private siblingSequence = 0;
  private jobs = new Map<number, { request: number; job?: ParseJob }>();
  private disposed = false;
  private expected: IndexStatus | null = null;
  private recovering: Promise<void> | null = null;
  private recoverAgain = false;
  private recoveryGeneration = 0;
  private notifications: 'closed' | 'pending' | 'healthy' | 'unavailable' =
    'closed';
  private completionTimer: ReturnType<typeof setTimeout> | undefined;
  private revealing = false;
  constructor(
    private bridge: NavigationBridge,
    private parse = parseInWorker,
    private completionDelay = 500,
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
  connect() {
    this.retireRecovery();
    this.notifications = 'pending';
    let retired = false;
    let stop: (() => void) | undefined;
    void this.bridge
      .listen((status) => {
        if (retired || this.disposed) return;
        const newer = (current: IndexStatus | null) =>
          !current ||
          status.scope > current.scope ||
          (status.scope === current.scope &&
            status.sequence > current.sequence);
        if (!newer(this.state.cache) || !newer(this.expected)) return;
        this.expected = status;
        if (
          status.scope !== this.state.root?.scope ||
          status.revision !== this.state.root.revision ||
          status.phase === 'loading' ||
          status.phase === 'unavailable'
        ) {
          this.invalidate();
          this.publish({
            rootBusy: true,
            rootStatus: 'loading',
            rootMessage: 'Updating folder; retained entries are last known.',
          });
        }
        void this.recover();
      })
      .then((unlisten) => {
        if (retired || this.disposed) unlisten();
        else {
          stop = unlisten;
          this.notifications = 'healthy';
          this.clearCompletion();
          void this.recover();
        }
      })
      .catch(() => {
        if (!retired && !this.disposed) {
          this.notifications = 'unavailable';
          this.notice(
            'Live folder notifications unavailable; focus or refresh to recover.',
            true,
          );
          void this.recover();
        }
      });
    const focus = () => {
      if (!retired && !this.disposed) void this.recover();
    };
    window.addEventListener('focus', focus);
    return () => {
      retired = true;
      this.notifications = 'closed';
      this.retireRecovery();
      stop?.();
      window.removeEventListener('focus', focus);
    };
  }
  private clearCompletion() {
    clearTimeout(this.completionTimer);
    this.completionTimer = undefined;
  }
  private retireRecovery() {
    this.clearCompletion();
    this.recoveryGeneration++;
    this.recoverAgain = false;
  }
  private scheduleCompletion() {
    this.clearCompletion();
    if (
      this.disposed ||
      this.notifications !== 'unavailable' ||
      !this.state.root ||
      !this.state.rootBusy ||
      this.state.cache?.phase !== 'loading'
    )
      return;
    const generation = this.recoveryGeneration;
    const scope = this.state.root.scope;
    this.completionTimer = setTimeout(() => {
      this.completionTimer = undefined;
      if (
        generation === this.recoveryGeneration &&
        scope === this.state.root?.scope &&
        this.notifications === 'unavailable' &&
        !this.disposed &&
        this.state.rootBusy &&
        this.state.cache?.phase === 'loading'
      )
        void this.recover();
    }, this.completionDelay);
  }
  recover(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.clearCompletion();
    this.recoverAgain = true;
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      while (this.recoverAgain && !this.disposed) {
        this.recoverAgain = false;
        const generation = this.recoveryGeneration;
        try {
          const snapshot = await this.bridge.get();
          if (generation === this.recoveryGeneration) this.accept(snapshot);
        } catch {
          if (generation !== this.recoveryGeneration) continue;
          this.clearCompletion();
          this.recoverAgain = false;
          if (
            this.notifications === 'unavailable' &&
            this.state.rootBusy &&
            this.state.cache?.phase === 'loading'
          )
            this.publish({
              rootBusy: false,
              rootStatus: 'unavailable',
              rootMessage:
                'Folder status unavailable. Retained entries are last known. Use Navigate → Refresh Folder.',
            });
          this.notice(
            'Could not retrieve folder status. Use Refresh or choose a folder again.',
            true,
          );
        }
      }
    })().finally(() => {
      this.recovering = null;
      if (this.recoverAgain && !this.disposed) void this.recover();
    });
    return this.recovering;
  }
  private accept(snapshot: IndexSnapshot) {
    if (this.disposed) return;
    const { index, status } = snapshot;
    const current = this.state.cache;
    const expected = this.expected;
    if (
      expected &&
      (status.scope < expected.scope ||
        (status.scope === expected.scope &&
          status.sequence < expected.sequence))
    )
      return;
    if (
      current &&
      (status.scope < current.scope ||
        (status.scope === current.scope && status.sequence < current.sequence))
    )
      return;
    const changed =
      this.state.root?.scope !== index?.scope ||
      this.state.root?.revision !== index?.revision ||
      (status.phase !== 'loading' && current?.phase === 'loading');
    if (changed || status.phase === 'loading') this.invalidate();
    const loading = status.phase === 'loading';
    this.publish({
      root: changed ? index : this.state.root,
      cache: status,
      rootBusy: loading,
      // A failure before any root was adopted has no retained entries to
      // show, but it is still a real, settled degradation — surface it
      // instead of collapsing it into the never-opened 'none' state.
      rootStatus: !index
        ? status.phase === 'unavailable'
          ? 'unavailable'
          : 'none'
        : status.phase || 'loading',
      rootMessage: !index
        ? status.phase === 'unavailable'
          ? `Folder unavailable (${status.message}). Open the file again to restore its folder.`
          : ''
        : loading
          ? `Indexing folder… ${String(status.entries)} known entries; retained entries are last known.`
          : status.phase === 'unavailable'
            ? `Folder unavailable (${status.message}). Retained entries are last known. Use Navigate → Refresh Folder.`
            : status.phase === 'partial'
              ? 'Folder loaded with incomplete results; see folder issues.'
              : 'Folder loaded.',
      watcherMessage: status.degraded
        ? 'Live updates unavailable; periodic refresh continues. Refresh is still available.'
        : '',
    });
    this.scheduleCompletion();
  }
  notice(message: string, error = false) {
    this.publish({ message, error });
  }
  async refresh() {
    const root = this.state.root;
    if (!root || this.state.rootBusy) return;
    this.retireRecovery();
    const generation = this.recoveryGeneration;
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
      const snapshot = await this.bridge.refresh(root.scope);
      if (
        this.disposed ||
        generation !== this.recoveryGeneration ||
        this.state.root !== root
      )
        return;
      this.accept(snapshot);
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.recoveryGeneration ||
        this.state.root !== root
      )
        return;
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
            ? this.state.rootBusy || this.state.rootStatus === 'loading'
              ? 'Indexing folder…'
              : 'Displayed file is not a visible sibling; no neighbor is selected.'
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
  previewFromReading(key: number, reading: Rendered) {
    // The displayed file's own preview reuses its current reading: no
    // second native read or parse. Any in-flight native work for this
    // entry is retired first, and a reload or changed file reaches here
    // through previewEpoch/previewChanged invalidation plus a fresh
    // reading object, so stale headings are never adopted twice.
    this.collapse(key);
    this.setPreview(key, {
      phase: 'ready',
      headings: reading.headings ?? [],
      snapshot: reading.snapshot,
    });
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
    // Count-only loading progress invalidates nothing when no preview
    // work exists. Skipping the empty-map publish keeps the retained
    // tree's inputs referentially stable, so progress announcements do
    // not re-render the whole explorer.
    if (this.state.previews.size > 0) this.publish({ previews: new Map() });
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
    this.notifications = 'closed';
    this.retireRecovery();
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
// The Quick Open overlay searches the watched working folder, which the
// native side establishes when a document is committed and keeps indexed.
// The picker and the dialog gating share this one derivation so reply gating
// can never disagree with the searched scope.
export function quickOpenScope(
  state: NavigationController['state'],
): PickerScope {
  return {
    index: state.root,
    busy: state.rootBusy || state.rootStatus === 'unavailable',
  };
}
