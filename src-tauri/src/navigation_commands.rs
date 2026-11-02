use super::{ReaderState, session};
use crate::{
    documents::{AppError, Session, Snapshot},
    navigation::{self, Binding, Siblings},
    navigation_cache::{self, RootWorker, Snapshot as CacheSnapshot, Status},
    windows::reader,
};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, EventTarget, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RootSelection {
    Cancelled,
    Ready { snapshot: CacheSnapshot },
}
#[tauri::command]
pub async fn select_root(
    window: WebviewWindow,
    request_id: u32,
) -> Result<RootSelection, AppError> {
    let state = reader(&window)?;
    session(&window, &state)?.navigation.choose(request_id)?;
    let handle = window.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_parent(&handle)
            .set_title("Open folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "The folder chooser failed."))?;
    session(&window, &state)?.navigation.chosen(request_id)?;
    let Some(selected) = selected else {
        return Ok(RootSelection::Cancelled);
    };
    let path = selected
        .into_path()
        .map_err(|_| AppError::new("unsupported", "Choose a local folder."))?;
    let handle = window.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let path = navigation::root_path(&path)?;
        let (id, lifetime, old) = {
            let mut session = session(&handle, &state)?;
            session.navigation.chosen(request_id)?;
            let old = session.navigation.worker.take();
            if let Some(old) = &old {
                old.stop();
            }
            let scope = session.navigation.start(path.clone(), true, false)?;
            session.navigation.status = Status {
                scope: scope.id,
                revision: scope.revision,
                phase: "loading",
                ..Status::default()
            };
            (scope.id, scope.lifetime.clone(), old)
        };
        if let Some(old) = old {
            old.retire();
        }
        let owner = handle.clone();
        let worker_state = state.clone();
        let worker = RootWorker::start(path, lifetime, move |work| {
            navigation_cache::apply(&worker_state, id, work, |status| {
                let _ = owner.emit_to(
                    EventTarget::webview_window(owner.label()),
                    "index_status",
                    status,
                );
            })
        });
        let worker = match worker {
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
                        return Err(Session::stale());
                    }
                    session.navigation.status.phase = "unavailable";
                    session.navigation.status.message = error.message.clone();
                    session.navigation.status.sequence += 1;
                    session.navigation.status.clone()
                };
                let _ = handle.emit_to(
                    EventTarget::webview_window(handle.label()),
                    "index_status",
                    status,
                );
                return Err(error);
            }
        };
        let mut worker = Some(worker);
        let snapshot = {
            let mut session = session(&handle, &state)?;
            if session
                .navigation
                .root
                .as_ref()
                .is_some_and(|root| root.id == id)
            {
                session.navigation.worker = worker.take();
                Some(CacheSnapshot::get(&session))
            } else {
                None
            }
        };
        if let Some(worker) = worker {
            worker.retire();
        }
        snapshot.ok_or_else(Session::stale)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Folder enumeration was interrupted."))??;
    Ok(RootSelection::Ready { snapshot })
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
        session
            .navigation
            .root
            .as_ref()
            .filter(|root| root.id == request.scope)
            .cloned()
            .ok_or_else(Session::stale)?
    };
    let home = window.path().home_dir().ok();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let answer = navigation::query::query(&scope, request, home.as_deref())?;
        if traverse && let Some(path) = &answer.missing {
            navigation::query::validate_directory(&scope, path)?;
        }
        Ok::<_, AppError>(answer)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "File filtering was interrupted."))??;
    let session = session(&window, &state)?;
    let current = session
        .navigation
        .root
        .as_ref()
        .ok_or_else(Session::stale)?;
    if current.id != answer.reply.scope || current.revision != answer.reply.revision {
        return Err(Session::stale());
    }
    if traverse && let Some(path) = answer.missing {
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
#[tauri::command]
pub async fn get_siblings(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
) -> Result<Siblings, AppError> {
    let state = reader(&window)?;
    let (document, scope) = {
        let mut session = session(&window, &state)?;
        let document = session.active(document_id, revision)?;
        if let Some(siblings) = session.navigation.root_siblings(&document.path) {
            return Ok(siblings);
        }
        if let Some(siblings) = session.navigation.parent_siblings(&document.path) {
            return Ok(siblings);
        }
        let scope = session
            .navigation
            .start(document.parent.clone(), false, false)?;
        (document, scope)
    };
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scope = navigation::scan(scope, false)?;
        let mut session = session(&handle, &state)?;
        session.active(document_id, revision)?;
        let index = session.navigation.publish(scope)?;
        let scope = session.navigation.scope(index.scope)?;
        let active = scope.member(&document.path);
        let root_active = session
            .navigation
            .root
            .as_ref()
            .filter(|root| root.live().is_ok())
            .and_then(|root| root.member(&document.path));
        let in_root = root_active.is_some();
        Ok(Siblings {
            index,
            active,
            in_root,
            root_active,
        })
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Sibling enumeration was interrupted."))?
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
