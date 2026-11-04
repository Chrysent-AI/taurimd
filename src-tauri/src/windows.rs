use crate::{
    ReaderState,
    documents::{self, AppError, Session, Snapshot},
    presentation::Presentation,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

pub type Handle = Arc<ReaderState>;
type Origin<'a> = Option<(&'a Handle, u32, Option<&'a crate::navigation::Scope>)>;
#[derive(Clone)]
struct Pending {
    token: u32,
    path: Option<PathBuf>,
    fragment: Option<String>,
    binding: Option<(u32, u32)>,
    error: Option<AppError>,
    started: Option<u32>,
}
pub struct Reader {
    pub session: Handle,
    pub presentation: Presentation,
    pub menu_sequence: u32,
    ready: bool,
    path: Option<PathBuf>,
    pending: Option<Pending>,
}
#[derive(Default)]
pub struct Registry {
    next: u32,
    next_request: u32,
    pub readers: HashMap<String, Reader>,
    pub started: bool,
    pub incoming: Vec<Result<PathBuf, AppError>>,
    retiring: usize,
    exiting: bool,
    final_exit: bool,
}
pub type Windows = Mutex<Registry>;
fn unavailable() -> AppError {
    AppError::new("resourceFailure", "Reader windows are unavailable.")
}
pub fn handle(app: &AppHandle, label: &str) -> Result<Handle, AppError> {
    app.state::<Windows>()
        .lock()
        .map_err(|_| unavailable())?
        .readers
        .get(label)
        .map(|reader| reader.session.clone())
        .ok_or_else(Session::stale)
}
pub fn reader(window: &WebviewWindow) -> Result<Handle, AppError> {
    handle(window.app_handle(), window.label())
}
/// Drops remote grants whose host permission was revoked and releases their
/// retained bytes across every enrolled reader.
pub fn prune_remote(app: &AppHandle) {
    let registry = app.state::<Windows>();
    let Ok(windows) = registry.lock() else {
        return;
    };
    for reader in windows.readers.values() {
        if let Ok(mut session) = reader.session.lock() {
            session.prune_remote();
        }
    }
}
/// Triggers one manual rescan of every reader's watched working folder, so
/// an indexing-depth change re-indexes without waiting for the next event.
pub fn refresh_working_folders(app: &AppHandle) {
    let registry = app.state::<Windows>();
    let Ok(windows) = registry.lock() else {
        return;
    };
    for reader in windows.readers.values() {
        refresh_reader_folder(&reader.session);
    }
}
/// The per-reader rescan seam: one manual refresh of a reader's watcher
/// worker when it has one. Split from the registry loop so the rescan
/// behavior stays testable without a Tauri handle.
pub(crate) fn refresh_reader_folder(session: &Handle) {
    if let Ok(session) = session.lock()
        && let Some(worker) = &session.navigation.worker
    {
        worker.refresh();
    }
}
impl Registry {
    fn detach(&mut self, label: &str) -> Option<Reader> {
        let reader = self.readers.remove(label)?;
        if let Ok(mut session) = reader.session.lock() {
            session.closed = true;
            session.close_reads();
            session.navigation.stop();
            if let Some(job) = &session.export {
                let _ = job.retire();
            }
        }
        self.retiring += 1;
        Some(reader)
    }
    fn pending(&mut self, label: &str) -> Result<Option<Request>, AppError> {
        let reader = self.readers.get_mut(label).ok_or_else(Session::stale)?;
        reader
            .session
            .lock()
            .map_err(|_| unavailable())?
            .caller(label)?;
        reader.ready = true;
        Ok(reader
            .pending
            .as_ref()
            .filter(|pending| pending.started.is_none())
            .map(|pending| {
                if let Some(error) = &pending.error {
                    Request::Error {
                        token: pending.token,
                        error: error.clone(),
                    }
                } else if let Some((document_id, revision)) = pending.binding {
                    Request::Focus {
                        token: pending.token,
                        document_id,
                        revision,
                        fragment: pending.fragment.clone(),
                    }
                } else {
                    Request::Open {
                        token: pending.token,
                    }
                }
            }))
    }
    fn accept(&mut self, label: &str, token: u32, request: u32) -> Result<Opening, AppError> {
        let reader = self.readers.get_mut(label).ok_or_else(Session::stale)?;
        if !reader.ready {
            return Err(Session::stale());
        }
        let pending = reader
            .pending
            .as_mut()
            .filter(|pending| pending.token == token && pending.started.is_none())
            .ok_or_else(Session::stale)?;
        let path = pending.path.clone().ok_or_else(Session::stale)?;
        let cancel = reader
            .session
            .lock()
            .map_err(|_| unavailable())?
            .begin(request)?;
        pending.started = Some(request);
        Ok(Opening {
            state: reader.session.clone(),
            path,
            fragment: pending.fragment.clone(),
            cancel,
        })
    }
    fn commit(&mut self, label: &str, request: u32) -> Result<String, AppError> {
        let reader = self.readers.get_mut(label).ok_or_else(Session::stale)?;
        let mut session = reader.session.lock().map_err(|_| unavailable())?;
        let name = session.commit(request)?;
        reader.path = session.displayed().map(|document| document.path.clone());
        if reader
            .pending
            .as_ref()
            .is_some_and(|pending| pending.binding.is_some() || pending.started == Some(request))
        {
            reader.pending = None;
        }
        Ok(name)
    }
    fn cancel(&mut self, label: &str, request: u32) -> Result<(), AppError> {
        let reader = self.readers.get_mut(label).ok_or_else(Session::stale)?;
        reader
            .session
            .lock()
            .map_err(|_| unavailable())?
            .cancel(request);
        if reader
            .pending
            .as_ref()
            .is_some_and(|pending| pending.started == Some(request))
        {
            reader.pending = None;
        }
        Ok(())
    }
    fn token(&mut self) -> Result<u32, AppError> {
        self.next_request = self.next_request.checked_add(1).ok_or_else(unavailable)?;
        Ok(self.next_request)
    }
    fn reserve(
        &mut self,
        path: PathBuf,
        fragment: Option<String>,
        source: Origin<'_>,
        replace: bool,
    ) -> Result<Option<(String, bool)>, AppError> {
        source_current(source)?;
        if self.exiting {
            return Err(Session::stale());
        }
        if let Some(label) = self.owner(&path) {
            let token = self.token()?;
            let reader = self.readers.get_mut(&label).ok_or_else(Session::stale)?;
            if fragment.is_some() {
                if reader.pending.is_some() || !reader.ready {
                    return Err(Session::stale());
                }
                let session = reader.session.lock().map_err(|_| unavailable())?;
                let document = session.displayed().ok_or_else(Session::stale)?;
                if reader.presentation.busy
                    || reader.presentation.composing
                    || reader.presentation.modal != crate::presentation::Modal::None
                {
                    return Err(AppError::new(
                        "unavailable",
                        "The existing reader cannot navigate to a section while busy or in a dialog.",
                    ));
                }
                reader.pending = Some(Pending {
                    token,
                    path: None,
                    fragment,
                    binding: Some((document.snapshot.document_id, document.snapshot.revision)),
                    error: None,
                    started: None,
                });
            }
            Ok(Some((label, false)))
        } else if let Some(label) = self.reservation(&path) {
            if let Some(fragment) = fragment {
                let pending = self
                    .readers
                    .get_mut(&label)
                    .and_then(|reader| reader.pending.as_mut())
                    .ok_or_else(Session::stale)?;
                if pending.started.is_some()
                    || pending
                        .fragment
                        .as_ref()
                        .is_some_and(|current| current != &fragment)
                {
                    return Err(AppError::new(
                        "unavailable",
                        "The receiving reader is still opening this document. Try the section link again after it finishes.",
                    ));
                }
                pending.fragment = Some(fragment);
            }
            Ok(Some((label, false)))
        } else if replace {
            Ok(None)
        } else {
            let token = self.token()?;
            let label = self.enroll(Some(Pending {
                token,
                path: Some(path),
                fragment,
                binding: None,
                error: None,
                started: None,
            }))?;
            Ok(Some((label, true)))
        }
    }
    fn enroll(&mut self, pending: Option<Pending>) -> Result<String, AppError> {
        if self.exiting {
            return Err(Session::stale());
        }
        self.next = self.next.checked_add(1).ok_or_else(unavailable)?;
        let label = format!("reader-{}", self.next);
        let session = Session::enrolled(label.clone());
        self.readers.insert(
            label.clone(),
            Reader {
                session: Arc::new(Mutex::new(session)),
                presentation: Presentation::default(),
                menu_sequence: 0,
                ready: false,
                path: None,
                pending,
            },
        );
        Ok(label)
    }
    /// The cold-start decision, made in one critical section: file work that
    /// already exists — captured startup arguments, or entries queued by an
    /// early single-instance callback before setup ran — suppresses the
    /// initial empty reader, so a file launch opens only content (or error)
    /// readers; a blank launch still enrolls exactly one empty reader.
    /// `started` flips inside the same critical section, so an enqueue
    /// racing setup either queued its entries before this decision observed
    /// them, or observes `started` and drains them itself: a stranded blank
    /// window beside queued work is impossible by construction. Returns the
    /// label of the enrolled empty reader, when one was enrolled.
    fn startup(
        &mut self,
        startup: &[Result<PathBuf, AppError>],
    ) -> Result<Option<String>, AppError> {
        let work = !startup.is_empty() || !self.incoming.is_empty();
        let label = (!work).then(|| self.enroll(None)).transpose()?;
        self.started = true;
        Ok(label)
    }
    fn owns(&self, label: &str, path: &std::path::Path) -> bool {
        self.readers.get(label).is_some_and(|reader| {
            reader.path.as_deref() == Some(path)
                || reader
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.path.as_deref() == Some(path))
        })
    }
    fn owner(&self, path: &std::path::Path) -> Option<String> {
        self.readers
            .iter()
            .filter(|(_, reader)| reader.path.as_deref() == Some(path))
            .map(|(label, _)| label.clone())
            .min()
    }
    fn reservation(&self, path: &std::path::Path) -> Option<String> {
        self.readers
            .iter()
            .find(|(_, reader)| {
                reader.pending.as_ref().is_some_and(|pending| {
                    pending.path.as_deref() == Some(path) && pending.binding.is_none()
                })
            })
            .map(|(label, _)| label.clone())
    }
}
pub fn build(app: &AppHandle, label: &str) -> Result<(), AppError> {
    let mut config = app.config().app.windows[0].clone();
    config.label = label.to_owned();
    let entry = if tauri::is_dev() {
        app.config().build.dev_url.clone().ok_or_else(unavailable)?
    } else {
        tauri::Url::parse(if cfg!(windows) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost"
        })
        .map_err(|_| unavailable())?
    };
    let result = tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| {
        builder
            .on_navigation(move |url| crate::navigation_allowed(url, &entry))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()
    });
    if result.is_err() {
        close(app, label);
    }
    result.map(|_| ()).map_err(|_| {
        AppError::new(
            "resourceFailure",
            "The receiving reader could not be created.",
        )
    })
}
pub fn empty(app: &AppHandle, error: Option<AppError>) -> Result<String, AppError> {
    let label = {
        let state = app.state::<Windows>();
        let mut windows = state.lock().map_err(|_| unavailable())?;
        let token = windows.token()?;
        let pending = error.map(|error| Pending {
            token,
            path: None,
            fragment: None,
            binding: None,
            error: Some(error),
            started: None,
        });
        windows.enroll(pending)?
    };
    build(app, &label)?;
    Ok(label)
}
/// Cold-start entry point: runs the registry's atomic suppress-or-enroll
/// decision (see `Registry::startup`), then builds the empty reader when one
/// was enrolled. The caller enqueues the startup arguments afterwards;
/// because `started` is already true, that enqueue drains every queued entry
/// through the ordinary worker, early arrivals included.
pub fn startup(
    app: &AppHandle,
    startup: &[Result<PathBuf, AppError>],
) -> Result<Option<String>, AppError> {
    let label = {
        let state = app.state::<Windows>();
        let mut windows = state.lock().map_err(|_| unavailable())?;
        windows.startup(startup)?
    };
    if let Some(label) = &label {
        build(app, label)?;
    }
    Ok(label)
}
pub fn focus(app: &AppHandle, label: &str) -> Result<(), AppError> {
    handle(app, label)?;
    let window = app.get_webview_window(label).ok_or_else(Session::stale)?;
    window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus())
        .map_err(|_| AppError::new("handoff", "The receiving reader could not be activated. It may already own the document; use its window or try again."))
}
// Registry → session is the only nested lock order. I/O, construction, focus,
// notifications and retirement always happen after releasing the registry.
fn source_current(source: Origin<'_>) -> Result<(), AppError> {
    if let Some((source, request, scope)) = source {
        let session = source.lock().map_err(|_| unavailable())?;
        session.current(request)?;
        if let Some(scope) = scope {
            scope.live()?;
        }
    }
    Ok(())
}
pub fn route(
    app: &AppHandle,
    path: PathBuf,
    fragment: Option<String>,
    source: Origin<'_>,
    replace: Option<&str>,
) -> Result<bool, AppError> {
    source_current(source)?;
    let path = documents::contained_file(&path, None).map_err(|error| error.at(&path))?;
    documents::classify(&path).map_err(|error| error.at(&path))?;
    let destination = {
        let state = app.state::<Windows>();
        let mut windows = state.lock().map_err(|_| unavailable())?;
        windows.reserve(path.clone(), fragment, source, replace.is_some())?
    };
    let Some((label, create)) = destination else {
        return Ok(false);
    };
    let current = || {
        if app
            .state::<Windows>()
            .lock()
            .map_err(|_| unavailable())?
            .owns(&label, &path)
        {
            Ok(())
        } else {
            Err(AppError::new(
                "handoff",
                "The receiving reader closed or replaced this document. Open it again explicitly.",
            ))
        }
    };
    current()?;
    if create {
        build(app, &label)?;
    } else {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.emit_to(
                EventTarget::webview_window(window.label()),
                "document_requested",
                (),
            );
        }
    }
    current()?;
    focus(app, &label).map_err(|mut error| {
        error.code = "handoff";
        error
    })?;
    current()?;
    Ok(true)
}
struct Opening {
    state: Handle,
    path: PathBuf,
    fragment: Option<String>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Open {
        token: u32,
    },
    Focus {
        token: u32,
        document_id: u32,
        revision: u32,
        fragment: Option<String>,
    },
    Error {
        token: u32,
        error: AppError,
    },
}
#[tauri::command]
pub fn pending_document(window: WebviewWindow) -> Result<Option<Request>, AppError> {
    let state = window.state::<Windows>();
    let mut windows = state.lock().map_err(|_| unavailable())?;
    windows.pending(window.label())
}
#[tauri::command]
pub fn dismiss_document(window: WebviewWindow, token: u32) -> Result<(), AppError> {
    let state = window.state::<Windows>();
    let mut windows = state.lock().map_err(|_| unavailable())?;
    let reader = windows
        .readers
        .get_mut(window.label())
        .ok_or_else(Session::stale)?;
    if reader
        .pending
        .as_ref()
        .is_none_or(|pending| pending.token != token)
    {
        return Err(Session::stale());
    }
    if let Some((document, revision)) = reader.pending.as_ref().and_then(|pending| pending.binding)
    {
        reader
            .session
            .lock()
            .map_err(|_| unavailable())?
            .active_ref(document, revision)?;
    }
    if let Some(request) = reader.pending.take().and_then(|pending| pending.started) {
        reader
            .session
            .lock()
            .map_err(|_| unavailable())?
            .cancel(request);
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Received {
    pub snapshot: Snapshot,
    pub fragment: Option<String>,
}
#[tauri::command]
pub async fn receive_document(
    window: WebviewWindow,
    token: u32,
    request_id: u32,
) -> Result<Received, AppError> {
    let Opening {
        state,
        path,
        fragment,
        cancel,
    } = {
        let registry = window.state::<Windows>();
        let mut windows = registry.lock().map_err(|_| unavailable())?;
        windows.accept(window.label(), token, request_id)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let document = documents::read_document(&path, None, request_id, request_id, &cancel)?;
        let snapshot = state
            .lock()
            .map_err(|_| unavailable())?
            .stage(request_id, document)?;
        Ok(Received { snapshot, fragment })
    })
    .await
    .map_err(|_| unavailable())?
}
/// Leaves native fullscreen exactly when the calling reader window is
/// actually fullscreen, so an Escape request that no frontend surface owns
/// never disturbs an already-windowed reader. Returns whether the window
/// was fullscreen when the request arrived.
#[tauri::command]
pub fn exit_fullscreen_if(window: WebviewWindow) -> Result<bool, AppError> {
    let fullscreen = window.is_fullscreen().map_err(|_| {
        AppError::new(
            "resourceFailure",
            "The reader window's fullscreen state is unavailable.",
        )
    })?;
    if !fullscreen {
        return Ok(false);
    }
    window.set_fullscreen(false).map_err(|_| {
        AppError::new(
            "resourceFailure",
            "The reader window could not leave fullscreen.",
        )
    })?;
    Ok(true)
}
pub fn commit(window: &WebviewWindow, request: u32) -> Result<String, AppError> {
    let state = window.state::<Windows>();
    let mut windows = state.lock().map_err(|_| unavailable())?;
    windows.commit(window.label(), request)
}
pub fn cancel(window: &WebviewWindow, request: u32) -> Result<(), AppError> {
    let registry = window.state::<Windows>();
    let mut windows = registry.lock().map_err(|_| unavailable())?;
    windows.cancel(window.label(), request)
}
pub fn reopen(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let destination = app.state::<Windows>().lock().ok().and_then(|windows| {
            if !windows.started || windows.exiting {
                return None;
            }
            let empty = windows
                .readers
                .iter()
                .find(|(_, reader)| reader.path.is_none() && reader.pending.is_none())
                .map(|(label, _)| label.clone());
            Some((empty, windows.readers.is_empty()))
        });
        match destination {
            Some((Some(label), _)) => {
                let _ = focus(&app, &label);
            }
            Some((None, true)) => {
                let _ = empty(&app, None);
            }
            _ => (),
        }
    });
}
pub fn enqueue(app: &AppHandle, paths: Vec<Result<PathBuf, AppError>>) {
    let start = if let Ok(mut windows) = app.state::<Windows>().lock() {
        windows.incoming.extend(paths);
        windows.started
    } else {
        false
    };
    if start {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let paths = app
                .state::<Windows>()
                .lock()
                .map(|mut windows| std::mem::take(&mut windows.incoming))
                .unwrap_or_default();
            for path in paths {
                let result = path.and_then(|path| route(&app, path, None, None, None));
                if let Err(error) = result
                    && let Err(error) = empty(&app, Some(error))
                {
                    eprintln!("OS open: {}", error.message);
                }
            }
        });
    }
}
pub fn arguments(
    args: impl IntoIterator<Item = PathBuf>,
    cwd: Option<PathBuf>,
    lossy: bool,
) -> Vec<Result<PathBuf, AppError>> {
    args.into_iter().map(|path| {
        if lossy && (path.to_string_lossy().contains('\u{fffd}') || cwd.as_ref().is_some_and(|cwd| cwd.to_string_lossy().contains('\u{fffd}'))) {
            return Err(AppError::new("unsupported", "This forwarded filename could not be represented exactly. Use File → Open File to choose it explicitly."));
        }
        if path.is_absolute() { Ok(path) } else { cwd.as_ref().filter(|cwd| cwd.is_absolute()).map(|cwd| cwd.join(&path)).ok_or_else(|| AppError::new("denied", "The opening application's directory is unavailable. Use File → Open File.")) }
    }).collect()
}
pub fn close(app: &AppHandle, label: &str) {
    let reader = {
        let state = app.state::<Windows>();
        let Ok(mut windows) = state.lock() else {
            return;
        };
        let Some(reader) = windows.detach(label) else {
            return;
        };
        reader
    };
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = retire(reader) {
            eprintln!("Reader cleanup: {}", error.message);
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
        let exit = if let Ok(mut windows) = app.state::<Windows>().lock() {
            windows.retiring -= 1;
            let done = windows.exiting && windows.readers.is_empty() && windows.retiring == 0;
            if done {
                windows.final_exit = true;
            }
            done
        } else {
            false
        };
        if exit {
            app.exit(0);
        }
    });
}
fn retire(reader: Reader) -> Result<(), AppError> {
    let mut session = reader.session.lock().map_err(|_| unavailable())?;
    let navigation = std::mem::take(&mut session.navigation);
    let mut jobs = std::mem::take(&mut session.retired_exports);
    jobs.extend(session.export.take());
    drop(session);
    drop(navigation);
    let mut error = None;
    for job in jobs {
        if let Err(failure) = if job.retire().is_err() {
            job.wait_finished()
        } else {
            job.reap()
        } {
            error = Some(failure);
        }
    }
    error.map_or(Ok(()), Err)
}
#[cfg(test)]
mod tests;

pub fn exit(app: &AppHandle, explicit: bool) -> bool {
    let labels = {
        let state = app.state::<Windows>();
        let Ok(mut windows) = state.lock() else {
            return false;
        };
        if windows.final_exit {
            return true;
        }
        if cfg!(target_os = "macos") && !explicit {
            return false;
        }
        if windows.readers.is_empty() && windows.retiring == 0 {
            return true;
        }
        windows.exiting = true;
        windows.readers.keys().cloned().collect::<Vec<_>>()
    };
    for label in labels {
        close(app, &label);
    }
    false
}
