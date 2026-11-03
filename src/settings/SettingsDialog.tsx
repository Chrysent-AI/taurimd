import { useState, type ReactNode } from 'react';
import {
  defaults,
  navigationDepthChoices,
  navigationDepthMax,
  navigationDepthMin,
  palettes,
  remoteHostProblem,
  type SettingsController,
  type SettingsV1,
} from './model';

export function SettingsFeedback({
  status,
  notice,
  retry,
  recoveryOnly = false,
}: {
  status: 'loading' | 'saving' | 'saved' | 'error';
  notice: string | null;
  retry: () => void;
  recoveryOnly?: boolean;
}) {
  return (
    <section className="preferences-feedback" aria-label="Preferences status">
      {(!recoveryOnly || status === 'error') && (
        <p aria-live="polite">
          {status === 'error'
            ? 'Applied for now; could not save or synchronize preferences.'
            : status === 'saving'
              ? 'Saving preferences…'
              : status === 'loading'
                ? 'Loading preferences…'
                : 'Preferences saved.'}
          {status === 'error' && (
            <>
              {' '}
              <button onClick={retry}>Retry preferences</button>
            </>
          )}
        </p>
      )}
      {notice && (
        <p role="alert" className="warning">
          {notice}
        </p>
      )}
    </section>
  );
}
export function RemoteImageHosts({
  controller,
  settings,
}: {
  controller: SettingsController;
  settings: SettingsV1;
}) {
  const [entry, setEntry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const failure = remoteHostProblem(entry);
    if (failure) {
      setProblem(failure);
      return;
    }
    const host = entry.trim().toLowerCase();
    if (settings.remoteImageHosts.includes(host)) {
      setProblem('That host is already permitted.');
      return;
    }
    setProblem(null);
    setEntry('');
    controller.change({
      remoteImageHosts: [...settings.remoteImageHosts, host].sort(),
    });
  };
  return (
    <fieldset>
      <legend>Remote image hosts</legend>
      <p className="hint">
        A permitted host may receive an automatic HTTPS image request when a
        document contains an image from it. Images from other hosts stay
        blocked, and no document content, path or other resource is sent.
      </p>
      {settings.remoteImageHosts.length ? (
        <ul>
          {settings.remoteImageHosts.map((host) => (
            <li key={host}>
              <span>{host}</span>{' '}
              <button
                onClick={() => {
                  controller.change({
                    remoteImageHosts: settings.remoteImageHosts.filter(
                      (permitted) => permitted !== host,
                    ),
                  });
                }}
              >
                Remove {host}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">
          No host is permitted, so every remote image stays blocked.
        </p>
      )}
      <div className="commands">
        <label htmlFor="remote-image-host">Add a host</label>
        <input
          id="remote-image-host"
          type="text"
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            // An IME composition owns Enter until it is finished.
            if (
              event.nativeEvent.isComposing ||
              // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME engines can report 229 without isComposing.
              event.keyCode === 229
            )
              return;
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <button onClick={add}>Add host</button>
      </div>
      {problem && (
        <p role="alert" className="warning">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
export function SettingsDialog({
  controller,
  settings,
  slot,
  children,
}: {
  controller: SettingsController;
  settings: SettingsV1;
  slot: 'light' | 'dark';
  children: ReactNode;
}) {
  const palette = settings[slot === 'light' ? 'lightPalette' : 'darkPalette'];
  return (
    <>
      <p className="hint">
        Changes apply immediately. Closing does not undo them.
      </p>
      <div className="setting-field">
        <label htmlFor="appearance-mode">Appearance</label>
        <select
          id="appearance-mode"
          value={settings.mode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'system' || value === 'light' || value === 'dark')
              controller.change({ mode: value });
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      {(['lightPalette', 'darkPalette'] as const).map((key) => (
        <div className="setting-field" key={key}>
          <label htmlFor={key}>
            {key === 'lightPalette' ? 'Light palette' : 'Dark palette'}
          </label>
          <select
            id={key}
            value={settings[key]}
            onChange={(event) => {
              const value = palettes.find(
                ([id]) => id === event.target.value,
              )?.[0];
              if (value) controller.change({ [key]: value });
            }}
          >
            {palettes.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <p className="hint">
        Currently using {slot === 'light' ? 'Light' : 'Dark'} palette:{' '}
        {palettes.find(([id]) => id === palette)?.[1]}
        {settings.mode === 'system' ? ' (system appearance)' : ''}. The inactive
        palette is saved for that appearance.
      </p>
      <button
        onClick={() => {
          controller.change({
            mode: defaults.mode,
            lightPalette: defaults.lightPalette,
            darkPalette: defaults.darkPalette,
            pageZoom: defaults.pageZoom,
          });
        }}
      >
        Reset appearance defaults
      </button>
      <fieldset>
        <legend>Page zoom</legend>
        <div className="commands">
          <button
            disabled={settings.pageZoom === 50}
            onClick={() => {
              controller.zoom('zoom-out');
            }}
          >
            Decrease page zoom
          </button>
          <output aria-label="Page zoom">{settings.pageZoom}%</output>
          <button
            disabled={settings.pageZoom === 300}
            onClick={() => {
              controller.zoom('zoom-in');
            }}
          >
            Increase page zoom
          </button>
          <button
            onClick={() => {
              controller.zoom('zoom-reset');
            }}
          >
            Reset to 100%
          </button>
        </div>
      </fieldset>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.fitDiagrams}
          onChange={(event) => {
            controller.change({ fitDiagrams: event.target.checked });
          }}
        />
        Fit diagrams to view
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.sidebarDefault}
          onChange={(event) => {
            controller.change({ sidebarDefault: event.target.checked });
          }}
        />
        Show File Explorer by default
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.tocVisible}
          onChange={(event) => {
            controller.change({ tocVisible: event.target.checked });
          }}
        />
        Show Table of Contents by default
      </label>
      <p className="hint">
        Fit updates current diagrams without rerendering them. Pane visibility
        applies immediately and is remembered; View → Show File Explorer and
        View → Show Table of Contents use the same remembered choices.
      </p>
      <fieldset>
        <legend>File Explorer</legend>
        <div className="setting-field">
          <label htmlFor="navigation-depth">Indexing depth</label>
          <select
            id="navigation-depth"
            value={settings.navigationDepth}
            onChange={(event) => {
              const value = Number.parseInt(event.target.value, 10);
              if (value >= navigationDepthMin && value <= navigationDepthMax)
                controller.change({ navigationDepth: value });
            }}
          >
            {navigationDepthChoices.map((levels) => (
              <option key={levels} value={levels}>
                {levels === 1 ? '1 level' : `${String(levels)} levels`}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">
          How many directory levels of the working folder are indexed for the
          File Explorer and Quick Open. Changing it rescans the folder.
        </p>
      </fieldset>
      <fieldset>
        <legend>File order</legend>
        <div className="setting-field">
          <label htmlFor="file-sort-key">Sort files by</label>
          <select
            id="file-sort-key"
            value={settings.fileSortKey}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'name' || value === 'modified' || value === 'size')
                controller.change({ fileSortKey: value });
            }}
          >
            <option value="name">Name</option>
            <option value="modified">Date modified</option>
            <option value="size">Size (bytes)</option>
          </select>
        </div>
        <div className="setting-field">
          <label htmlFor="file-sort-direction">Direction</label>
          <select
            id="file-sort-direction"
            value={settings.fileSortDirection}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'asc' || value === 'desc')
                controller.change({ fileSortDirection: value });
            }}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
        <p className="hint">
          Remembered for file lists and sibling navigation.
        </p>
      </fieldset>
      <RemoteImageHosts controller={controller} settings={settings} />
      {children}
    </>
  );
}
