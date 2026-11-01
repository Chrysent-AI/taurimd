mod documents;
mod export;
mod links;
mod media;
mod navigation;
mod navigation_cache;
mod navigation_commands;
use navigation_commands::{
    cancel_preview, complete_path, get_index, get_siblings, open_index_entry, query_index,
    read_preview, refresh_index, reveal_document, select_root,
};
mod presentation;
mod settings;
use documents::{read_document, AppError, Session, Snapshot};
use presentation::{Presentation, ReaderMenu};
use serde::Serialize;
use settings::{Patch, Record, SettingsStore, Update};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type ReaderState = Mutex<Session>;
#[tauri::command]
async fn present_reader(window: WebviewWindow, presentation: Presentation) -> Result<(), AppError> {
    settings_caller(&window)?;
    let handle = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    // All menu mutations and click restoration share the native UI thread;
    // no worker may hold the presentation lock while waiting for that thread.
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let has_document = session(&handle, &handle.state::<ReaderState>())?.has_document();
                let menu = handle.state::<ReaderMenu>();
                let mut applied = menu.applied.lock().map_err(|_| {
                    AppError::new("resourceFailure", "Menu presentation is unavailable.")
                })?;
                applied.accept(handle.label(), presentation)?;
                menu.apply(&applied, has_document).map_err(|_| {
                    AppError::new(
                        "resourceFailure",
                        "Menu presentation could not be synchronized.",
                    )
                })
            })();
            let _ = sender.try_send(result);
        })
        .map_err(|_| {
            AppError::new(
                "resourceFailure",
                "Menu presentation could not be dispatched.",
            )
        })?;
    receiver
        .recv()
        .await
        .ok_or_else(|| AppError::new("resourceFailure", "Menu presentation was interrupted."))?
}
fn session<'a>(
    window: &WebviewWindow,
    state: &'a ReaderState,
) -> Result<std::sync::MutexGuard<'a, Session>, AppError> {
    session_for_caller(window.label(), state)
}
fn session_for_caller<'a>(
    caller: &str,
    state: &'a ReaderState,
) -> Result<std::sync::MutexGuard<'a, Session>, AppError> {
    if caller != "reader" {
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
            .set_parent(&handle)
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
        session.navigation.retire_siblings();
        if session
            .navigation
            .root
            .as_ref()
            .is_some_and(|root| granted.path.starts_with(&root.path))
        {
            if let Some(worker) = &session.navigation.worker {
                worker.refresh();
            }
        }
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
    request_id: u32,
) -> Result<(), AppError> {
    let name = session(&window, &state)?.commit(request_id)?;
    if let Err(error) = window.set_title(&format!("{name} — MDViewerRSX")) {
        eprintln!("Window title update failed: {error}");
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
async fn resolve_media(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
    relative_reference: String,
) -> Result<media::Resolved, AppError> {
    let grant = media::scope(
        &*session(&window, &window.state::<ReaderState>())?,
        window.label(),
        document_id,
        revision,
    )?;
    let resolved =
        tauri::async_runtime::spawn_blocking(move || media::resolve(grant, &relative_reference))
            .await
            .map_err(|_| {
                AppError::new("resourceFailure", "Media resolution could not finish.")
            })??;
    media::insert(
        &mut *session(&window, &window.state::<ReaderState>())?,
        resolved,
    )
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Activation {
    ExternalOpened,
    Anchor {
        fragment: String,
    },
    Document {
        snapshot: Snapshot,
        fragment: Option<String>,
    },
}
fn begin_link(
    session: &mut Session,
    caller: &str,
    document_id: u32,
    revision: u32,
    request_id: u32,
) -> Result<(media::Scope, Arc<AtomicBool>), AppError> {
    let scope = media::scope(session, caller, document_id, revision)?;
    let cancel = session.begin(request_id)?;
    Ok((scope, cancel))
}
fn activate_pending_link(
    state: &ReaderState,
    scope: media::Scope,
    request_id: u32,
    cancel: &AtomicBool,
    href: &str,
    open: impl FnOnce(String) -> Result<(), AppError>,
) -> Result<Activation, AppError> {
    let current = || {
        scope.live()?;
        if cancel.load(Ordering::Relaxed) {
            Err(Session::stale())
        } else {
            Ok(())
        }
    };
    current()?;
    let destination = links::destination(&scope.parent, href);
    current()?;
    match destination? {
        links::Destination::Fragment(fragment) => Ok(Activation::Anchor { fragment }),
        links::Destination::External(url) => {
            let result = links::open_external(url, |validated| {
                current()?;
                // Cancellation is cooperative; an OS handoff already started
                // cannot be retracted, but a stale acknowledgement is suppressed.
                open(validated)
            });
            current()?;
            result?;
            Ok(Activation::ExternalOpened)
        }
        links::Destination::Document(path, fragment) => {
            let document =
                read_document(&path, Some(&scope.parent), request_id, request_id, cancel)?;
            let mut session = state.lock().map_err(|_| {
                AppError::new(
                    "resourceFailure",
                    "Reader state is unavailable. Reopen the application.",
                )
            })?;
            current()?;
            let snapshot = session.stage(request_id, document)?;
            Ok(Activation::Document { snapshot, fragment })
        }
    }
}
#[tauri::command]
async fn activate_link(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
    href: String,
    request_id: u32,
) -> Result<Activation, AppError> {
    let (scope, cancel) = begin_link(
        &mut *session(&window, &window.state::<ReaderState>())?,
        window.label(),
        document_id,
        revision,
        request_id,
    )?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        activate_pending_link(
            &handle.state::<ReaderState>(),
            scope,
            request_id,
            &cancel,
            &href,
            |validated| {
                handle
                    .opener()
                    .open_url(validated, None::<&str>)
                    .map_err(|_| {
                        AppError::new("io", "The default application could not accept this link.")
                    })
            },
        )
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Link activation could not finish."))?
}

#[tauri::command]
async fn begin_export(window: WebviewWindow, request: export::Begin) -> Result<u32, AppError> {
    let job = export::Job::enroll(
        &mut *session(&window, &window.state::<ReaderState>())?,
        window.label(),
        request,
    )?;
    let id = job.id;
    let handle = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = handle
            .path()
            .app_cache_dir()
            .map_err(|_| AppError::new("io", "Export cache is unavailable."))
            .and_then(|root| job.prepare(&root.join("diagram-exports")));
        if result.is_err() {
            let _ = job.retire();
            job.reap()?;
        }
        result
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Export preparation was interrupted."))?;
    if result.is_err() {
        release_export(&window, id);
    }
    result.map(|()| id)
}
fn release_export(window: &WebviewWindow, id: u32) {
    if let Ok(mut session) = session(window, &window.state::<ReaderState>()) {
        if session.export.as_ref().is_some_and(|job| job.id == id) {
            session.export = None;
        }
    }
}
#[tauri::command]
async fn append_export_image(window: WebviewWindow, image: export::Image) -> Result<(), AppError> {
    let job = export::Job::append_registration(
        &*session(&window, &window.state::<ReaderState>())?,
        window.label(),
        image.binding.export_id,
    )?;
    tauri::async_runtime::spawn_blocking(move || job.append_bound(&image))
        .await
        .map_err(|_| {
            AppError::new(
                "resourceFailure",
                "Export image preparation was interrupted.",
            )
        })?
}
#[tauri::command]
async fn cancel_export(window: WebviewWindow, binding: export::Binding) -> Result<(), AppError> {
    let job = {
        let state = window.state::<ReaderState>();
        let session = session(&window, &state)?;
        let job = export::Job::lookup(&session, window.label(), &binding)?;
        job.retire()?;
        job
    };
    let id = job.id;
    let result = tauri::async_runtime::spawn_blocking(move || job.reap())
        .await
        .map_err(|_| AppError::new("resourceFailure", "Export cancellation was interrupted."))?;
    release_export(&window, id);
    result
}
#[tauri::command]
async fn finish_export(
    window: WebviewWindow,
    binding: export::Binding,
) -> Result<export::Outcome, AppError> {
    let job = export::Job::lookup(
        &*session(&window, &window.state::<ReaderState>())?,
        window.label(),
        &binding,
    )?;
    let id = job.id;
    let handle = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        job.finish(
            || {
                handle
                    .dialog()
                    .file()
                    .set_parent(&handle)
                    .set_title("Export diagrams")
                    .add_filter("ZIP archive", &["zip"])
                    .set_file_name("diagrams.zip")
                    .blocking_save_file()
                    .map(|path| {
                        path.into_path().map_err(|_| {
                            AppError::new("unsupported", "Choose a local ZIP destination.")
                        })
                    })
                    .transpose()
            },
            |path| {
                handle
                    .dialog()
                    .message(format!(
                        "Replace the existing ZIP archive {}?",
                        path.display()
                    ))
                    .title("Replace ZIP archive?")
                    .parent(&handle)
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                        "Replace".into(),
                        "Cancel".into(),
                    ))
                    .blocking_show()
            },
            || job.commit_start(&*session(&handle, &handle.state::<ReaderState>())?),
        )
    })
    .await
    .map_err(|_| {
        AppError::new(
            "resourceFailure",
            "Export finishing was interrupted; check the selected destination.",
        )
    })?;
    release_export(&window, id);
    result
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

fn navigation_allowed(url: &tauri::Url, entry: &tauri::Url) -> bool {
    // Tauri's non-special release origin has an empty path; accept only its
    // equivalent root-slash spelling, not other paths or query/authority changes.
    let mut candidate = url.clone();
    candidate.set_fragment(None);
    if candidate.path().is_empty() {
        candidate.set_path("/");
    }
    let mut expected = entry.clone();
    expected.set_fragment(None);
    if expected.path().is_empty() {
        expected.set_path("/");
    }
    candidate == expected
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("reader-media", |context, request, responder| {
            let app = context.app_handle().clone();
            let caller = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                media::serve(&app.state::<ReaderState>(), &caller, request, |response| {
                    responder.respond(response)
                });
            });
        })
        .manage(ReaderState::default())
        .invoke_handler(tauri::generate_handler![
            select_document,
            reload_document,
            commit_document,
            cancel_operation,
            get_settings,
            update_settings,
            resolve_media,
            activate_link,
            present_reader,
            begin_export,
            append_export_image,
            finish_export,
            cancel_export,
            select_root,
            get_index,
            query_index,
            complete_path,
            refresh_index,
            get_siblings,
            read_preview,
            cancel_preview,
            open_index_entry,
            reveal_document
        ])
        .setup(|app| {
            app.manage(SettingsStore::load(app.path().app_config_dir().ok()));
            if let Ok(cache) = app.path().app_cache_dir() {
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = export::sweep(&cache.join("diagram-exports")) {
                        eprintln!("Export cache recovery: {}", error.message);
                    }
                });
            }
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
            let status = CheckMenuItem::with_id(
                app,
                "status-bar",
                "Show Status Bar",
                true,
                true,
                None::<&str>,
            )?;
            let guide = MenuItem::with_id(app, "guide", "User Guide", true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "About MDViewerRSX", true, None::<&str>)?;
            let information = MenuItem::with_id(
                app,
                "information",
                "Document Information…",
                false,
                None::<&str>,
            )?;
            let sidebar =
                CheckMenuItem::with_id(app, "sidebar", "Show Sidebar", true, true, None::<&str>)?;
            let alphabetical = CheckMenuItem::with_id(
                app,
                "sort-alpha",
                "Alphabetical",
                true,
                true,
                None::<&str>,
            )?;
            let newest = CheckMenuItem::with_id(
                app,
                "sort-date",
                "Newest modified",
                true,
                false,
                None::<&str>,
            )?;
            let previous =
                MenuItem::with_id(app, "previous", "Previous File", false, None::<&str>)?;
            let next = MenuItem::with_id(app, "next", "Next File", false, None::<&str>)?;
            let refresh =
                MenuItem::with_id(app, "refresh-folder", "Refresh Folder", false, None::<&str>)?;
            let quick_open =
                MenuItem::with_id(app, "quick-open", "Quick Open…", true, Some("CmdOrCtrl+K"))?;
            let find =
                MenuItem::with_id(app, "find", "Find in Document…", false, Some("CmdOrCtrl+F"))?;
            let find_next = MenuItem::with_id(
                app,
                "find-next",
                "Find Next",
                false,
                Some(if cfg!(target_os = "macos") {
                    "Cmd+G"
                } else {
                    "F3"
                }),
            )?;
            let find_previous = MenuItem::with_id(
                app,
                "find-previous",
                "Find Previous",
                false,
                Some(if cfg!(target_os = "macos") {
                    "Cmd+Shift+G"
                } else {
                    "Shift+F3"
                }),
            )?;
            let navigate = Submenu::with_items(
                app,
                "Navigate",
                true,
                &[
                    &quick_open,
                    &find,
                    &find_next,
                    &find_previous,
                    &previous,
                    &next,
                    &Submenu::with_items(app, "Sibling order", true, &[&alphabetical, &newest])?,
                    &refresh,
                ],
            )?;
            let view = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &zoom_in,
                    &zoom_out,
                    &zoom_reset,
                    &PredefinedMenuItem::separator(app)?,
                    &status,
                    &sidebar,
                ],
            )?;
            let export_svg = MenuItem::with_id(
                app,
                "export-svg",
                "Export diagrams as SVG ZIP…",
                false,
                None::<&str>,
            )?;
            let export_png = MenuItem::with_id(
                app,
                "export-png",
                "Export diagrams as PNG ZIP…",
                false,
                None::<&str>,
            )?;
            let diagram_menu =
                Submenu::with_items(app, "Diagram", true, &[&export_svg, &export_png])?;
            let open = MenuItem::with_id(app, "open", "Open File…", true, Some("CmdOrCtrl+O"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", false, Some("CmdOrCtrl+R"))?;
            let folder = MenuItem::with_id(app, "open-folder", "Open Folder…", true, None::<&str>)?;
            let reveal = MenuItem::with_id(
                app,
                "reveal",
                if cfg!(target_os = "macos") {
                    "Reveal in Finder"
                } else if cfg!(windows) {
                    "Reveal in File Explorer"
                } else {
                    "Reveal in File Manager"
                },
                false,
                None::<&str>,
            )?;
            let file = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open,
                    &folder,
                    &reveal,
                    &reload,
                    &information,
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
                            &about,
                            &settings,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &file,
                    &view,
                    &navigate,
                    &diagram_menu,
                    &Submenu::with_items(app, "Help", true, &[&guide])?,
                ],
            )?;
            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(
                app,
                &[
                    &file,
                    &view,
                    &navigate,
                    &diagram_menu,
                    &Submenu::with_items(app, "Settings", true, &[&settings])?,
                    &Submenu::with_items(app, "Help", true, &[&guide, &about])?,
                ],
            )?;
            app.set_menu(menu)?;
            app.manage(ReaderMenu {
                actions: vec![
                    ("find", find),
                    ("find-next", find_next),
                    ("find-previous", find_previous),
                    ("quick-open", quick_open),
                    ("open-folder", folder),
                    ("reveal", reveal),
                    ("previous", previous),
                    ("next", next),
                    ("refresh-folder", refresh),
                    ("export-svg", export_svg),
                    ("export-png", export_png),
                    ("open", open),
                    ("reload", reload),
                    ("information", information),
                    ("settings", settings),
                    ("guide", guide),
                    ("about", about),
                    ("zoom-in", zoom_in),
                    ("zoom-out", zoom_out),
                    ("zoom-reset", zoom_reset),
                ],
                navigation_checks: vec![
                    ("sidebar", sidebar),
                    ("sort-alpha", alphabetical),
                    ("sort-date", newest),
                ],
                status,
                applied: Mutex::new(Presentation::default()),
            });
            let config = &app.config().app.windows[0];
            let entry = if tauri::is_dev() {
                app.config()
                    .build
                    .dev_url
                    .clone()
                    .ok_or("Missing development entry URL")?
            } else {
                tauri::Url::parse(if cfg!(windows) {
                    "http://tauri.localhost/"
                } else {
                    "tauri://localhost"
                })?
            };
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(move |url| navigation_allowed(url, &entry))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .build()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(window) = app.get_webview_window("reader") {
                if window.is_focused().unwrap_or(false) {
                    let menu = app.state::<ReaderMenu>();
                    if let Ok(applied) = menu.applied.lock() {
                        if let Err(error) = menu.restore_checks(&applied) {
                            eprintln!("Menu checkmark restoration failed: {error}");
                        }
                    }
                    let _ = window.emit("menu_action", event.id().as_ref());
                }
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                if let Ok(session) = window.state::<ReaderState>().lock() {
                    if let Some(worker) = &session.navigation.worker {
                        worker.focus();
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let retired = window
                    .state::<ReaderState>()
                    .lock()
                    .ok()
                    .map(|mut session| {
                        session.close_reads();
                        if let Some(worker) = &session.navigation.worker {
                            worker.stop();
                        }
                        std::mem::take(&mut *session)
                    });
                if let Some(mut retired) = retired {
                    tauri::async_runtime::spawn_blocking(move || {
                        let worker = retired.navigation.worker.take();
                        drop(retired);
                        if let Some(worker) = worker {
                            worker.retire();
                        }
                    });
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

    fn link_fixture() -> (tempfile::TempDir, ReaderState, String) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("source.md"), "# Original").unwrap();
        std::fs::write(root.path().join("linked.md"), "# Linked").unwrap();
        std::fs::write(root.path().join("sound.wav"), b"original media").unwrap();
        let mut session = Session::default();
        let cancel = session.begin(1).unwrap();
        let document = read_document(&root.path().join("source.md"), None, 1, 1, &cancel).unwrap();
        session.stage(1, document).unwrap();
        session.commit(1).unwrap();
        let scope = media::scope(&session, "reader", 1, 1).unwrap();
        let grant = media::resolve(scope, "sound.wav").unwrap();
        let id = media::insert(&mut session, grant).unwrap().id;
        (root, Mutex::new(session), id)
    }
    fn close_link_fixture(root: tempfile::TempDir) {
        let path = root.path().to_owned();
        root.close().expect("reap owned link fixture");
        assert!(!path.exists());
    }
    #[test]
    fn link_enrollment_cancels_before_worker_dispatch_without_retiring_active_media() {
        let (root, state, id) = link_fixture();
        let active = media::scope(&state.lock().unwrap(), "reader", 1, 1).unwrap();
        assert!(begin_link(&mut state.lock().unwrap(), "other", 1, 1, 2).is_err());
        assert!(begin_link(&mut state.lock().unwrap(), "reader", 999, 1, 2).is_err());
        state.lock().unwrap().current(1).unwrap();
        for (request, href) in [(2, "https://example.invalid/"), (3, "missing.md")] {
            let (scope, cancel) =
                begin_link(&mut state.lock().unwrap(), "reader", 1, 1, request).unwrap();
            state.lock().unwrap().current(request).unwrap();
            state.lock().unwrap().cancel(request);
            let result = activate_pending_link(&state, scope, request, &cancel, href, |_| {
                panic!("cancelled handoff must not start")
            });
            // missing.md would be notFound if destination work had started.
            assert_eq!(result.err().unwrap().code, "stale");
            assert!(state.lock().unwrap().current(request).is_err());
            active.live().unwrap();
            assert!(state.lock().unwrap().media.contains_key(&id));
        }
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 4).unwrap();
        state.lock().unwrap().begin(5).unwrap();
        assert_eq!(
            activate_pending_link(
                &state,
                scope,
                4,
                &cancel,
                "https://example.invalid/",
                |_| panic!("superseded handoff")
            )
            .err()
            .unwrap()
            .code,
            "stale"
        );
        active.live().unwrap();
        assert_eq!(
            std::fs::read(root.path().join("sound.wav")).unwrap(),
            b"original media"
        );
        drop(state);
        close_link_fixture(root);
    }
    #[test]
    fn link_handoff_runs_off_lock_and_cancellation_suppresses_only_its_acknowledgement() {
        let (root, state, _) = link_fixture();
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 2).unwrap();
        let mut calls = 0;
        let result = activate_pending_link(
            &state,
            scope,
            2,
            &cancel,
            "https://example.invalid/",
            |url| {
                assert_eq!(url, "https://example.invalid/");
                assert!(state.try_lock().is_ok());
                calls += 1;
                state.lock().unwrap().cancel(2);
                Ok(())
            },
        );
        assert_eq!(calls, 1); // An already-started OS handoff is not retractable.
        assert_eq!(result.err().unwrap().code, "stale");
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 3).unwrap();
        let result = activate_pending_link(
            &state,
            scope,
            3,
            &cancel,
            "mailto:reader@example.invalid",
            |url| {
                assert_eq!(url, "mailto:reader@example.invalid");
                Ok(())
            },
        )
        .unwrap();
        assert!(matches!(result, Activation::ExternalOpened));
        drop(state);
        close_link_fixture(root);
    }
    #[test]
    fn local_links_reuse_enrolled_read_and_stage_then_preserve_last_good_on_failure() {
        let (root, state, _) = link_fixture();
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 2).unwrap();
        let result = activate_pending_link(&state, scope, 2, &cancel, "linked.md#part", |_| {
            panic!("local link must not use OS handler")
        })
        .unwrap();
        let Activation::Document { snapshot, fragment } = result else {
            panic!("expected local document");
        };
        assert_eq!(snapshot.document_id, 2);
        assert_eq!(snapshot.source, "# Linked");
        assert_eq!(fragment.as_deref(), Some("part"));
        state.lock().unwrap().commit(2).unwrap();
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 2, 2, 3).unwrap();
        let result = activate_pending_link(&state, scope, 3, &cancel, "missing.md", |_| {
            panic!("missing local link must not use OS handler")
        });
        assert_eq!(result.err().unwrap().code, "notFound");
        assert_eq!(
            state.lock().unwrap().active(2, 2).unwrap().snapshot.source,
            "# Linked"
        );
        state.lock().unwrap().cancel(3);
        assert_eq!(
            std::fs::read_to_string(root.path().join("linked.md")).unwrap(),
            "# Linked"
        );
        drop(state);
        close_link_fixture(root);
    }

    #[test]
    fn reader_navigation_allows_only_exact_entry_and_its_fragments() {
        // These are the default origins selected by the locked Tauri manager;
        // index.html is deliberately omitted from bundled app navigation.
        let actual_release = tauri::Url::parse("tauri://localhost").unwrap();
        assert_eq!(actual_release.path(), "");
        assert_ne!(
            actual_release,
            tauri::Url::parse("tauri://localhost/").unwrap()
        );
        for entry in [
            "tauri://localhost",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://localhost:1420/",
        ] {
            let entry = tauri::Url::parse(entry).unwrap();
            let mut root = entry.clone();
            root.set_path("/");
            for candidate in [&entry, &root] {
                assert!(navigation_allowed(candidate, &entry));
                let mut fragment = candidate.clone();
                fragment.set_fragment(Some("reading"));
                assert!(navigation_allowed(&fragment, &entry));
            }
            if entry.scheme() == "tauri" {
                assert!(navigation_allowed(&actual_release, &entry));
                let mut fragment = actual_release.clone();
                fragment.set_fragment(Some("reading"));
                assert!(navigation_allowed(&fragment, &entry));
            }
            for path in ["/elsewhere", "/index.html", "//", "/%2f"] {
                let mut candidate = entry.clone();
                candidate.set_path(path);
                assert!(!navigation_allowed(&candidate, &entry));
            }
            let mut query = entry.clone();
            query.set_query(Some("download=true"));
            assert!(!navigation_allowed(&query, &entry));
            for denied in [
                "https://example.invalid/",
                "reader-media://localhost/00000000000000000000000000000001",
                "tauri://other",
                "tauri://localhost:81",
                "tauri://user@localhost",
                "http://localhost:1421/",
            ] {
                assert!(!navigation_allowed(
                    &tauri::Url::parse(denied).unwrap(),
                    &entry
                ));
            }
        }
        assert_eq!(
            to_value(Activation::ExternalOpened).unwrap(),
            json!({"status": "externalOpened"})
        );
        assert_eq!(
            to_value(media::Resolved {
                id: "0".repeat(32),
                mime: "image/png"
            })
            .unwrap(),
            json!({"id": "0".repeat(32), "mime": "image/png"})
        );
    }
    #[test]
    fn reader_responses_match_the_javascript_adapter_wire_shape() {
        let snapshot = Snapshot {
            document_id: 7,
            context_id: 0,
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
                    "documentId": 7, "contextId": 0, "revision": 11, "name": "literal.log",
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
