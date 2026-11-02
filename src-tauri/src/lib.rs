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
use documents::{AppError, Session, Snapshot, read_document};
use presentation::{Presentation, ReaderMenu};
use serde::Serialize;
use settings::{Patch, Record, SettingsStore, Update};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{
    Emitter, EventTarget, Manager, State, WebviewWindow,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod windows;
use windows::{Windows, reader};
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
                let state = reader(&handle)?;
                let has_document = session(&handle, &state)?.has_document();
                let menu = handle.state::<ReaderMenu>();
                let registry = handle.state::<Windows>();
                let applied = {
                    let mut windows = registry.lock().map_err(|_| {
                        AppError::new("resourceFailure", "Menu presentation is unavailable.")
                    })?;
                    let applied = &mut windows
                        .readers
                        .get_mut(handle.label())
                        .ok_or_else(Session::stale)?
                        .presentation;
                    applied.accept(presentation)?;
                    *applied
                };
                if handle.is_focused().unwrap_or(false) {
                    menu.apply(&applied, has_document).map_err(|_| {
                        AppError::new(
                            "resourceFailure",
                            "Menu presentation could not be synchronized.",
                        )
                    })?;
                }
                Ok(())
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
    let session = state.lock().map_err(|_| {
        AppError::new(
            "resourceFailure",
            "Reader state is unavailable. Reopen the application.",
        )
    })?;
    session.caller(caller)?;
    Ok(session)
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Selection {
    Cancelled,
    Ready { snapshot: Snapshot },
    HandedOff,
}

#[tauri::command]
async fn select_document(window: WebviewWindow, request_id: u32) -> Result<Selection, AppError> {
    let state = reader(&window)?;
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
    let app = window.app_handle().clone();
    let owner = state.clone();
    let label = window.label().to_owned();
    let document = tauri::async_runtime::spawn_blocking(move || {
        if windows::route(
            &app,
            path.clone(),
            None,
            Some((&owner, request_id, None)),
            Some(&label),
        )? {
            return Ok(None);
        }
        read_document(&path, None, request_id, request_id, &cancel).map(Some)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The document read could not finish."))??;
    let Some(document) = document else {
        return Ok(Selection::HandedOff);
    };
    let snapshot = session(&window, &state)?.stage(request_id, document)?;
    Ok(Selection::Ready { snapshot })
}
#[tauri::command]
async fn reload_document(
    window: WebviewWindow,
    request_id: u32,
    document_id: u32,
    revision: u32,
) -> Result<Snapshot, AppError> {
    let state = reader(&window)?;
    let (granted, cancel) = {
        let mut session = session(&window, &state)?;
        let granted = session.active(document_id, revision)?;
        session.navigation.retire_siblings();
        if session
            .navigation
            .root
            .as_ref()
            .is_some_and(|root| granted.path.starts_with(&root.path))
            && let Some(worker) = &session.navigation.worker
        {
            worker.refresh();
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
fn commit_document(window: WebviewWindow, request_id: u32) -> Result<(), AppError> {
    let name = windows::commit(&window, request_id)?;
    if let Err(error) = window.set_title(&format!("{name} — taurimd")) {
        let _ = window.emit_to(
            EventTarget::webview_window(window.label()),
            "reader_notice",
            "The document is displayed, but its window title could not be updated.",
        );
        eprintln!("Window title update failed: {error}");
    }
    Ok(())
}
#[tauri::command]
fn cancel_operation(window: WebviewWindow, request_id: u32) -> Result<(), AppError> {
    windows::cancel(&window, request_id)
}

#[tauri::command]
async fn resolve_media(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
    relative_reference: String,
) -> Result<media::Resolved, AppError> {
    let state = reader(&window)?;
    let grant = media::scope(
        &*session(&window, &state)?,
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
    media::insert(&mut *session(&window, &state)?, resolved)
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Activation {
    ExternalOpened,
    Anchor { fragment: String },
    HandedOff,
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
    handoff: impl FnOnce(std::path::PathBuf, Option<String>) -> Result<(), AppError>,
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
            {
                let session = state.lock().map_err(|_| {
                    AppError::new("resourceFailure", "Reader state is unavailable.")
                })?;
                session.current(request_id)?;
                if let Some(fragment) = &fragment
                    && session
                        .displayed()
                        .is_some_and(|document| document.path == path)
                {
                    return Ok(Activation::Anchor {
                        fragment: fragment.clone(),
                    });
                }
            }
            handoff(path, fragment)?;
            Ok(Activation::HandedOff)
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
    let state = reader(&window)?;
    let (scope, cancel) = begin_link(
        &mut *session(&window, &state)?,
        window.label(),
        document_id,
        revision,
        request_id,
    )?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        activate_pending_link(
            &state,
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
            |path, fragment| {
                windows::route(
                    handle.app_handle(),
                    path,
                    fragment,
                    Some((&state, request_id, None)),
                    None,
                )
                .map(|_| ())
            },
        )
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Link activation could not finish."))?
}

#[tauri::command]
async fn begin_export(window: WebviewWindow, request: export::Begin) -> Result<u32, AppError> {
    let state = reader(&window)?;
    let job = export::Job::enroll(&mut *session(&window, &state)?, window.label(), request)?;
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
    if let Ok(state) = reader(window)
        && let Ok(mut session) = session(window, &state)
        && session.export.as_ref().is_some_and(|job| job.id == id)
    {
        session.export = None;
    }
}
#[tauri::command]
async fn append_export_image(window: WebviewWindow, image: export::Image) -> Result<(), AppError> {
    let state = reader(&window)?;
    let job = export::Job::append_registration(
        &*session(&window, &state)?,
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
        let state = reader(&window)?;
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
    let state = reader(&window)?;
    let job = export::Job::lookup(&*session(&window, &state)?, window.label(), &binding)?;
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
            || job.commit_start(&*session(&handle, &state)?),
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
    let state = reader(window)?;
    session(window, &state).map(|_| ())
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
    let startup = windows::arguments(
        std::env::args_os().skip(1).map(std::path::PathBuf::from),
        std::env::current_dir().ok(),
        false,
    );
    tauri::Builder::default()
        .manage(Windows::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if args.len() <= 1 {
                windows::reopen(app);
                return;
            }
            windows::enqueue(
                app,
                windows::arguments(
                    args.into_iter().skip(1).map(std::path::PathBuf::from),
                    Some(cwd.into()),
                    true,
                ),
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("reader-media", |context, request, responder| {
            let app = context.app_handle().clone();
            let caller = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || match windows::handle(&app, &caller) {
                Ok(state) => {
                    media::serve(&state, &caller, request, |response| {
                        responder.respond(response)
                    });
                }
                Err(_) => responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(Vec::new())
                        .expect("fixed response"),
                ),
            });
        })
        .invoke_handler(tauri::generate_handler![
            windows::pending_document,
            windows::receive_document,
            windows::dismiss_document,
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
        .setup(move |app| {
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
            let about = MenuItem::with_id(app, "about", "About taurimd", true, None::<&str>)?;
            let information = MenuItem::with_id(
                app,
                "information",
                "Document Information…",
                false,
                None::<&str>,
            )?;
            let sidebar = CheckMenuItem::with_id(
                app,
                "sidebar",
                "Show Sidebar",
                true,
                true,
                Some("CmdOrCtrl+Shift+B"),
            )?;
            let appearance_system = CheckMenuItem::with_id(
                app,
                "appearance-system",
                "System",
                true,
                true,
                None::<&str>,
            )?;
            let appearance_light = CheckMenuItem::with_id(
                app,
                "appearance-light",
                "Light",
                true,
                false,
                Some("CmdOrCtrl+Shift+L"),
            )?;
            let appearance_dark = CheckMenuItem::with_id(
                app,
                "appearance-dark",
                "Dark",
                true,
                false,
                Some("CmdOrCtrl+Shift+D"),
            )?;
            let fit = CheckMenuItem::with_id(
                app,
                "fit-diagrams",
                "Fit Diagrams",
                true,
                true,
                None::<&str>,
            )?;
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
            let previous = MenuItem::with_id(
                app,
                "previous",
                "Previous File",
                false,
                Some("CmdOrCtrl+Alt+Left"),
            )?;
            let next =
                MenuItem::with_id(app, "next", "Next File", false, Some("CmdOrCtrl+Alt+Right"))?;
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
                    &Submenu::with_items(
                        app,
                        "Appearance",
                        true,
                        &[&appearance_system, &appearance_light, &appearance_dark],
                    )?,
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
                Submenu::with_items(app, "Diagram", true, &[&fit, &export_svg, &export_png])?;
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
                Some("CmdOrCtrl+Shift+R"),
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
                        "taurimd",
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
                    ("appearance-system", appearance_system),
                    ("appearance-light", appearance_light),
                    ("appearance-dark", appearance_dark),
                    ("fit-diagrams", fit),
                ],
                status,
            });
            windows::empty(app.handle(), None).map_err(|error| error.message)?;
            if let Ok(mut windows) = app.state::<Windows>().lock() {
                windows.started = true;
            }
            windows::enqueue(app.handle(), startup);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let focused = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false));
            if let Some(window) = focused {
                let delivery = app.state::<Windows>().lock().ok().and_then(|mut windows| {
                    let reader = windows.readers.get_mut(window.label())?;
                    reader.menu_sequence = reader.menu_sequence.checked_add(1)?;
                    Some((reader.presentation, reader.menu_sequence))
                });
                if let Some((presentation, sequence)) = delivery {
                    let _ = app.state::<ReaderMenu>().restore_checks(&presentation);
                    let _ = window.emit_to(
                        EventTarget::webview_window(window.label()),
                        "menu_action",
                        serde_json::json!({"actionId": event.id().as_ref(), "sequence": sequence}),
                    );
                }
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                windows::close(app, window.label());
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let applied = app.state::<Windows>().lock().ok().and_then(|windows| {
                    windows
                        .readers
                        .get(window.label())
                        .map(|reader| (reader.session.clone(), reader.presentation))
                });
                if let Some((state, presentation)) = applied
                    && let Ok(session) = state.lock()
                {
                    if let Some(worker) = &session.navigation.worker {
                        worker.focus();
                    }
                    let _ = app
                        .state::<ReaderMenu>()
                        .apply(&presentation, session.has_document());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                windows::close(app, window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("taurimd could not start")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => windows::enqueue(
                app,
                urls.into_iter()
                    .map(|url| {
                        url.to_file_path().map_err(|_| {
                            AppError::new("unsupported", "Choose a local document with Open File.")
                        })
                    })
                    .collect(),
            ),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => windows::reopen(app),
            tauri::RunEvent::ExitRequested { api, code, .. }
                if !windows::exit(app, code.is_some()) =>
            {
                api.prevent_exit()
            }
            _ => (),
        });
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
            let result = activate_pending_link(
                &state,
                scope,
                request,
                &cancel,
                href,
                |_| panic!("cancelled handoff must not start"),
                |_, _| panic!("cancelled local handoff"),
            );
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
                |_| panic!("superseded handoff"),
                |_, _| panic!("superseded local handoff"),
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
            |_, _| panic!("external URL"),
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
            |_, _| panic!("external mail"),
        )
        .unwrap();
        assert!(matches!(result, Activation::ExternalOpened));
        drop(state);
        close_link_fixture(root);
    }
    #[test]
    fn local_links_handoff_without_reading_or_replacing_origin_and_keep_last_good_on_failure() {
        let (root, state, media) = link_fixture();
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 2).unwrap();
        let result = activate_pending_link(
            &state,
            scope,
            2,
            &cancel,
            "linked.md#part",
            |_| panic!("local link must not use OS handler"),
            |path, fragment| {
                assert_eq!(path, root.path().join("linked.md").canonicalize().unwrap());
                assert_eq!(fragment.as_deref(), Some("part"));
                assert!(state.try_lock().is_ok());
                Ok(())
            },
        )
        .unwrap();
        assert!(matches!(result, Activation::HandedOff));
        assert!(state.lock().unwrap().commit(2).is_err());
        assert_eq!(
            state.lock().unwrap().active(1, 1).unwrap().snapshot.source,
            "# Original"
        );
        assert!(state.lock().unwrap().media.contains_key(&media));
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 3).unwrap();
        let result = activate_pending_link(
            &state,
            scope,
            3,
            &cancel,
            "missing.md",
            |_| panic!("missing local link must not use OS handler"),
            |_, _| panic!("missing path must not be handed off"),
        );
        assert_eq!(result.err().unwrap().code, "notFound");
        assert_eq!(
            state.lock().unwrap().active(1, 1).unwrap().snapshot.source,
            "# Original"
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
    fn current_document_file_links_return_an_anchor_without_read_or_window_handoff() {
        let (root, state, _) = link_fixture();
        let (scope, cancel) = begin_link(&mut state.lock().unwrap(), "reader", 1, 1, 2).unwrap();
        let result = activate_pending_link(
            &state,
            scope,
            2,
            &cancel,
            "source.md#original",
            |_| panic!("not an external link"),
            |_, _| panic!("already displayed in the caller"),
        )
        .unwrap();
        assert!(matches!(result, Activation::Anchor {fragment} if fragment == "original"));
        assert!(state.lock().unwrap().commit(2).is_err());
        assert_eq!(
            state.lock().unwrap().active(1, 1).unwrap().snapshot.source,
            "# Original"
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
        assert_eq!(
            to_value(EventTarget::webview_window("reader-a")).unwrap(),
            json!({"kind": "WebviewWindow", "label": "reader-a"})
        );
        assert_eq!(
            to_value(windows::Request::Focus {
                token: 1,
                document_id: 2,
                revision: 3,
                fragment: Some("section".into())
            })
            .unwrap(),
            json!({"kind": "focus", "token": 1, "document_id": 2, "revision": 3, "fragment": "section"})
        );
        assert_eq!(
            to_value(windows::Request::Open { token: 4 }).unwrap(),
            json!({"kind": "open", "token": 4})
        );
        assert_eq!(
            to_value(Selection::HandedOff).unwrap(),
            json!({"status": "handedOff"})
        );
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
