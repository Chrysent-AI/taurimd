export const palettes = [
  ['githubLight', 'GitHub Light'],
  ['githubDark', 'GitHub Dark'],
  ['solarizedLight', 'Solarized Light'],
  ['solarizedDark', 'Solarized Dark'],
  ['dracula', 'Dracula'],
  ['monokai', 'Monokai'],
  ['nord', 'Nord'],
] as const;
export type Palette = (typeof palettes)[number][0];
export interface SettingsV1 {
  mode: 'system' | 'light' | 'dark';
  lightPalette: Palette;
  darkPalette: Palette;
  pageZoom: number;
  fitDiagrams: boolean;
  sidebarDefault: boolean;
  statusVisible: boolean;
  remoteImageHosts: string[];
}
// The confirmed starter hosts for automatic HTTPS image requests, in the
// canonical sorted order the native owner stores them.
export const remoteImageHosts = [
  'camo.githubusercontent.com',
  'github.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
];
// Mirrors the native host rule so an unusable entry is reported before it
// is offered to the native owner: a bare domain, no scheme, port, path,
// userinfo, wildcard or address.
export function remoteHostProblem(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return 'Enter a host name.';
  if (
    Array.from(trimmed).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return 'A host name cannot contain spaces.';
  if (/[/\\:?#@%*[\]]/.test(trimmed))
    return 'Enter a bare host name with no scheme, port, path or wildcard.';
  if (/[。．｡]/.test(trimmed)) return 'Enter a host name with ordinary dots.';
  if (trimmed.startsWith('.') || trimmed.endsWith('.'))
    return 'Enter a host name that starts and ends with a label.';
  const labels = trimmed.split('.');
  if (labels.some((label) => !label))
    return 'Enter a host name with single dots between labels.';
  if (trimmed.length > 253) return 'That host name is too long.';
  for (const label of labels) {
    if (label.length > 63) return 'One label of that host name is too long.';
    // ASCII only: a Unicode label would be folded to another identity by the
    // native owner, so the exact host must be written in its ASCII form.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
      return 'A host name label may only contain ASCII letters, digits and hyphens.';
  }
  // A numeric last label is an address or an address disguise, never a host.
  if (/^\d+$/.test(labels[labels.length - 1]))
    return 'Enter a host name, not an address.';
  return null;
}
export const defaults: SettingsV1 = {
  mode: 'system',
  lightPalette: 'githubLight',
  darkPalette: 'githubDark',
  pageZoom: 100,
  fitDiagrams: true,
  sidebarDefault: true,
  statusVisible: true,
  remoteImageHosts: [...remoteImageHosts],
};
export interface SettingsRecord {
  version: 1;
  revision: number;
  settings: SettingsV1;
  notice: string | null;
}
export type SettingsPatch = Partial<SettingsV1>;
export type SettingsUpdate = {
  status: 'committed' | 'conflict';
  record: SettingsRecord;
};
export interface SettingsBridge {
  get: () => Promise<SettingsRecord>;
  update: (revision: number, patch: SettingsPatch) => Promise<SettingsUpdate>;
  listen: (receive: (record: SettingsRecord) => void) => Promise<() => void>;
}
interface State {
  settings: SettingsV1;
  revision: number;
  status: 'loading' | 'saving' | 'saved' | 'error';
  notice: string | null;
}
export class SettingsController {
  private committed: SettingsRecord = {
    version: 1,
    revision: 0,
    settings: defaults,
    notice: null,
  };
  private intent: SettingsPatch = {};
  private versions: Partial<Record<keyof SettingsV1, number>> = {};
  private sequence = 0;
  private loaded = false;
  private saving = false;
  private active = false;
  private listening = false;
  private startListening: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private state: State = {
    settings: defaults,
    revision: 0,
    status: 'loading',
    notice: null,
  };
  constructor(private bridge: SettingsBridge) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(status = this.state.status) {
    if (!this.active) return;
    this.state = {
      settings: { ...this.committed.settings, ...this.intent },
      revision: this.committed.revision,
      status,
      notice: this.committed.notice,
    };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  private receive = (record: SettingsRecord) => {
    if (!this.active || record.revision < this.committed.revision) return;
    this.committed = record;
    this.publish();
  };
  connect() {
    this.active = true;
    let stop: (() => void) | undefined;
    let disposed = false;
    let subscribing = false;
    // Listen before hydration so missed notifications recover via the getter.
    const start = () => {
      if (subscribing || disposed) return;
      subscribing = true;
      void this.bridge
        .listen(this.receive)
        .then((unlisten) => {
          if (disposed) unlisten();
          else {
            this.listening = true;
            stop = unlisten;
            void this.hydrate();
          }
        })
        .catch(() => {
          if (!disposed) this.publish('error');
        })
        .finally(() => {
          subscribing = false;
        });
    };
    this.startListening = start;
    start();
    return () => {
      disposed = true;
      this.active = false;
      this.listening = false;
      this.startListening = undefined;
      stop?.();
    };
  }
  private async hydrate() {
    try {
      const record = await this.bridge.get();
      if (!this.active) return;
      this.receive(record);
      this.loaded = true;
      this.publish(Object.keys(this.intent).length ? 'saving' : 'saved');
      void this.flush();
    } catch {
      this.publish('error');
    }
  }
  change(patch: SettingsPatch) {
    for (const key of Object.keys(patch) as (keyof SettingsV1)[])
      this.versions[key] = ++this.sequence;
    this.intent = { ...this.intent, ...patch };
    this.publish(
      !this.loaded && this.state.status === 'error' ? 'error' : 'saving',
    );
    if (this.loaded) void this.flush();
  }
  retry = () => {
    this.publish('saving');
    if (!this.listening) this.startListening?.();
    else if (!this.loaded) void this.hydrate();
    else void this.flush();
  };
  zoom(action: 'zoom-in' | 'zoom-out' | 'zoom-reset') {
    const current = this.state.settings.pageZoom;
    this.change({
      pageZoom:
        action === 'zoom-reset'
          ? 100
          : Math.max(
              50,
              Math.min(300, current + (action === 'zoom-in' ? 10 : -10)),
            ),
    });
  }
  private isActive() {
    return this.active;
  }
  private async flush() {
    if (this.saving || !this.active) return;
    this.saving = true;
    let conflicts = 0;
    try {
      while (this.isActive() && Object.keys(this.intent).length) {
        const patch = { ...this.intent };
        const versions = { ...this.versions };
        const result = await this.bridge.update(this.committed.revision, patch);
        if (!this.isActive()) return;
        this.receive(result.record);
        if (result.status === 'conflict') {
          if (++conflicts >= 3) {
            this.publish('error');
            return;
          }
          continue;
        }
        conflicts = 0;
        const acknowledged = new Set(
          (Object.keys(patch) as (keyof SettingsV1)[]).filter(
            (key) => this.versions[key] === versions[key],
          ),
        );
        this.intent = Object.fromEntries(
          Object.entries(this.intent).filter(
            ([key]) => !acknowledged.has(key as keyof SettingsV1),
          ),
        );
        this.publish(Object.keys(this.intent).length ? 'saving' : 'saved');
      }
    } catch {
      this.publish('error');
    } finally {
      this.saving = false;
    }
  }
}
