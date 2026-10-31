import type { Reading } from './reader/parse';
import type { NativeReader, ReaderState, Snapshot, Rendered } from './types';
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
  async resolve(document: Rendered, reference: string) {
    if (this.state.displayed !== document)
      throw new Error('This media belongs to a retired document.');
    const result = await this.bridge.resolve(document.snapshot, reference);
    if (this.state.displayed !== document)
      throw new Error('This media belongs to a retired document.');
    return result;
  }
  async activate(document: Rendered, href: string) {
    if (
      document !== this.state.displayed ||
      ['loading', 'parsing', 'committing'].includes(this.state.phase)
    )
      return;
    await this.run('link', href);
  }
  async run(action: 'open' | 'reload' | 'link', href = '') {
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
    const before = this.state;
    let linkedDocument = false;
    this.publish({
      phase: 'loading',
      linkMessage: action === 'link' ? 'Opening link…' : '',
      message:
        action === 'link'
          ? before.message
          : action === 'open'
            ? 'Choosing and opening a document…'
            : `Reloading ${previous?.snapshot.name ?? 'document'}…`,
    });
    try {
      let snapshot: Snapshot;
      let fragment: string | null = null;
      if (action === 'link') {
        if (!previous) return;
        const result = await this.bridge.activate(
          request,
          previous.snapshot,
          href,
        );
        if (request !== this.sequence || this.state.displayed !== previous)
          return;
        if (result.status !== 'document') {
          this.publish({
            phase: before.phase,
            message: before.message,
            linkMessage:
              result.status === 'externalOpened'
                ? 'Sent link to the default application.'
                : 'Use an in-document section link.',
          });
          return;
        }
        linkedDocument = true;
        snapshot = result.snapshot;
        fragment = result.fragment;
      } else if (action === 'open') {
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
      let reading: Reading = { html: '', metadata: null };
      let html: string | null = null;
      if (snapshot.format === 'markdown') {
        this.publish({
          phase: 'parsing',
          message: `Formatting ${snapshot.name}…`,
        });
        this.job = this.parse(snapshot.source, snapshot);
        reading = await this.job.result;
        html = reading.html;
        if (request !== this.sequence) return;
        this.job = null;
      }
      this.publish({
        phase: 'committing',
        message: `Displaying ${snapshot.name}…`,
      });
      await this.bridge.commit(request);
      this.publish({
        displayed: { ...reading, snapshot, html, fragment },
        phase: 'ready',
        stale: false,
        linkMessage: '',
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
      if (action === 'link' && !linkedDocument) {
        this.publish({
          phase: before.phase,
          message: before.message,
          linkMessage: `Link unavailable: ${message}`,
        });
        return;
      }
      this.publish({
        phase: 'error',
        stale: previous !== null,
        linkMessage: '',
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
      linkMessage: '',
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
