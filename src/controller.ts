import type { EntryIntent } from './navigation/types';
import type { Reading } from './reader/parse';
import type { NativeReader, ReaderState, Snapshot, Rendered } from './types';
import type { ParseJob } from './reader/worker';
export class ReaderController {
  state: ReaderState = {
    requestId: 0,
    displayed: null,
    phase: 'empty',
    message: 'Open a local document to begin.',
    stale: false,
    previewEpoch: 0,
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
    return this.run('link', href);
  }
  openEntry(intent: EntryIntent, newWindow = false) {
    return this.run(newWindow ? 'handoff' : 'entry', '', intent);
  }
  receive(
    load: (
      request: number,
    ) => Promise<{ snapshot: Snapshot; fragment: string | null }>,
  ) {
    return this.run('receive', '', undefined, load);
  }
  notice(message: string) {
    this.publish({
      linkMessage: message,
      quietLink: false,
      ...(!this.state.displayed &&
      !['loading', 'parsing', 'committing'].includes(this.state.phase)
        ? { phase: 'error' as const, message }
        : {}),
    });
  }
  async run(
    action: 'open' | 'reload' | 'link' | 'entry' | 'handoff' | 'receive',
    href = '',
    intent?: EntryIntent,
    load?: (
      request: number,
    ) => Promise<{ snapshot: Snapshot; fragment: string | null }>,
  ) {
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
    this.publish({
      requestId: request,
      phase: 'loading',
      previewEpoch: (before.previewEpoch ?? 0) + (action === 'reload' ? 1 : 0),
      linkMessage: action === 'link' ? 'Opening link…' : '',
      quietLink: false,
      message:
        action === 'link'
          ? before.message
          : action === 'handoff'
            ? `Opening ${intent?.name ?? 'file'} in another reader…`
            : action === 'receive'
              ? 'Opening the requested document…'
              : action === 'entry'
                ? `Opening ${intent?.name ?? 'file'}…`
                : action === 'open'
                  ? 'Choosing and opening a document…'
                  : `Reloading ${previous?.snapshot.name ?? 'document'}…`,
    });
    try {
      let snapshot: Snapshot;
      let fragment: string | null = null;
      if ((action === 'entry' || action === 'handoff') && intent) {
        const result = await this.bridge.openEntry(
          request,
          intent.binding,
          action === 'handoff',
        );
        if (request !== this.sequence) return;
        if ('status' in result) {
          this.publish({
            phase: before.phase,
            message: before.message,
            linkMessage: 'Opened in another reader.',
            quietLink: true,
          });
          return 'handedOff' as const;
        }
        snapshot = result;
      } else if (action === 'receive' && load) {
        const received = await load(request);
        snapshot = received.snapshot;
        fragment = received.fragment;
      } else if (action === 'link') {
        if (!previous) return;
        const result = await this.bridge.activate(
          request,
          previous.snapshot,
          href,
        );
        if (request !== this.sequence || this.state.displayed !== previous)
          return;
        this.publish({
          phase: before.phase,
          message: before.message,
          quietLink: result.status === 'handedOff',
          linkMessage:
            result.status === 'handedOff'
              ? 'Opened in another reader.'
              : result.status === 'externalOpened'
                ? 'Sent link to the default application.'
                : 'Use an in-document section link.',
        });
        return result;
      } else if (action === 'open') {
        const selection = await this.bridge.select(request);
        if (request !== this.sequence) return;
        if (selection.status === 'cancelled') {
          this.publish({
            phase: previous ? 'ready' : 'empty',
            message: 'Open cancelled. The displayed document has not changed.',
          });
          return 'cancelled' as const;
        }
        if (selection.status === 'handedOff') {
          this.publish({
            phase: before.phase,
            message: before.message,
            linkMessage: 'Activated the existing reader.',
            quietLink: true,
          });
          return 'handedOff' as const;
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
      const changed =
        intent?.preview &&
        (snapshot.contextId !== intent.preview.contextId ||
          snapshot.source !== intent.preview.source);
      this.publish({
        displayed: {
          requestId: request,
          ...reading,
          snapshot,
          html,
          fragment,
          focus: intent?.focus,
          headingKey: changed ? undefined : intent?.key,
          previewChanged: !!changed,
        },
        phase: 'ready',
        stale: false,
        linkMessage: '',
        message: changed
          ? 'File changed; choose a heading again.'
          : `${action === 'reload' ? 'Reloaded' : 'Opened'} ${snapshot.name}${snapshot.source.length === 0 ? ' — empty file' : ''}.`,
      });
      return 'opened' as const;
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
      if (
        action === 'link' ||
        action === 'handoff' ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'handoff')
      ) {
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
      return 'failed' as const;
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
