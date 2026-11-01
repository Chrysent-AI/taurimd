import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ReaderEvent } from './browser/event-transport';

// Explicit producer sites for the four reader-local channels. This contract
// accompanies the shared browser double; it is not native GUI/IPC execution.
export function nativeEventContract() {
  const sites: { path: string; owner: string; event: ReaderEvent }[] = [
    { path: 'lib.rs', owner: 'window', event: 'menu_action' },
    { path: 'lib.rs', owner: 'window', event: 'reader_notice' },
    { path: 'navigation_commands.rs', owner: 'owner', event: 'index_status' },
    { path: 'navigation_commands.rs', owner: 'handle', event: 'index_status' },
    { path: 'windows.rs', owner: 'window', event: 'document_requested' },
  ];
  const producers = sites.map((site) => {
    const source = readFileSync(
      resolve('src-tauri/src', site.path),
      'utf8',
    ).split('#[cfg(test)]')[0];
    const global = new RegExp(
      `${site.owner}\\.emit\\(\\s*"${site.event}"`,
    ).test(source);
    const scoped = new RegExp(
      `${site.owner}\\.emit_to\\(\\s*EventTarget::webview_window\\(${site.owner}\\.label\\(\\)\\),\\s*"${site.event}"`,
    ).test(source);
    if (global === scoped)
      throw new Error(`Unmodeled native producer: ${site.path} ${site.event}`);
    return {
      ...site,
      kind: scoped ? ('WebviewWindow' as const) : ('Any' as const),
    };
  });
  const lib = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8');
  const settingsGlobal = /app\.emit\("settings_changed", record\)/.test(lib);
  return { producers, settingsGlobal };
}
