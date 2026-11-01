import type { Event, EventTarget } from '@tauri-apps/api/event';

export type ReaderEvent =
  | 'menu_action'
  | 'index_status'
  | 'document_requested'
  | 'reader_notice';
export interface EventMetadata {
  currentWindow: { label: string };
  currentWebview: { label: string };
}
export interface EventIPC {
  command: string;
  payload: unknown;
  metadata: EventMetadata;
}
type Delivery = (
  callback: number,
  event: Event<unknown>,
) => void | Promise<void>;
interface Listener {
  owner: object;
  event: string;
  target: EventTarget;
  callback: number;
  deliver: Delivery;
  metadata: EventMetadata;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid fixture event arguments');
  return value as Record<string, unknown>;
}
function target(value: unknown): EventTarget {
  const input = record(value);
  if (input.kind === 'Any' || input.kind === 'App') return { kind: input.kind };
  if (
    (input.kind === 'AnyLabel' ||
      input.kind === 'Window' ||
      input.kind === 'Webview' ||
      input.kind === 'WebviewWindow') &&
    typeof input.label === 'string'
  )
    return { kind: input.kind, label: input.label };
  throw new Error('Invalid fixture event target');
}
// Mirrors the installed manager filter plus match_any_or_filter. In particular,
// targeting an emission never makes an Any subscription local to its owner.
function matches(emission: EventTarget, listener: EventTarget) {
  if (emission.kind === 'Any' || listener.kind === 'Any') return true;
  if (emission.kind === 'App' || listener.kind === 'App')
    return emission.kind === listener.kind;
  return (
    emission.label === listener.label &&
    (emission.kind === 'AnyLabel' ||
      listener.kind === 'AnyLabel' ||
      emission.kind === listener.kind)
  );
}
export class FixtureEvents {
  // Keep the installed JS mock's opaque callback/listener ID convention, with
  // separate owner maps so equal callback IDs in different webviews cannot collide.
  private listeners = new Map<object, Map<number, Listener>>();
  readonly calls: EventIPC[] = [];
  readonly emissions: { event: string; target: EventTarget }[] = [];
  readonly deliveries: {
    event: string;
    target: EventTarget;
    metadata: EventMetadata;
  }[] = [];
  get listenerCount() {
    return [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
  removeOwner(owner: object) {
    this.listeners.delete(owner);
  }
  async emit(
    event: string,
    payload: unknown,
    destination: EventTarget = { kind: 'Any' },
  ) {
    this.emissions.push({ event, target: structuredClone(destination) });
    await Promise.all(
      [...this.listeners.values()]
        .flatMap((listeners) => [...listeners])
        .filter(
          ([, listener]) =>
            listener.event === event && matches(destination, listener.target),
        )
        .map(([id, listener]) => {
          this.deliveries.push({
            event,
            target: structuredClone(listener.target),
            metadata: structuredClone(listener.metadata),
          });
          return Promise.resolve(
            listener.deliver(listener.callback, { event, id, payload }),
          );
        }),
    );
  }
  async invoke(
    owner: object,
    request: EventIPC,
    deliver: Delivery,
  ): Promise<unknown> {
    this.calls.push(structuredClone(request));
    const args = record(request.payload);
    if (request.command === 'plugin:event|listen') {
      if (typeof args.event !== 'string' || typeof args.handler !== 'number')
        throw new Error('Invalid fixture event listener');
      const listeners =
        this.listeners.get(owner) ?? new Map<number, Listener>();
      listeners.set(args.handler, {
        owner,
        event: args.event,
        target: target(args.target),
        callback: args.handler,
        deliver,
        metadata: structuredClone(request.metadata),
      });
      this.listeners.set(owner, listeners);
      return args.handler;
    }
    if (request.command === 'plugin:event|unlisten') {
      if (typeof args.eventId !== 'number')
        throw new Error('Invalid fixture unlisten');
      const listeners = this.listeners.get(owner);
      listeners?.delete(args.eventId);
      if (!listeners?.size) this.listeners.delete(owner);
      return null;
    }
    if (
      request.command === 'plugin:event|emit' ||
      request.command === 'plugin:event|emit_to'
    ) {
      if (typeof args.event !== 'string')
        throw new Error('Invalid fixture emission');
      await this.emit(
        args.event,
        args.payload,
        request.command.endsWith('emit_to')
          ? target(args.target)
          : { kind: 'Any' },
      );
      return null;
    }
    throw new Error(`Unexpected fixture event command: ${request.command}`);
  }
}
