use super::{session, ReaderState};
use crate::{
    documents::{AppError, Session, Snapshot},
    navigation::{self, Binding, Index, Siblings},
};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RootSelection {
    Cancelled,
    Ready { index: Index },
}
#[tauri::command]
pub async fn select_root(
    window: WebviewWindow,
    request_id: u32,
) -> Result<RootSelection, AppError> {
    session(&window, &window.state::<ReaderState>())?
        .navigation
        .choose(request_id)?;
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
    session(&window, &window.state::<ReaderState>())?
        .navigation
        .chosen(request_id)?;
    let Some(selected) = selected else {
        return Ok(RootSelection::Cancelled);
    };
    let path = selected
        .into_path()
        .map_err(|_| AppError::new("unsupported", "Choose a local folder."))?;
    let handle = window.clone();
    let index = tauri::async_runtime::spawn_blocking(move || {
        let path = navigation::root_path(&path)?;
        let scope = {
            let state = handle.state::<ReaderState>();
            let mut session = session(&handle, &state)?;
            session.navigation.chosen(request_id)?;
            session.navigation.start(path, true, false)?
        };
        Ok::<Index, AppError>(scope.index())
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Folder enumeration was interrupted."))??;
    Ok(RootSelection::Ready { index })
}
#[tauri::command]
pub async fn refresh_index(
    window: WebviewWindow,
    scope_id: u32,
    request_id: u32,
) -> Result<Index, AppError> {
    let scope = {
        let state = window.state::<ReaderState>();
        let mut session = session(&window, &state)?;
        session.navigation.choose(request_id)?;
        let root = session
            .navigation
            .root
            .as_ref()
            .filter(|r| r.id == scope_id)
            .ok_or_else(Session::stale)?;
        let path = root.path.clone();
        session.navigation.start(path, true, true)?
    };
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scope = navigation::scan(scope, true)?;
        session(&handle, &handle.state::<ReaderState>())?
            .navigation
            .publish(scope)
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Folder refresh was interrupted."))?
}
#[tauri::command]
pub async fn get_siblings(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
) -> Result<Siblings, AppError> {
    let (document, scope) = {
        let state = window.state::<ReaderState>();
        let mut session = session(&window, &state)?;
        let document = session.active(document_id, revision)?;
        if let Some(siblings) = session.navigation.root_siblings(&document.path) {
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
        let state = handle.state::<ReaderState>();
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
    let (scope, record, cancel) = session(&window, &window.state::<ReaderState>())?
        .navigation
        .preview(binding, request_id)?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let document = scope.read(&record, 0, request_id, &cancel)?;
            if cancel.load(Ordering::Acquire) {
                return Err(Session::stale());
            }
            let current = session(&handle, &handle.state::<ReaderState>())?
                .navigation
                .scope(binding.scope)?;
            current.entry(binding)?;
            Ok(document.snapshot)
        })();
        session(&handle, &handle.state::<ReaderState>())?
            .navigation
            .cancel_preview(request_id);
        result
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "Heading preview read was interrupted."))?
}
#[tauri::command]
pub fn cancel_preview(window: WebviewWindow, request_id: u32) -> Result<(), AppError> {
    session(&window, &window.state::<ReaderState>())?
        .navigation
        .cancel_preview(request_id);
    Ok(())
}
#[tauri::command]
pub async fn open_index_entry(
    window: WebviewWindow,
    binding: Binding,
    request_id: u32,
) -> Result<Snapshot, AppError> {
    let (scope, record, cancel) = {
        let state = window.state::<ReaderState>();
        let mut session = session(&window, &state)?;
        let scope = session.navigation.scope(binding.scope)?;
        let record = scope.entry(binding)?;
        let cancel = session.begin(request_id)?;
        (scope, record, cancel)
    };
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document = scope.read(&record, request_id, request_id, &cancel)?;
        session(&handle, &handle.state::<ReaderState>())?
            .stage_navigation(request_id, document, &scope)
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
    // Side effect is off-lock; a handoff already started cannot be retracted.
    open(&path)
}
#[tauri::command]
pub async fn reveal_document(
    window: WebviewWindow,
    document_id: u32,
    revision: u32,
) -> Result<(), AppError> {
    session(&window, &window.state::<ReaderState>())?.active(document_id, revision)?;
    let handle = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reveal(
            &handle.state::<ReaderState>(),
            document_id,
            revision,
            |path| {
                handle.opener().reveal_item_in_dir(path).map_err(|_| {
                    AppError::new("io", "The file manager could not reveal this document.")
                })
            },
        )
    })
    .await
    .map_err(|_| AppError::new("resourceFailure", "File reveal was interrupted."))?
}
