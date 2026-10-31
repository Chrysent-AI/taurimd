mod documents;
mod links;
mod media;
mod settings;
use documents::{read_document, AppError, Session, Snapshot};
use serde::Serialize;
use settings::{Patch, Record, SettingsStore, Update};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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
            activate_link
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
