import type { Metadata } from './reader/frontmatter';
import type { NativeReader, ReaderState, Snapshot } from './types';
import type { ParseJob } from './reader/worker';
export class ReaderController {
  state: ReaderState = {
    displayed: null,
    phase: 'empty',
    message: 'Open a local document to begin.',
    stale: false,
  };
  private sequence = 0;
  private job: ParseJob | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private bridge: NativeReader,
    private parse: (source: string, snapshot: Snapshot) => ParseJob,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private publish(patch: Partial<ReaderState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  async run(action: 'open' | 'reload') {
    // Do not interleave another action across the native/display commit boundary.
    if (
      this.state.phase === 'committing' ||
      (action === 'reload' && !this.state.displayed)
    )
      return;
    const request = ++this.sequence;
    this.job?.cancel();
    this.job = null;
    const previous = this.state.displayed;
    this.publish({
      phase: 'loading',
      message:
        action === 'open'
          ? 'Choosing and opening a document…'
          : `Reloading ${previous?.snapshot.name ?? 'document'}…`,
    });
    try {
      let snapshot: Snapshot;
      if (action === 'open') {
        const selection = await this.bridge.select(request);
        if (request !== this.sequence) return;
        if (selection.status === 'cancelled') {
          this.publish({
            phase: previous ? 'ready' : 'empty',
            message: 'Open cancelled. The displayed document has not changed.',
          });
          return;
        }
        snapshot = selection.snapshot;
      } else {
        if (!previous) return;
        snapshot = await this.bridge.reload(request, previous.snapshot);
      }
      if (request !== this.sequence) return;
      let html: string | null = null;
      let metadata: Metadata = null;
      if (snapshot.format === 'markdown') {
        this.publish({
          phase: 'parsing',
          message: `Formatting ${snapshot.name}…`,
        });
        this.job = this.parse(snapshot.source, snapshot);
        const reading = await this.job.result;
        html = reading.html;
        metadata = reading.metadata;
        if (request !== this.sequence) return;
        this.job = null;
      }
      this.publish({
        phase: 'committing',
        message: `Displaying ${snapshot.name}…`,
      });
      await this.bridge.commit(request);
      this.publish({
        displayed: { snapshot, html, metadata },
        phase: 'ready',
        stale: false,
        message: `${action === 'reload' ? 'Reloaded' : 'Opened'} ${snapshot.name}${snapshot.source.length === 0 ? ' — empty file' : ''}.`,
      });
    } catch (error) {
      if (request !== this.sequence) return;
      this.job?.cancel();
      this.job = null;
      void this.bridge.cancel(request).catch(() => {
        if (request === this.sequence)
          this.publish({
            message: `${this.state.message} Native pending-operation cleanup was not acknowledged.`,
          });
      });
      let message =
        error instanceof Error
          ? error.message
          : 'The document could not be opened.';
      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        message = error.message;
        if ('attempted' in error && typeof error.attempted === 'string')
          message = `${error.attempted}: ${message}`;
      }
      this.publish({
        phase: 'error',
        stale: previous !== null,
        message: `${action === 'reload' ? 'Reload failed' : 'Open failed'}: ${message}${previous ? ` Still showing last loaded ${previous.snapshot.name} (stale).` : ''}`,
      });
    }
  }
  async cancel() {
    if (this.state.phase === 'committing') return;
    const request = this.sequence++;
    const cancellationSequence = this.sequence;
    this.job?.cancel();
    this.job = null;
    this.publish({
      phase: this.state.displayed ? 'ready' : 'empty',
      message: 'Operation cancelled. The displayed document has not changed.',
    });
    try {
      await this.bridge.cancel(request);
    } catch {
      if (this.sequence !== cancellationSequence) return;
      this.publish({
        message:
          'Display operation cancelled; native cancellation could not be acknowledged. Pending results will be ignored.',
      });
    }
  }
  dispose() {
    void this.cancel();
    this.listeners.clear();
  }
}
