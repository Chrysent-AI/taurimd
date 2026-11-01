import type {
  FileIndex,
  NavigationBridge,
  QueryReply,
  QueryRequest,
} from './types';
export class QuickOpenController {
  state: {
    text: string;
    phase: 'idle' | 'filtering' | 'ready' | 'error';
    reply: QueryReply | null;
    selected: number;
    message: string;
    feedback: string;
  } = {
    text: '',
    phase: 'idle',
    reply: null,
    selected: 0,
    message: '',
    feedback: '',
  };
  private remembered: {
    scope: number;
    revision: number;
    text: string;
    entry: number;
  } | null = null;
  private directory: {
    scope: number;
    id: number;
    uiId: number;
    prefix: string;
  } | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private root: FileIndex | null = null;
  private busy = false;
  private active = false;
  constructor(
    private bridge: NavigationBridge,
    private recover: () => void,
    private delay = 200,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private publish(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  private cancel() {
    clearTimeout(this.timer);
    this.sequence++;
  }
  close(remember = false) {
    const reply = this.currentReply();
    const row = reply?.results.at(this.state.selected);
    this.remembered =
      remember && reply && row
        ? {
            scope: reply.scope,
            revision: reply.revision,
            text: reply.text,
            entry: row.entry.id,
          }
        : null;
    this.active = false;
    this.cancel();
    this.publish({ reply: null, phase: 'idle' });
  }
  notice(feedback: string) {
    this.publish({ feedback });
  }
  open(root: FileIndex | null, busy: boolean) {
    this.publish({ feedback: '' });
    this.active = false;
    this.update(root, busy);
    this.active = true;
    this.search();
  }
  update(root: FileIndex | null, busy: boolean) {
    if (this.root === root && this.busy === busy) return;
    if (this.directory) {
      if (!root || this.directory.scope !== root.scope) this.directory = null;
      else {
        const current = root.entries.find(
          (entry) =>
            entry.uiId === this.directory?.uiId && entry.kind === 'directory',
        );
        this.directory = {
          ...this.directory,
          id: current?.id ?? this.directory.id,
        };
      }
    }
    this.root = root;
    this.busy = busy;
    if (this.active) this.search();
  }
  text(text: string) {
    if (this.directory && !text.startsWith(this.directory.prefix))
      this.directory = null;
    this.publish({ text });
    this.search();
  }
  select(selected: number) {
    this.publish({ selected });
  }
  private search() {
    this.cancel();
    this.publish({
      reply: null,
      selected: 0,
      message: '',
      feedback: '',
      phase: this.root && !this.busy ? 'filtering' : 'idle',
    });
    if (!this.active || !this.root || this.busy) return;
    const request: QueryRequest = {
      scope: this.root.scope,
      revision: this.root.revision,
      queryId: this.sequence,
      text: this.state.text,
      ...(this.directory ? { directory: this.directory.id } : {}),
    };
    this.timer = setTimeout(() => {
      void this.run(request, false);
    }, this.delay);
  }
  private current(request: QueryRequest) {
    return (
      this.active &&
      !this.busy &&
      request.queryId === this.sequence &&
      request.text === this.state.text &&
      request.scope === this.root?.scope &&
      request.revision === this.root.revision &&
      request.directory === this.directory?.id
    );
  }
  async complete() {
    const reply = this.state.reply;
    if (!reply || reply.status !== 'missing' || !this.current(reply)) return;
    this.publish({ phase: 'filtering', reply: null });
    await this.run(reply, true);
  }
  private async run(request: QueryRequest, traverse: boolean) {
    try {
      const reply = await (traverse
        ? this.bridge.complete(request)
        : this.bridge.query(request));
      if (!this.current(request) || !this.current(reply)) return;
      const remembered = this.remembered;
      const selected =
        remembered &&
        remembered.scope === reply.scope &&
        remembered.revision === reply.revision &&
        remembered.text === reply.text
          ? Math.max(
              0,
              reply.results.findIndex(
                ({ entry }) => entry.id === remembered.entry,
              ),
            )
          : 0;
      this.remembered = null;
      this.publish({
        reply,
        selected,
        phase: 'ready',
        message:
          traverse && reply.status === 'missing' ? 'Reading folder…' : '',
      });
      if (traverse) this.recover();
    } catch {
      if (!this.current(request)) return;
      this.publish({
        phase: 'error',
        reply: null,
        message: 'Could not filter this folder. Refresh to retry.',
      });
      this.recover();
    }
  }
  currentReply() {
    const reply = this.state.reply;
    return reply && this.state.phase === 'ready' && this.current(reply)
      ? reply
      : null;
  }
  enterDirectory(relative: string, id?: number, uiId?: number) {
    const text = `${relative}/`;
    if (
      text === this.state.text &&
      (id === undefined || this.directory?.id === id)
    )
      return false;
    this.directory =
      id !== undefined && uiId !== undefined && this.root
        ? { scope: this.root.scope, id, uiId, prefix: text }
        : null;
    this.text(text);
    return true;
  }
}
