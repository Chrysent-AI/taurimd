use super::{ReaderState, session};
use crate::{
    documents::{AppError, Session, Snapshot},
    navigation::{self, Binding, Siblings},
    navigation_cache::{self, RootWorker, Snapshot as CacheSnapshot, Status as CacheStatus},
    settings::SettingsStore,
    windows::reader,
};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

/// Reads the configured explorer indexing depth for one worker scan.
fn explorer_depth(app: &AppHandle) -> usize {
    usize::from(
        app.state::<SettingsStore>()
            .get()
            .map(|record| record.settings.navigation_depth)
            .unwrap_or(crate::settings::NAVIGATION_DEPTH_DEFAULT),
    )
}

/// Marks the working folder unavailable for an adoption failure. The status
/// keeps its current scope identity — the default scope 0 when no root has
/// ever existed, the previous root's id otherwise — so the frontend watermark
/// accepts it either way. Returns the status for the window-local
/// announcement; the caller emits it off the session lock.
pub(crate) fn mark_root_unavailable(session: &mut Session, message: String) -> CacheStatus {
    session.navigation.status.phase = "unavailable";
    session.navigation.status.message = message;
    session.navigation.status.sequence += 1;
    session.navigation.status.clone()
}

/// Ensures the displayed document's folder is the watched working folder:
/// opening a file from a new directory retires the previous root and its
/// watcher worker and scans the new one; reopening a file from the same
/// folder keeps the root, its revision and its watcher untouched. Runs off
/// the commit path, and never fails the commit itself: folder problems
/// surface as explorer status, not dialog errors.
pub(crate) async fn adopt_working_folder(window: WebviewWindow) -> Result<(), AppError> {
    let state = reader(&window)?;
    let parent = {
        let session = session(&window, &state)?;
        let Some(document) = session.displayed() else {
            return Ok(());
        };
        document.parent.clone()
    };
    // A vanished or now-ungrantable folder cannot adopt a root. Mark the
    // status unavailable and announce it so the explorer and Quick Open show
    // the settled degradation instead of claiming an indexing pass.
    let path = match navigation::root_path(&parent) {
        Ok(path) => path,
        Err(error) => {
            let status = {
                let mut session = session(&window, &state)?;
                mark_root_unavailable(&mut session, error.message.clone())
            };
            let _ = window.emit_to(
                EventTarget::webview_window(window.label()),
                "index_status",
                status,
            );
            return Err(error);
        }
    };
    let replaced = {
        let mut session = session(&window, &state)?;
        session.navigation.adopt_root(path.clone())?
    };
    let Some((scope, retired)) = replaced else {
        return Ok(());
    };
    if let Some(old) = retired {
        old.retire();
    }
    let id = scope.id;
    let lifetime = scope.lifetime.clone();
    let worker_state = state.clone();
    let owner = window.clone();
    let worker = RootWorker::start(path, lifetime, move |work| {
        // The depth is read at scan time so a settings change takes effect
        // on the very next scan without restarting the worker.
        let app = owner.app_handle();
        navigation_cache::apply(&worker_state, id, work, explorer_depth(app), |status| {
            let _ = owner.emit_to(
                EventTarget::webview_window(owner.label()),
                "index_status",
                status,
            );
        })
    });
    let handle = window.clone();
    let mut installed = Some(match worker {
        Ok(worker) => worker,
        Err(error) => {
            let status = {
                let mut session = session(&handle, &state)?;
                if session
                    .navigation
                    .root
                    .as_ref()
                    .is_none_or(|root| root.id != id)
                {
                    return Err(error);
                }
                mark_root_unavailable(&mut session, error.message.clone())
            };
            let _ = handle.emit_to(
                EventTarget::webview_window(handle.label()),
                "index_status",
                status,
            );
            return Err(error);
        }
    });
    {
        let mut session = session(&window, &state)?;
        if session
            .navigation
            .root
            .as_ref()
            .is_some_and(|root| root.id == id)
        {
            session.navigation.worker = installed.take();
        }
    }
    if let Some(worker) = installed {
        worker.retire();
    }
    Ok(())
}

#[tauri::command]
pub fn get_index(window: WebviewWindow) -> Result<CacheSnapshot, AppError> {
    let state = reader(&window)?;
    let result = CacheSnapshot::get(&*session(&window, &state)?);
    Ok(result)
}
#[tauri::command]
pub fn refresh_index(window: WebviewWindow, scope_id: u32) -> Result<CacheSnapshot, AppError> {
    let state = reader(&window)?;
    let mut session = session(&window, &state)?;
    if session
        .navigation
        .root
        .as_ref()
        .is_none_or(|root| root.id != scope_id)
    {
        return Err(Session::stale());
    }
    session
        .navigation
        .worker
        .as_ref()
        .ok_or_else(Session::stale)?
        .refresh();
    session.navigation.status.phase = "loading";
    session.navigation.status.sequence += 1;
    Ok(CacheSnapshot::get(&session))
}
async fn search(
    window: WebviewWindow,
    request: navigation::query::Query,
    traverse: bool,
) -> Result<navigation::query::Reply, AppError> {
    let state = reader(&window)?;
    let scope = {
        let session = session(&window, &state)?;
        session.navigation.query_scope(request.scope)?
    };
    let home = window.path().home_dir().ok();
    let mut answer = tauri::async_runtime::spawn_blocking(move || {
        let answer = navigation::query::query(&scope, request, home.as_deref())?;
        if traverse && let Some(path) = &answer.missing {
            navigation::query::validate_directory(&scope, path)?;
        }
        Ok::<_, AppError>(answer)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "File filtering was interrupted."))??;
    let follow_up = {
        let session = session(&window, &state)?;
        let nav = &session.navigation;
        let current = nav.query_scope(answer.reply.scope)?;
        if current.revision != answer.reply.revision {
            return Err(Session::stale());
        }
        if traverse {
            answer.missing.take()
        } else {
            None
        }
    };
    if let Some(path) = follow_up {
        // The watched root owns the only queryable scope; its worker reads
        // the requested directory under a new revision so the retried query
        // can answer without a separate indexing step.
        let session = session(&window, &state)?;
        session
            .navigation
            .worker
            .as_ref()
            .ok_or_else(Session::stale)?
            .directory(path);
    }
    Ok(answer.reply)
}
#[tauri::command]
pub async fn query_index(
    window: WebviewWindow,
    request: navigation::query::Query,
) -> Result<navigation::query::Reply, AppError> {
    search(window, request, false).await
}
#[tauri::command]
pub async fn complete_path(
    window: WebviewWindow,
    request: navigation::query::Query,
) -> Result<navigation::query::Reply, AppError> {
    search(window, request, true).await
}
/// Sibling navigation reads the watched working folder: the displayed file's
/// neighbors are the indexed entries of its directory inside that root.
/// Before the root's scan has published (or while it is unavailable) the
/// reply carries the retained index with no active neighbor, and the next
/// root publication under a new revision re-runs the query.
#[tauri::command]
pub async fn get_siblings(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
) -> Result<Siblings, AppError> {
    let state = reader(&window)?;
    let session = session(&window, &state)?;
    let document = session.active(document_id, revision)?;
    let root = session
        .navigation
        .root
        .as_ref()
        .ok_or_else(Session::stale)?;
    if root.unpublished_or_dead() {
        let index = root.index();
        return Ok(Siblings {
            index,
            active: None,
            in_root: true,
            root_active: None,
        });
    }
    Ok(session
        .navigation
        .root_siblings(&document.path)
        .unwrap_or(Siblings {
            index: root.index(),
            active: None,
            in_root: false,
            root_active: None,
        }))
}
#[tauri::command]
pub async fn read_preview(
    window: WebviewWindow,
    binding: Binding,
    request_id: u32,
) -> Result<Snapshot, AppError> {
    let state = reader(&window)?;
    let (scope, record, cancel) = session(&window, &state)?
        .navigation
        .preview(binding, request_id)?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let document = scope.read(&record, 0, request_id, &cancel)?;
            if cancel.load(Ordering::Acquire) {
                return Err(Session::stale());
            }
            let current = session(&handle, &state)?.navigation.scope(binding.scope)?;
            current.entry(binding)?;
            Ok(document.snapshot)
        })();
        session(&handle, &state)?
            .navigation
            .cancel_preview(request_id);
        result
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Heading preview read was interrupted."))?
}
#[tauri::command]
pub fn cancel_preview(window: WebviewWindow, request_id: u32) -> Result<(), AppError> {
    let state = reader(&window)?;
    session(&window, &state)?
        .navigation
        .cancel_preview(request_id);
    Ok(())
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum EntryOpen {
    Ready { snapshot: Snapshot },
    HandedOff,
}
#[tauri::command]
pub async fn open_index_entry(
    window: WebviewWindow,
    binding: Binding,
    request_id: u32,
    new_window: Option<bool>,
) -> Result<EntryOpen, AppError> {
    let state = reader(&window)?;
    let (scope, record, cancel) = {
        let mut session = session(&window, &state)?;
        let scope = session.navigation.scope(binding.scope)?;
        let record = scope.entry(binding)?;
        let cancel = session.begin(request_id)?;
        (scope, record, cancel)
    };
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if new_window == Some(true) {
            let path = scope.validate(&record)?;
            session(&handle, &state)?.current(request_id)?;
            crate::windows::route(
                handle.app_handle(),
                path,
                None,
                Some((&state, request_id, Some(&scope))),
                None,
            )?;
            return Ok(EntryOpen::HandedOff);
        }
        let document = scope.read(&record, request_id, request_id, &cancel)?;
        let snapshot = session(&handle, &state)?.stage_navigation(request_id, document, &scope)?;
        Ok(EntryOpen::Ready { snapshot })
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The navigation read was interrupted."))?
}
pub fn reveal(
    state: &ReaderState,
    document_id: u32,
    revision: u32,
    open: impl FnOnce(&std::path::Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let lock = || {
        state
            .lock()
            .map_err(|_| AppError::new("resourceFailure", "Reader state unavailable."))
    };
    let (document, lifetime) = {
        let session = lock()?;
        (
            session.active(document_id, revision)?,
            session.media_lifetime.clone(),
        )
    };
    let path = crate::documents::contained_file(&document.path, Some(&document.parent))?;
    if path != document.path || lifetime.load(Ordering::Acquire) {
        return Err(Session::stale());
    }
    lock()?.active(document_id, revision)?;
    open(&path)
}
#[tauri::command]
pub async fn reveal_document(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
) -> Result<(), AppError> {
    let state = reader(&window)?;
    session(&window, &state)?.active(document_id, revision)?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reveal(&state, document_id, revision, |path| {
            handle.opener().reveal_item_in_dir(path).map_err(|_| {
                AppError::new("io", "The file manager could not reveal this document.")
            })
        })
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "File reveal was interrupted."))?
}
