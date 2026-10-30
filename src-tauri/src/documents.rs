use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
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
    fn at(mut self, path: &Path) -> Self {
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
fn validate_windows_path(path: &Path) -> Result<(), AppError> {
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
        let format = classify(&canonical)?;
        if !fs::metadata(&canonical)?.is_file() {
            return Err(AppError::new(
                "unsupported",
                "The selection is not a regular file.",
            ));
        }
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
    latest: u32,
    cancel: Arc<AtomicBool>,
    pending: Option<GrantedDocument>,
    active: Option<GrantedDocument>,
}
impl Session {
    pub fn begin(&mut self, request: u32) -> Result<Arc<AtomicBool>, AppError> {
        if request <= self.latest {
            return Err(Self::stale());
        }
        self.cancel.store(true, Ordering::Relaxed);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.latest = request;
        self.pending = None;
        Ok(self.cancel.clone())
    }
    pub fn current(&self, request: u32) -> Result<(), AppError> {
        if self.latest != request || self.cancel.load(Ordering::Relaxed) {
            Err(Self::stale())
        } else {
            Ok(())
        }
    }
    pub fn stage(&mut self, request: u32, document: GrantedDocument) -> Result<Snapshot, AppError> {
        self.current(request)?;
        let snapshot = document.snapshot.clone();
        self.pending = Some(document);
        Ok(snapshot)
    }
    pub fn active(&self, id: u32, revision: u32) -> Result<GrantedDocument, AppError> {
        self.active
            .as_ref()
            .filter(|x| x.snapshot.document_id == id && x.snapshot.revision == revision)
            .cloned()
            .ok_or_else(Self::stale)
    }
    pub fn commit(&mut self, request: u32) -> Result<String, AppError> {
        self.current(request)?;
        let document = self.pending.take().ok_or_else(Self::stale)?;
        let name = document.snapshot.name.clone();
        self.active = Some(document);
        Ok(name)
    }
    pub fn cancel(&mut self, request: u32) {
        if self.latest == request {
            self.cancel.store(true, Ordering::Relaxed);
            self.pending = None;
        }
    }
    fn stale() -> AppError {
        AppError::new("stale", "This operation has been superseded or cancelled.")
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests;
