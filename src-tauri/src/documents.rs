use serde::Serialize;
use std::{
    borrow::Cow,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf, Prefix},
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

/// One in-flight remote image attempt owned by this reader.
pub struct RemoteAttempt {
    pub attempt: u32,
    pub signal: Arc<crate::remote_images::JobSignal>,
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

/// Strips the Windows verbatim prefix `fs::canonicalize` attaches, so
/// canonical paths surface as plain drive-letter or UNC paths wherever they
/// feed scope identity, prefix comparisons or display.
///
/// `\\?\C:\dir` becomes `C:\dir` and `\\?\UNC\server\share\dir` becomes
/// `\\server\share\dir`; everything else passes through unchanged. The
/// check is purely textual: canonicalize output is always absolute, and a
/// `/`-rooted non-Windows path can never carry the prefix, so the function
/// is a no-op there and safe to call unconditionally at canonicalization
/// seams. Components are never rewritten — only the prefix moves.
///
/// Stripping re-exposes the 260-character MAX_PATH limit for pathologically
/// deep trees: a plain path beyond it fails the next filesystem call where
/// the verbatim form would have succeeded. The accepted trade-off is plain
/// display paths everywhere; should a real long-path case appear, re-add
/// `\\?\` at the filesystem-call boundary instead of reverting this
/// normalization. Non-UTF-8 canonical paths are component-rebuilt rather
/// than kept verbatim, so containment against the normalized scope root
/// keeps working.
fn strip_verbatim_prefix(encoded: &str) -> Cow<'_, str> {
    // UNC first: its shorter replacement shares no prefix with the disk form.
    if let Some(rest) = encoded.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = encoded.strip_prefix(r"\\?\") {
        return Cow::Borrowed(rest);
    }
    Cow::Borrowed(encoded)
}

/// The plain prefix spelling for a verbatim prefix kind: `X:` for a disk
/// drive, `\\server\share` for a UNC server+share. `None` for anything
/// else — those prefixes keep their bytes.
fn plain_prefix(kind: Prefix<'_>) -> Option<OsString> {
    let head = match kind {
        Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut head = OsString::from(r"\\");
            head.push(server);
            head.push(r"\\");
            head.push(share);
            head
        }
        _ => return None,
    };
    Some(head)
}

/// Component seam of the rebuild, shared with its host-independent tests:
/// the respelled plain prefix, the root separator, then every component
/// except the root itself.
fn rebuild_from_prefix<'a>(
    kind: Prefix<'a>,
    components: impl Iterator<Item = Component<'a>>,
) -> Option<PathBuf> {
    let mut head = plain_prefix(kind)?;
    head.push(std::path::MAIN_SEPARATOR_STR);
    let mut plain = PathBuf::from(head);
    for component in components {
        if !matches!(component, Component::RootDir) {
            plain.push(component.as_os_str());
        }
    }
    Some(plain)
}

/// Rebuilds the plain form when a canonical path has no exact text form
/// (WTF-16 with lone surrogates): a recognized verbatim prefix is respelled
/// and the remaining components are joined byte-exact, so containment
/// against the normalized scope root keeps working; anything else keeps its
/// bytes. No path ever parses a prefix off Windows, so this is a
/// byte-preserving passthrough there.
fn rebuild_verbatim_components(path: PathBuf) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path;
    };
    // canonicalize output is the OS's fully resolved form — no interior
    // separators or dot components — so component-wise joining is exact.
    rebuild_from_prefix(prefix.kind(), components).unwrap_or(path)
}

/// Normalizes one `fs::canonicalize` result for scope identity, comparison
/// and display. Feed it only canonicalize output: stripping is safe because
/// such a path is absolute. Paths without an exact text form (WTF-16 with
/// lone surrogates) have no verbatim-prefixed text to strip, so they are
/// rebuilt component-wise instead — only the prefix moves, components stay
/// byte-exact.
pub(crate) fn normalize_canonical(path: PathBuf) -> PathBuf {
    let Some(encoded) = path.to_str() else {
        return rebuild_verbatim_components(path);
    };
    let normalized = strip_verbatim_prefix(encoded);
    if normalized == encoded {
        // Passthrough: keep the original buffer untouched.
        return path;
    }
    PathBuf::from(normalized.into_owned())
}

pub(crate) fn contained_file(path: &Path, parent: Option<&Path>) -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    validate_windows_path(path)?;
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    validate_windows_path(&canonical)?;
    // The same plain-form seam as root_path: document identity, media grants
    // and link handoffs compare and display this path against normalized
    // scope roots, so every granted path carries the prefix-free form.
    let canonical = normalize_canonical(canonical);
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
    pub(crate) remote: std::collections::HashMap<String, RemoteAttempt>,
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
        for attempt in self.remote.values() {
            attempt.signal.cancel();
        }
    }
    /// Registers a remote image attempt for one sanitizer slot. A newer
    /// attempt retires the older one; an attempt number that does not
    /// increase is refused so work is never reused within this reader.
    pub fn remote_start(
        &mut self,
        slot: &str,
        attempt: u32,
    ) -> Result<(u32, Arc<crate::remote_images::JobSignal>), AppError> {
        if slot.is_empty() {
            return Err(Self::stale());
        }
        if let Some(existing) = self.remote.get(slot) {
            if existing.attempt >= attempt {
                return Err(Self::stale());
            }
            existing.signal.cancel();
        }
        let signal = crate::remote_images::JobSignal::new();
        self.remote.insert(
            slot.to_owned(),
            RemoteAttempt {
                attempt,
                signal: signal.clone(),
            },
        );
        Ok((attempt, signal))
    }
    /// Installs the owned task of a registered attempt. A task whose attempt
    /// is no longer current is aborted instead.
    pub fn remote_attach(
        &mut self,
        slot: &str,
        attempt: u32,
        handle: tauri::async_runtime::JoinHandle<()>,
    ) {
        match self.remote.get(slot) {
            Some(entry) if entry.attempt == attempt => entry.signal.attach(handle),
            _ => handle.abort(),
        }
    }
    /// Whether the given attempt is still the current one for its slot.
    pub fn remote_live(&self, slot: &str, attempt: u32) -> bool {
        self.remote
            .get(slot)
            .is_some_and(|entry| entry.attempt == attempt && !entry.signal.cancelled())
    }
    /// Retires only the matching attempt. A stale cancel cannot retire a
    /// newer attempt.
    pub fn remote_cancel(&mut self, slot: &str, attempt: u32) -> bool {
        match self.remote.get(slot) {
            Some(entry) if entry.attempt == attempt => {
                entry.signal.cancel();
                self.remote.remove(slot);
                true
            }
            _ => false,
        }
    }
    /// Drops remote grants whose permission was revoked and releases their
    /// retained bytes.
    pub fn prune_remote(&mut self) {
        self.media.retain(|_, grant| grant.remote_leases_live());
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
        let name = document.snapshot.name.clone();
        self.media_lifetime.store(true, Ordering::Release);
        self.media.clear();
        self.media_lifetime = Arc::new(AtomicBool::new(false));
        for attempt in self.remote.values() {
            attempt.signal.cancel();
        }
        self.remote.clear();
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
