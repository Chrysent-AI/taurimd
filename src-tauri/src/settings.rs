use crate::documents::AppError;
use crate::remote_images::{self, Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    System,
    Light,
    Dark,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Palette {
    GithubLight,
    GithubDark,
    SolarizedLight,
    SolarizedDark,
    Dracula,
    Monokai,
    Nord,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSortDirection {
    #[default]
    Asc,
    Desc,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSortKey {
    #[default]
    Name,
    Modified,
    Size,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsV1 {
    pub mode: Mode,
    pub light_palette: Palette,
    pub dark_palette: Palette,
    pub page_zoom: u16,
    pub fit_diagrams: bool,
    pub sidebar_default: bool,
    pub status_visible: bool,
    pub file_sort_key: FileSortKey,
    pub file_sort_direction: FileSortDirection,
    pub remote_image_hosts: Vec<String>,
    /// How many directory levels of the working folder the explorer indexes.
    /// The single home for the default and the accepted range; the scan
    /// engine clamps against `NAVIGATION_DEPTH_MAX` before consuming it.
    pub navigation_depth: u8,
    /// Whether the right-hand "On this page" pane starts visible.
    pub toc_visible: bool,
    /// Whether the reading column fills the available reader width instead
    /// of staying on the centered measure.
    pub fit_to_view: bool,
}
/// The explorer indexing depth is a whole number of directory levels between
/// 1 and `NAVIGATION_DEPTH_MAX`, defaulting to `NAVIGATION_DEPTH_DEFAULT`.
pub const NAVIGATION_DEPTH_DEFAULT: u8 = 4;
pub const NAVIGATION_DEPTH_MAX: u8 = 8;
fn valid_depth(depth: u8) -> bool {
    (1..=NAVIGATION_DEPTH_MAX).contains(&depth)
}
impl Default for SettingsV1 {
    fn default() -> Self {
        Self {
            mode: Mode::System,
            light_palette: Palette::GithubLight,
            dark_palette: Palette::GithubDark,
            page_zoom: 100,
            fit_diagrams: true,
            sidebar_default: true,
            status_visible: true,
            file_sort_key: FileSortKey::Name,
            file_sort_direction: FileSortDirection::Asc,
            remote_image_hosts: remote_images::starter_host_list(),
            navigation_depth: NAVIGATION_DEPTH_DEFAULT,
            toc_visible: true,
            fit_to_view: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u8,
    pub revision: u32,
    pub settings: SettingsV1,
    pub notice: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub mode: Option<Mode>,
    pub light_palette: Option<Palette>,
    pub dark_palette: Option<Palette>,
    pub page_zoom: Option<u16>,
    pub fit_diagrams: Option<bool>,
    pub sidebar_default: Option<bool>,
    pub status_visible: Option<bool>,
    pub file_sort_key: Option<FileSortKey>,
    pub file_sort_direction: Option<FileSortDirection>,
    pub remote_image_hosts: Option<Vec<String>>,
    pub navigation_depth: Option<u8>,
    pub toc_visible: Option<bool>,
    pub fit_to_view: Option<bool>,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Update {
    Committed { record: Record },
    Conflict { record: Record },
}
fn unavailable() -> AppError {
    AppError::new(
        "io",
        "Preferences could not be saved. Check application configuration access and retry.",
    )
}
fn valid_zoom(zoom: u16) -> bool {
    (50..=300).contains(&zoom) && zoom.is_multiple_of(10)
}
const FALLBACK: &str = "Some saved preferences could not be loaded; valid values were kept and defaults are being used for the rest.";

pub struct SettingsStore {
    // Only native setup chooses this directory. Commands accept no path.
    directory: Option<PathBuf>,
    committed: Mutex<Record>,
    writer: Mutex<()>,
    // The derived per-host permission leases live beside the committed
    // record; they are rebuilt from it and are never a second store.
    policy: Arc<Policy>,
}
impl SettingsStore {
    pub fn load(directory: Option<PathBuf>) -> Self {
        let mut record = Record {
            version: 1,
            revision: 0,
            settings: SettingsV1::default(),
            notice: None,
        };
        let input = directory
            .as_ref()
            .map(|dir| fs::read(dir.join("settings-v1.json")));
        match input {
            Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Some(Ok(bytes)) => {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if value["version"] == 1 && value["settings"].is_object() {
                        record.revision = value["revision"]
                            .as_u64()
                            .and_then(|n| n.try_into().ok())
                            .unwrap_or_else(|| {
                                record.notice = Some(FALLBACK.into());
                                0
                            });
                        let mut fields = serde_json::to_value(SettingsV1::default())
                            .expect("settings serialize");
                        for (key, default) in fields.as_object_mut().expect("settings object") {
                            // These fields were added to version 1 after the
                            // first release; absence alone is not corruption.
                            if matches!(
                                key.as_str(),
                                "statusVisible"
                                    | "fileSortKey"
                                    | "fileSortDirection"
                                    | "navigationDepth"
                                    | "tocVisible"
                                    | "fitToView"
                            ) && value["settings"].get(key).is_none()
                            {
                                continue;
                            }
                            // The remote-image host list was added later still: an absent
                            // field keeps the confirmed starter hosts without a notice.
                            if key == "remoteImageHosts" && value["settings"].get(key).is_none() {
                                continue;
                            }
                            let candidate = &value["settings"][key];
                            if key == "remoteImageHosts" {
                                // A valid but deliberately empty list stays empty. Invalid
                                // present data falls back for this field only.
                                match serde_json::from_value::<Vec<String>>(candidate.clone()) {
                                    Ok(list) => match remote_images::canonical_host_list(&list) {
                                        Ok(canonical) => {
                                            *default = serde_json::to_value(canonical)
                                                .expect("hosts serialize");
                                        }
                                        Err(_) => record.notice = Some(FALLBACK.into()),
                                    },
                                    Err(_) => record.notice = Some(FALLBACK.into()),
                                }
                                continue;
                            }
                            let valid = match key.as_str() {
                                "mode" => serde_json::from_value::<Mode>(candidate.clone()).is_ok(),
                                "lightPalette" | "darkPalette" => {
                                    serde_json::from_value::<Palette>(candidate.clone()).is_ok()
                                }
                                "fileSortKey" => {
                                    serde_json::from_value::<FileSortKey>(candidate.clone()).is_ok()
                                }
                                "fileSortDirection" => {
                                    serde_json::from_value::<FileSortDirection>(candidate.clone())
                                        .is_ok()
                                }
                                "pageZoom" => candidate
                                    .as_u64()
                                    .and_then(|n| u16::try_from(n).ok())
                                    .is_some_and(valid_zoom),
                                "navigationDepth" => candidate
                                    .as_u64()
                                    .and_then(|n| u8::try_from(n).ok())
                                    .is_some_and(valid_depth),
                                _ => candidate.is_boolean(),
                            };
                            if valid {
                                *default = candidate.clone();
                            } else {
                                record.notice = Some(FALLBACK.into());
                            }
                        }
                        record.settings = serde_json::from_value(fields).expect("validated fields");
                    } else {
                        record.notice = Some(FALLBACK.into());
                    }
                } else {
                    record.notice = Some(FALLBACK.into());
                }
            }
            _ => record.notice = Some(FALLBACK.into()),
        }
        Self {
            directory,
            policy: Arc::new(Policy::new(&record.settings.remote_image_hosts)),
            committed: Mutex::new(record),
            writer: Mutex::new(()),
        }
    }
    /// The committed per-host permission policy derived from this record.
    pub fn policy(&self) -> Arc<Policy> {
        self.policy.clone()
    }
    pub fn get(&self) -> Result<Record, AppError> {
        self.committed
            .lock()
            .map(|record| record.clone())
            .map_err(|_| unavailable())
    }
    pub fn update(
        &self,
        expected: u32,
        patch: Patch,
        notify: impl FnOnce(&Record),
    ) -> Result<Update, AppError> {
        // Serialize writers independently; getters never wait on filesystem I/O.
        let _writer = self.writer.lock().map_err(|_| unavailable())?;
        let mut next = self.get()?;
        if next.revision != expected {
            return Ok(Update::Conflict { record: next });
        }
        if patch.page_zoom.is_some_and(|zoom| !valid_zoom(zoom)) {
            return Err(AppError::new(
                "unsupported",
                "Page zoom must be 50–300% in steps of 10%.",
            ));
        }
        if patch
            .navigation_depth
            .is_some_and(|depth| !valid_depth(depth))
        {
            return Err(AppError::new(
                "unsupported",
                "Indexing depth must be a whole number of levels between 1 and 8.",
            ));
        }
        // The whole host list is validated before any field is applied: an
        // invalid entry rejects the patch without partial mutation.
        let remote_hosts = match &patch.remote_image_hosts {
            Some(list) => Some(remote_images::canonical_host_list(list).map_err(|_| {
                AppError::new(
                    "unsupported",
                    "Remote-image hosts must be plain DNS host names such as images.example.com.",
                )
            })?),
            None => None,
        };
        if let Some(value) = patch.mode {
            next.settings.mode = value;
        }
        if let Some(value) = patch.light_palette {
            next.settings.light_palette = value;
        }
        if let Some(value) = patch.dark_palette {
            next.settings.dark_palette = value;
        }
        if let Some(value) = patch.page_zoom {
            next.settings.page_zoom = value;
        }
        if let Some(value) = patch.fit_diagrams {
            next.settings.fit_diagrams = value;
        }
        if let Some(value) = patch.sidebar_default {
            next.settings.sidebar_default = value;
        }
        if let Some(value) = patch.status_visible {
            next.settings.status_visible = value;
        }
        if let Some(value) = patch.file_sort_key {
            next.settings.file_sort_key = value;
        }
        if let Some(value) = patch.file_sort_direction {
            next.settings.file_sort_direction = value;
        }
        if let Some(value) = remote_hosts {
            next.settings.remote_image_hosts = value;
        }
        if let Some(value) = patch.navigation_depth {
            next.settings.navigation_depth = value;
        }
        if let Some(value) = patch.toc_visible {
            next.settings.toc_visible = value;
        }
        if let Some(value) = patch.fit_to_view {
            next.settings.fit_to_view = value;
        }
        next.revision = next.revision.checked_add(1).ok_or_else(unavailable)?;
        next.notice = None;
        let directory = self.directory.as_ref().ok_or_else(unavailable)?;
        fs::create_dir_all(directory).map_err(|_| unavailable())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| unavailable())?;
        serde_json::to_writer(&mut temporary, &next).map_err(|_| unavailable())?;
        temporary.flush().map_err(|_| unavailable())?;
        temporary.as_file().sync_all().map_err(|_| unavailable())?;
        temporary
            .persist(directory.join("settings-v1.json"))
            .map_err(|_| unavailable())?;
        // The record and the derived permission leases change together under
        // the single committed-policy guard. Removed hosts are revoked
        // permanently and their pending jobs are cancelled.
        {
            let mut policy = self.policy.guard();
            *self.committed.lock().map_err(|_| unavailable())? = next.clone();
            policy.replace_hosts(&next.settings.remote_image_hosts);
            debug_assert_eq!(policy.hosts(), next.settings.remote_image_hosts);
        }
        // Publish only committed snapshots, in write order, outside the record lock.
        notify(&next);
        Ok(Update::Committed { record: next })
    }
}

#[cfg(test)]
mod tests;
