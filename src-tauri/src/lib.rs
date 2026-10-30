mod documents;
mod settings;
use documents::{read_document, AppError, Session, Snapshot};
use serde::Serialize;
use settings::{Patch, Record, SettingsStore, Update};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;

type ReaderState = Mutex<Session>;
struct ReloadMenu {
    item: MenuItem<tauri::Wry>,
}
fn session<'a>(
    window: &WebviewWindow,
    state: &'a ReaderState,
) -> Result<std::sync::MutexGuard<'a, Session>, AppError> {
    if window.label() != "reader" {
        return Err(AppError::new(
            "denied",
            "This window has no document grant.",
        ));
    }
    state.lock().map_err(|_| {
        AppError::new(
            "resourceFailure",
            "Reader state is unavailable. Reopen the application.",
        )
    })
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Selection {
    Cancelled,
    Ready { snapshot: Snapshot },
}

#[tauri::command]
async fn select_document(
    window: WebviewWindow,
    state: State<'_, ReaderState>,
    request_id: u32,
) -> Result<Selection, AppError> {
    let cancel = session(&window, &state)?.begin(request_id)?;
    let handle = window.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Open document")
            .add_filter(
                "Documents",
                &["md", "markdown", "mdown", "mkd", "mkdown", "txt", "log"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The native file chooser failed."))?;
    session(&window, &state)?.current(request_id)?;
    let Some(selected) = selected else {
        return Ok(Selection::Cancelled);
    };
    let path = selected
        .into_path()
        .map_err(|_| AppError::new("unsupported", "Choose a local file."))?;
    let document = tauri::async_runtime::spawn_blocking(move || {
        read_document(&path, None, request_id, request_id, &cancel)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The document read could not finish."))??;
    let snapshot = session(&window, &state)?.stage(request_id, document)?;
    Ok(Selection::Ready { snapshot })
}
#[tauri::command]
async fn reload_document(
    window: WebviewWindow,
    state: State<'_, ReaderState>,
    request_id: u32,
    document_id: u32,
    revision: u32,
) -> Result<Snapshot, AppError> {
    let (granted, cancel) = {
        let mut session = session(&window, &state)?;
        let granted = session.active(document_id, revision)?;
        let cancel = session.begin(request_id)?;
        (granted, cancel)
    };
    let document = tauri::async_runtime::spawn_blocking(move || {
        read_document(
            &granted.path,
            Some(&granted.parent),
            document_id,
            request_id,
            &cancel,
        )
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The document reload could not finish."))??;
    session(&window, &state)?.stage(request_id, document)
}
#[tauri::command]
fn commit_document(
    window: WebviewWindow,
    state: State<'_, ReaderState>,
    reload_menu: State<'_, ReloadMenu>,
    request_id: u32,
) -> Result<(), AppError> {
    let name = session(&window, &state)?.commit(request_id)?;
    if let Err(error) = window.set_title(&format!("{name} — MDViewerRSX")) {
        eprintln!("Window title update failed: {error}");
    }
    if let Err(error) = reload_menu.item.set_enabled(true) {
        eprintln!("Reload menu enablement failed: {error}");
    }
    Ok(())
}
#[tauri::command]
fn cancel_operation(
    window: WebviewWindow,
    state: State<'_, ReaderState>,
    request_id: u32,
) -> Result<(), AppError> {
    session(&window, &state)?.cancel(request_id);
    Ok(())
}

#[tauri::command]
fn get_settings(
    window: WebviewWindow,
    store: State<'_, SettingsStore>,
) -> Result<Record, AppError> {
    settings_caller(&window)?;
    store.get()
}
fn settings_caller(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == "reader" {
        Ok(())
    } else {
        Err(AppError::new(
            "denied",
            "This window has no preferences access.",
        ))
    }
}
#[tauri::command]
async fn update_settings(
    window: WebviewWindow,
    expected_revision: u32,
    patch: Patch,
) -> Result<Update, AppError> {
    settings_caller(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SettingsStore>()
            .update(expected_revision, patch, |record| {
                if let Err(error) = app.emit("settings_changed", record) {
                    eprintln!("Preferences notification failed: {error}");
                }
            })
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Preferences save could not finish."))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ReaderState::default())
        .invoke_handler(tauri::generate_handler![
            select_document,
            reload_document,
            commit_document,
            cancel_operation,
            get_settings,
            update_settings
        ])
        .setup(|app| {
            app.manage(SettingsStore::load(app.path().app_config_dir().ok()));
            let settings =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let zoom_in = MenuItem::with_id(
                app,
                "zoom-in",
                "Increase Page Zoom",
                true,
                Some("CmdOrCtrl+="),
            )?;
            let zoom_out = MenuItem::with_id(
                app,
                "zoom-out",
                "Decrease Page Zoom",
                true,
                Some("CmdOrCtrl+-"),
            )?;
            let zoom_reset = MenuItem::with_id(
                app,
                "zoom-reset",
                "Reset Page Zoom",
                true,
                Some("CmdOrCtrl+0"),
            )?;
            let view = Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &zoom_reset])?;
            let open = MenuItem::with_id(app, "open", "Open File…", true, Some("CmdOrCtrl+O"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", false, Some("CmdOrCtrl+R"))?;
            let file = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open,
                    &reload,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;
            #[cfg(target_os = "macos")]
            let menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "MDViewerRSX",
                        true,
                        &[
                            &settings,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &file,
                    &view,
                ],
            )?;
            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(
                app,
                &[
                    &file,
                    &view,
                    &Submenu::with_items(app, "Settings", true, &[&settings])?,
                ],
            )?;
            app.set_menu(menu)?;
            app.manage(ReloadMenu { item: reload });
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(window) = app.get_webview_window("reader") {
                if window.is_focused().unwrap_or(false) {
                    let _ = window.emit("menu_action", event.id().as_ref());
                }
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut session) = window.state::<ReaderState>().lock() {
                    *session = Session::default();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("MDViewerRSX could not start");
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use documents::Format;
    use serde_json::{json, to_value};

    #[test]
    fn reader_responses_match_the_javascript_adapter_wire_shape() {
        let snapshot = Snapshot {
            document_id: 7,
            revision: 11,
            name: "literal.log".into(),
            location: "fixture/literal.log".into(),
            format: Format::Text,
            source: "<script>literal</script>".into(),
        };
        assert_eq!(
            to_value(Selection::Cancelled).unwrap(),
            json!({"status": "cancelled"})
        );
        assert_eq!(
            to_value(Selection::Ready { snapshot }).unwrap(),
            json!({
                "status": "ready",
                "snapshot": {
                    "documentId": 7, "revision": 11, "name": "literal.log",
                    "location": "fixture/literal.log", "format": "text",
                    "source": "<script>literal</script>"
                }
            })
        );
        assert_eq!(
            to_value(AppError::new("invalidUtf8", "Not UTF-8")).unwrap(),
            json!({
                "code": "invalidUtf8", "message": "Not UTF-8", "attempted": null
            })
        );
    }
}
