use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    pub attempted: Option<String>,
}
impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            attempted: None,
        }
    }
    pub(crate) fn at(mut self, path: &Path) -> Self {
        self.attempted = Some(path.to_string_lossy().into_owned());
        self
    }
}
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "notFound",
            std::io::ErrorKind::PermissionDenied => "denied",
            _ => "io",
        };
        Self::new(code, error.to_string())
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Markdown,
    Text,
}

pub fn classify(path: &Path) -> Result<Format, AppError> {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdown" | "mkd" | "mkdown" => Ok(Format::Markdown),
        "txt" | "log" => Ok(Format::Text),
        _ => Err(AppError::new(
            "unsupported",
            "Choose a Markdown, txt or log file.",
        )),
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub document_id: u32,
    pub context_id: u32,
    pub revision: u32,
    pub name: String,
    pub location: String,
    pub format: Format,
    pub source: String,
}
#[derive(Clone)]
pub struct GrantedDocument {
    pub path: PathBuf,
    pub parent: PathBuf,
    pub snapshot: Snapshot,
}

#[cfg(windows)]
pub(crate) fn validate_windows_path(path: &Path) -> Result<(), AppError> {
    use std::{
        ffi::OsStr,
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };
    let has_colon = |part: &OsStr| part.encode_wide().any(|unit| unit == u16::from(b':'));
    for component in path.components() {
        let denied = match component {
            Component::Prefix(prefix) => match prefix.kind() {
                // canonicalize returns the verbatim forms for ordinary files.
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => false,
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    has_colon(server) || has_colon(share)
                }
                Prefix::DeviceNS(_) | Prefix::Verbatim(_) => true,
            },
            Component::Normal(part) => has_colon(part),
            _ => false,
        };
        if denied {
            return Err(AppError::new(
                "denied",
                "Device paths and alternate data streams are not supported.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn contained_file(path: &Path, parent: Option<&Path>) -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    validate_windows_path(path)?;
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    validate_windows_path(&canonical)?;
    if parent.is_some_and(|root| !canonical.starts_with(root)) {
        return Err(AppError::new(
            "denied",
            "The file moved outside its granted directory. Choose it again with Open File.",
        ));
    }
    if !fs::metadata(&canonical)?.is_file() {
        return Err(AppError::new(
            "unsupported",
            "The selection is not a regular file.",
        ));
    }
    Ok(canonical)
}

pub fn read_document(
    path: &Path,
    parent: Option<&Path>,
    id: u32,
    revision: u32,
    cancel: &AtomicBool,
) -> Result<GrantedDocument, AppError> {
    let read = || {
        if cancel.load(Ordering::Relaxed) {
            return Err(Session::stale());
        }
        let canonical = contained_file(path, parent)?;
        let format = classify(&canonical)?;
        let file = fs::File::open(&canonical)?;
        if !file.metadata()?.is_file() {
            return Err(AppError::new(
                "unsupported",
                "The selection is not a regular file.",
            ));
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 64 * 1024];
        // No create/write handle is ever opened on a source document.
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Session::stale());
            }
            let read = (&file).read(&mut chunk)?;
            if read == 0 {
                break;
            }
            bytes.try_reserve(read).map_err(|_| {
                AppError::new("resourceFailure", "Not enough memory to read this file.")
            })?;
            bytes.extend_from_slice(&chunk[..read]);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(Session::stale());
        }
        let source = String::from_utf8(bytes).map_err(|_| {
            AppError::new(
                "invalidUtf8",
                "The file is not valid UTF-8; no content was replaced.",
            )
        })?;
        let parent = canonical
            .parent()
            .ok_or_else(|| AppError::new("denied", "The file has no containing directory."))?
            .to_path_buf();
        let snapshot = Snapshot {
            document_id: id,
            context_id: 0,
            revision,
            name: canonical
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            location: canonical.to_string_lossy().into_owned(),
            format,
            source,
        };
        Ok(GrantedDocument {
            path: canonical,
            parent,
            snapshot,
        })
    };
    read().map_err(|error: AppError| error.at(path))
}

#[derive(Default)]
pub struct Session {
    pub(crate) owner: Option<String>,
    pub(crate) closed: bool,
    pub(crate) retired_exports: Vec<Arc<crate::export::Job>>,
    pub(crate) navigation: crate::navigation::Navigation,
    pending_navigation: Option<Arc<AtomicBool>>,
    pub(crate) export: Option<Arc<crate::export::Job>>,
    latest: u32,
    cancel: Arc<AtomicBool>,
    pending: Option<GrantedDocument>,
    active: Option<GrantedDocument>,
    pub(crate) media_lifetime: Arc<AtomicBool>,
    pub(crate) media: std::collections::HashMap<String, crate::media::Grant>,
}
impl Session {
    pub fn enrolled(owner: String) -> Self {
        let mut session = Self::default();
        session.owner = Some(owner);
        session
    }
    pub fn caller(&self, caller: &str) -> Result<(), AppError> {
        if !self.closed && self.owner.as_deref().unwrap_or("reader") == caller {
            Ok(())
        } else {
            Err(AppError::new(
                "denied",
                "This reader is not enrolled or has closed.",
            ))
        }
    }
    pub fn displayed(&self) -> Option<&GrantedDocument> {
        self.active.as_ref().filter(|_| !self.closed)
    }
    pub fn close_reads(&self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.media_lifetime.store(true, Ordering::Release);
    }
    pub fn begin(&mut self, request: u32) -> Result<Arc<AtomicBool>, AppError> {
        if self.closed || request <= self.latest {
            return Err(Self::stale());
        }
        self.retire_export()?;
        self.cancel.store(true, Ordering::Relaxed);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.latest = request;
        self.pending = None;
        self.pending_navigation = None;
        Ok(self.cancel.clone())
    }
    pub fn current(&self, request: u32) -> Result<(), AppError> {
        if self.closed || self.latest != request || self.cancel.load(Ordering::Relaxed) {
            Err(Self::stale())
        } else {
            Ok(())
        }
    }
    pub fn stage(
        &mut self,
        request: u32,
        mut document: GrantedDocument,
    ) -> Result<Snapshot, AppError> {
        self.current(request)?;
        document.snapshot.context_id = self.navigation.context(&document.path)?;
        let snapshot = document.snapshot.clone();
        self.pending = Some(document);
        Ok(snapshot)
    }
    pub fn stage_navigation(
        &mut self,
        request: u32,
        document: GrantedDocument,
        scope: &crate::navigation::Scope,
    ) -> Result<Snapshot, AppError> {
        scope.live()?;
        let snapshot = self.stage(request, document)?;
        self.pending_navigation = Some(scope.cancel.clone());
        Ok(snapshot)
    }
    pub fn active(&self, id: u32, revision: u32) -> Result<GrantedDocument, AppError> {
        self.active_ref(id, revision).cloned()
    }
    pub(crate) fn active_ref(&self, id: u32, revision: u32) -> Result<&GrantedDocument, AppError> {
        if self.closed {
            return Err(Self::stale());
        }
        self.active
            .as_ref()
            .filter(|x| x.snapshot.document_id == id && x.snapshot.revision == revision)
            .ok_or_else(Self::stale)
    }
    pub fn has_document(&self) -> bool {
        self.active.is_some()
    }
    pub fn commit(&mut self, request: u32) -> Result<String, AppError> {
        self.current(request)?;
        if self
            .pending_navigation
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
        {
            return Err(Self::stale());
        }
        self.retire_export()?;
        let document = self.pending.take().ok_or_else(Self::stale)?;
        self.pending_navigation = None;
        self.navigation.retire_siblings();
        let name = document.snapshot.name.clone();
        self.media_lifetime.store(true, Ordering::Release);
        self.media.clear();
        self.media_lifetime = Arc::new(AtomicBool::new(false));
        self.active = Some(document);
        Ok(name)
    }
    fn retire_export(&mut self) -> Result<(), AppError> {
        if self.export.as_ref().is_some_and(|job| job.committing()) {
            return Err(AppError::new(
                "export",
                "Wait for the ZIP save to finish before replacing the document.",
            ));
        }
        if let Some(job) = self.export.take() {
            job.retire_detached();
            self.retired_exports.push(job);
        }
        Ok(())
    }
    pub fn cancel(&mut self, request: u32) {
        if self.latest == request {
            self.cancel.store(true, Ordering::Relaxed);
            self.pending = None;
        }
    }
    pub(crate) fn stale() -> AppError {
        AppError::new("stale", "This operation has been superseded or cancelled.")
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(job) = self.export.take() {
            job.retire_detached();
        }
        self.close_reads();
    }
}

#[cfg(test)]
mod tests;
