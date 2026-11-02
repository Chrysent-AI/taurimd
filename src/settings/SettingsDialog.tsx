import type { ReactNode } from 'react';
import {
  defaults,
  palettes,
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
        Show sidebar by default
      </label>
      <p className="hint">
        Fit updates current diagrams without rerendering them. Sidebar
        visibility applies immediately and is remembered.
      </p>
      {children}
    </>
  );
}
