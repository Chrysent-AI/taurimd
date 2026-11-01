use crate::documents::{AppError, Session};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};
use tempfile::TempPath;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

// Test observations evaluate each operation once and return its original result.
macro_rules! observed {
    (io $operation:literal, $result:expr) => {{
        let result = $result;
        #[cfg(test)]
        tests::observe_io($operation, &result);
        result
    }};
    ($operation:literal, $result:expr) => {{
        let result = $result;
        #[cfg(test)]
        tests::observe_operation($operation, result.is_err());
        result
    }};
}

fn failure(message: impl Into<String>) -> AppError {
    AppError::new("export", message)
}
fn invalid() -> AppError {
    failure("Invalid export transaction or image payload.")
}
fn zip_error(error: zip::result::ZipError) -> AppError {
    failure(format!("ZIP preparation failed: {error}"))
}
fn ordinary(path: &Path, directory: bool) -> Result<fs::Metadata, AppError> {
    let meta = observed!(io "ordinary.metadata", fs::symlink_metadata(path))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(failure("Reparse destinations are not supported."));
        }
    }
    if meta.file_type().is_symlink()
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        })
    {
        return Err(failure(
            "Export paths must be ordinary files and directories, not links.",
        ));
    }
    Ok(meta)
}

// Automatic pathname-only deletion is disabled. Explicit cleanup compares the
// live original handle with the current ordinary path before removing it.
struct OwnedPath {
    path: PathBuf,
    identity: Option<Handle>,
    directory: bool,
}
impl OwnedPath {
    fn file(path: PathBuf, file: &File) -> Result<Self, AppError> {
        Ok(Self {
            path,
            identity: Some(
                observed!(io "owned.file.identity", Handle::from_file(observed!(io "owned.file.clone", file.try_clone())?))?,
            ),
            directory: false,
        })
    }
    fn directory(path: PathBuf) -> Result<Self, AppError> {
        Ok(Self {
            identity: Some(observed!(io "owned.directory.identity", Handle::from_path(&path))?),
            path,
            directory: true,
        })
    }
    fn check(&self) -> Result<(), AppError> {
        ordinary(&self.path, self.directory)?;
        if self.identity.as_ref()
            != Some(&observed!(io "owned.check.identity", Handle::from_path(&self.path))?)
        {
            return Err(failure(
                "Temporary export path changed identity; it was preserved, not deleted.",
            ));
        }
        Ok(())
    }
    fn remove(&mut self) -> Result<(), AppError> {
        if self.identity.is_none() {
            return Ok(());
        }
        match observed!(io "owned.remove.metadata", fs::symlink_metadata(&self.path)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.identity = None;
                return Ok(());
            }
            result => {
                result?;
            }
        }
        self.check()?;
        // Retain the original handle on failure so a retry can revalidate it.
        // Windows handles here retain std's default delete-sharing access.
        if self.directory {
            observed!(io "owned.remove.directory", fs::remove_dir(&self.path))?;
        } else {
            observed!(io "owned.remove.file", fs::remove_file(&self.path))?;
        }
        self.identity = None;
        Ok(())
    }
}
impl Drop for OwnedPath {
    fn drop(&mut self) {
        if let Err(error) = self.remove() {
            eprintln!("Export cleanup: {}", error.message);
        }
    }
}
fn combined<T>(result: Result<T, AppError>, cleanup: Result<(), AppError>) -> Result<T, AppError> {
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(failure(format!(
            "{} Cleanup also failed: {}",
            error.message, cleanup.message
        ))),
    }
}
fn coordinate(root: &Path) -> Result<File, AppError> {
    observed!(io "coordination.create_directory", fs::create_dir_all(root))?;
    ordinary(root, true)?;
    let path = root.join("coordination.lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ordinary(&path, false)?;
            observed!(io "coordination.open", OpenOptions::new().read(true).write(true).open(path))?
        }
        Err(error) => return observed!(io "coordination.create", Err(error)).map_err(Into::into),
    };
    observed!(io "coordination.lock", file.lock())?;
    Ok(file)
}
struct Archive {
    root: PathBuf,
    run: OwnedPath,
    owner: OwnedPath,
    lock: Option<File>,
    archive: OwnedPath,
    writer: Option<ZipWriter<File>>,
    file: Option<File>,
}
impl Archive {
    fn create(root: &Path) -> Result<Self, AppError> {
        let _coordination = coordinate(root)?;
        let run = tempfile::Builder::new()
            .prefix("run-")
            .disable_cleanup(true)
            .tempdir_in(root)?
            .keep();
        let run = OwnedPath::directory(run)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(run.path.join("owner.lock"))?;
        let owner = OwnedPath::file(run.path.join("owner.lock"), &lock)?;
        lock.lock()?;
        let path = run.path.join("archive.zip.part");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        let archive = OwnedPath::file(path, &file)?;
        let writer = Some(ZipWriter::new(file.try_clone()?));
        Ok(Self {
            root: root.to_owned(),
            run,
            owner,
            lock: Some(lock),
            archive,
            writer,
            file: Some(file),
        })
    }
    fn finish(&mut self) -> Result<(), AppError> {
        let mut file = observed!(
            "archive.finish",
            self.writer
                .take()
                .ok_or_else(invalid)?
                .finish()
                .map_err(zip_error)
        )?;
        observed!(io "archive.flush", file.flush())?;
        observed!(io "archive.sync", file.sync_all())?;
        Ok(())
    }
    fn cleanup(&mut self) -> Result<(), AppError> {
        let _coordination = observed!("cache.cleanup.coordination", coordinate(&self.root))?;
        self.writer = None;
        self.file = None;
        observed!("cache.cleanup.archive", self.archive.remove())?;
        self.lock = None;
        observed!("cache.cleanup.owner", self.owner.remove())?;
        observed!("cache.cleanup.run", self.run.remove())
    }
}
impl Drop for Archive {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("Export cleanup: {}", error.message);
        }
    }
}

pub fn sweep(root: &Path) -> Result<(), AppError> {
    let _coordination = coordinate(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("run-")
            || name.len() != 10
            || !name[4..].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            continue;
        }
        let path = entry.path();
        if ordinary(&path, true).is_err() {
            continue;
        }
        let mut run = OwnedPath::directory(path.clone())?;
        let files = fs::read_dir(&path)?.collect::<Result<Vec<_>, _>>()?;
        if files.is_empty() {
            run.remove()?;
            continue;
        }
        // Unknown contents and all live/uncertain owners are left untouched.
        if files.iter().any(|item| {
            !["owner.lock", "archive.zip.part"]
                .iter()
                .any(|name| item.file_name() == *name)
                || ordinary(&item.path(), false).is_err()
        }) {
            run.identity = None;
            continue;
        }
        let owner_path = path.join("owner.lock");
        if ordinary(&owner_path, false).is_err() {
            run.identity = None;
            continue;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&owner_path)?;
        if lock.try_lock().is_err() {
            run.identity = None;
            continue;
        }
        let mut owner = OwnedPath::file(owner_path, &lock)?;
        let archive = path.join("archive.zip.part");
        if archive.exists() {
            let file = File::open(&archive)?;
            let mut owned = OwnedPath::file(archive, &file)?;
            drop(file);
            owned.remove()?;
        }
        drop(lock);
        owner.remove()?;
        run.remove()?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Svg,
    Png,
}
impl Mode {
    fn extension(self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::Png => "png",
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Begin {
    pub document_id: u32,
    pub revision: u32,
    pub mode: Mode,
    pub ordinals: Vec<u32>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub export_id: u32,
    pub document_id: u32,
    pub revision: u32,
    pub mode: Mode,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub binding: Binding,
    pub ordinal: u32,
    pub bytes: Vec<u8>,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Cancelled,
    Committed { location: String, count: usize },
}
#[derive(Default)]
struct Prepared {
    archive: Option<Archive>,
    stage: Option<Stage>,
}
static NEXT: AtomicU32 = AtomicU32::new(1);
// 0 preparing/waiting, 1 retired, 2 non-cancellable commit, 3 terminal.
pub struct Job {
    pub id: u32,
    begin: Begin,
    phase: AtomicU8,
    io: Mutex<Prepared>,
    accepted: Mutex<usize>,
    finished: (Mutex<bool>, std::sync::Condvar),
}
impl Job {
    pub fn enroll(
        session: &mut Session,
        caller: &str,
        begin: Begin,
    ) -> Result<Arc<Self>, AppError> {
        session.caller(caller)?;
        session.active_ref(begin.document_id, begin.revision)?;
        if begin.ordinals.is_empty()
            || begin.ordinals[0] == 0
            || begin.ordinals.windows(2).any(|pair| pair[0] >= pair[1])
            || session.export.is_some()
        {
            return Err(invalid());
        }
        let id = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| invalid())?;
        let job = Arc::new(Self {
            id,
            begin,
            phase: AtomicU8::new(0),
            io: Mutex::new(Prepared::default()),
            accepted: Mutex::new(0),
            finished: (Mutex::new(false), std::sync::Condvar::new()),
        });
        session.export = Some(job.clone());
        Ok(job)
    }
    pub fn lookup(
        session: &Session,
        caller: &str,
        binding: &Binding,
    ) -> Result<Arc<Self>, AppError> {
        session.caller(caller)?;
        session.active_ref(binding.document_id, binding.revision)?;
        session
            .export
            .as_ref()
            .filter(|job| {
                job.id == binding.export_id
                    && job.begin.document_id == binding.document_id
                    && job.begin.revision == binding.revision
                    && job.begin.mode == binding.mode
            })
            .cloned()
            .ok_or_else(invalid)
    }
    pub fn append_registration(
        session: &Session,
        caller: &str,
        id: u32,
    ) -> Result<Arc<Self>, AppError> {
        session.caller(caller)?;
        session
            .export
            .as_ref()
            .filter(|job| job.id == id)
            .cloned()
            .ok_or_else(invalid)
    }
    pub fn append_bound(&self, image: &Image) -> Result<(), AppError> {
        let binding = &image.binding;
        if binding.export_id != self.id
            || binding.document_id != self.begin.document_id
            || binding.revision != self.begin.revision
            || binding.mode != self.begin.mode
        {
            self.retire()?;
            return combined(Err(invalid()), self.reap());
        }
        self.append(image.ordinal, &image.bytes)
    }
    fn live(&self) -> Result<(), AppError> {
        if self.phase.load(Ordering::Acquire) == 0 {
            Ok(())
        } else {
            Err(Session::stale())
        }
    }
    pub fn wait_finished(&self) -> Result<(), AppError> {
        let (lock, wake) = &self.finished;
        let mut finished = lock.lock().map_err(|_| invalid())?;
        while !*finished {
            finished = wake.wait(finished).map_err(|_| invalid())?;
        }
        Ok(())
    }
    pub fn committing(&self) -> bool {
        self.phase.load(Ordering::Acquire) == 2
    }
    pub fn retire(&self) -> Result<(), AppError> {
        match self
            .phase
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) | Err(1 | 3) => Ok(()),
            _ => Err(failure("Saving has started and cannot be cancelled.")),
        }
    }
    pub fn reap(&self) -> Result<(), AppError> {
        let mut io = self.io.lock().map_err(|_| invalid())?;
        let archive = Self::clear_archive(&mut io);
        let stage = if let Some(stage) = io.stage.as_mut() {
            stage.owned.remove()
        } else {
            Ok(())
        };
        if stage.is_ok() {
            io.stage = None;
        }
        combined(archive, stage)
    }
    fn clear_archive(io: &mut Prepared) -> Result<(), AppError> {
        if let Some(archive) = io.archive.as_mut() {
            archive.cleanup()?;
        }
        io.archive = None;
        Ok(())
    }
    pub fn retire_detached(self: &Arc<Self>) {
        if self.retire().is_ok() {
            let job = self.clone();
            std::thread::spawn(move || {
                if let Err(error) = job.reap() {
                    eprintln!("Export retirement cleanup: {}", error.message);
                }
            });
        }
    }
    pub fn prepare(&self, root: &Path) -> Result<(), AppError> {
        let mut io = self.io.lock().map_err(|_| invalid())?;
        self.live()?;
        io.archive = Some(Archive::create(root)?);
        self.live()
    }
    pub fn append(&self, ordinal: u32, bytes: &[u8]) -> Result<(), AppError> {
        let result = (|| {
            let mut io = self.io.lock().map_err(|_| invalid())?;
            self.live()?;
            let mut accepted = self.accepted.lock().map_err(|_| invalid())?;
            if self.begin.ordinals.get(*accepted) != Some(&ordinal) {
                return Err(invalid());
            }
            validate_payload(self.begin.mode, bytes)?;
            let writer = io
                .archive
                .as_mut()
                .and_then(|archive| archive.writer.as_mut())
                .ok_or_else(invalid)?;
            writer
                .start_file(
                    format!("diagram-{ordinal:03}.{}", self.begin.mode.extension()),
                    SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
                )
                .map_err(zip_error)?;
            writer.write_all(bytes)?;
            self.live()?;
            *accepted += 1;
            Ok(())
        })();
        if result.is_err() {
            let _ = self.retire();
            return combined(result, self.reap());
        }
        result
    }
    pub fn finalize(&self) -> Result<(), AppError> {
        let mut io = self.io.lock().map_err(|_| invalid())?;
        self.live()?;
        if *self.accepted.lock().map_err(|_| invalid())? != self.begin.ordinals.len() {
            return Err(invalid());
        }
        io.archive.as_mut().ok_or_else(invalid)?.finish()?;
        self.live()
    }
    pub fn commit_start(&self, session: &Session) -> Result<(), AppError> {
        session.active_ref(self.begin.document_id, self.begin.revision)?;
        if session.export.as_ref().is_none_or(|job| job.id != self.id) {
            return Err(Session::stale());
        }
        self.phase
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Session::stale())?;
        Ok(())
    }
    pub fn finish(
        &self,
        select: impl FnOnce() -> Result<Option<PathBuf>, AppError>,
        replace: impl FnOnce(&Path) -> bool,
        commit_start: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<Outcome, AppError> {
        let result: Result<Outcome, AppError> = (|| {
            observed!("finish.finalize", self.finalize())?;
            let Some(path) = select()? else {
                return Ok(Outcome::Cancelled);
            };
            self.live()?;
            let destination = observed!("destination.select", Destination::select(path))?;
            if destination.existing.is_some() && !replace(&destination.path) {
                return Ok(Outcome::Cancelled);
            }
            self.live()?;
            observed!("destination.check.before_stage", destination.check())?;
            observed!("stage.create_and_copy", self.stage(&destination.parent))?;
            self.live()?;
            observed!("destination.check.after_stage", destination.check())?;
            {
                let mut io = self.io.lock().map_err(|_| invalid())?;
                self.live()?;
                observed!("cache.clear.before_commit", Self::clear_archive(&mut io))?;
                observed!(
                    "stage.check.after_copy",
                    io.stage.as_ref().ok_or_else(invalid)?.owned.check()
                )?;
            }
            self.live()?;
            observed!("destination.check.before_commit", destination.check())?;
            // Session authority is acquired only after releasing export I/O.
            observed!("commit.start", commit_start())?;
            {
                let mut io = self.io.lock().map_err(|_| invalid())?;
                let stage = io.stage.as_mut().ok_or_else(invalid)?;
                observed!("stage.check.before_persist", stage.owned.check())?;
                observed!("stage.persist", stage.persist(&destination.path))?;
                io.stage = None;
            }
            self.phase.store(3, Ordering::Release);
            Ok(Outcome::Committed {
                location: destination.path.to_string_lossy().into_owned(),
                count: self.begin.ordinals.len(),
            })
        })();
        if self.phase.load(Ordering::Acquire) != 3 {
            let _ = self.retire();
        }
        let result = if matches!(&result, Err(error) if error.code == "stale")
            && self.phase.load(Ordering::Acquire) == 1
        {
            Ok(Outcome::Cancelled)
        } else {
            result
        };
        #[cfg(test)]
        tests::observe_before_reap(self, &result);
        let result = combined(result, self.reap());
        if let Ok(mut finished) = self.finished.0.lock() {
            *finished = true;
            self.finished.1.notify_all();
        }
        result
    }
    fn stage(&self, parent: &Path) -> Result<(), AppError> {
        let mut io = self.io.lock().map_err(|_| invalid())?;
        self.live()?;
        io.stage = Some(Stage::create(parent)?);
        let Prepared { archive, stage } = &mut *io;
        let archive = archive.as_mut().ok_or_else(invalid)?;
        observed!("stage.input.identity", archive.archive.check())?;
        let file = archive.file.as_mut().ok_or_else(invalid)?;
        observed!(io "stage.input.rewind", file.seek(SeekFrom::Start(0)))?;
        let stage = stage.as_ref().ok_or_else(invalid)?;
        let mut output = observed!(io "stage.output.open", OpenOptions::new().write(true).open(&stage.owned.path))?;
        copy_checked(file, &mut output, || self.live(), File::sync_all)
    }
}
fn copy_checked<W: Write>(
    input: &mut impl Read,
    output: &mut W,
    live: impl Fn() -> Result<(), AppError>,
    sync: impl FnOnce(&W) -> std::io::Result<()>,
) -> Result<(), AppError> {
    let mut chunk = [0; 64 * 1024];
    loop {
        live()?;
        let read = observed!(io "stage.copy.read", input.read(&mut chunk))?;
        if read == 0 {
            break;
        }
        observed!(io "stage.copy.write", output.write_all(&chunk[..read]))?;
    }
    observed!(io "stage.copy.flush", output.flush())?;
    observed!(io "stage.copy.sync", sync(output))?;
    live()
}
fn complete_png(bytes: &[u8]) -> bool {
    let mut offset = 8usize;
    let mut data = false;
    while let Some(header) = bytes.get(offset..offset.saturating_add(8)) {
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let Some(end) = offset.checked_add(length).and_then(|n| n.checked_add(12)) else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        if &header[4..] == b"IDAT" && length > 0 {
            data = true;
        }
        if &header[4..] == b"IEND" {
            return length == 0 && end == bytes.len() && data;
        }
        offset = end;
    }
    false
}
fn validate_payload(mode: Mode, bytes: &[u8]) -> Result<(), AppError> {
    let valid = match mode {
        Mode::Svg => std::str::from_utf8(bytes).ok().is_some_and(|svg| {
            svg.starts_with("<svg ")
                && svg.trim_end().ends_with("</svg>")
                && svg.contains("xmlns=\"http://www.w3.org/2000/svg\"")
                && svg.contains("viewBox=\"")
        }),
        Mode::Png => {
            bytes.len() >= 45
                && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && bytes[8..16] == *b"\0\0\0\rIHDR"
                && u32::from_be_bytes(bytes[16..20].try_into().unwrap()) > 0
                && u32::from_be_bytes(bytes[20..24].try_into().unwrap()) > 0
                && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82")
                && complete_png(bytes)
        }
    };
    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}
struct Target {
    identity: Handle,
    length: u64,
    modified: SystemTime,
}
struct Destination {
    path: PathBuf,
    selected_parent: PathBuf,
    parent: PathBuf,
    parent_identity: Handle,
    existing: Option<Target>,
}
impl Destination {
    fn select(path: PathBuf) -> Result<Self, AppError> {
        #[cfg(windows)]
        crate::documents::validate_windows_path(&path)?;
        if !path.is_absolute()
            || !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        {
            return Err(failure(
                "Choose a local .zip destination, not a source document.",
            ));
        }
        let selected_parent = path.parent().ok_or_else(invalid)?.to_owned();
        let parent = observed!(io "destination.select.canonicalize_parent", fs::canonicalize(&selected_parent))?;
        ordinary(&parent, true)?;
        let parent_identity =
            observed!(io "destination.select.parent_identity", Handle::from_path(&parent))?;
        let path = parent.join(path.file_name().ok_or_else(invalid)?);
        let existing = match ordinary(&path, false) {
            Ok(meta) => Some(Target {
                identity: observed!(io "destination.select.target_identity", Handle::from_path(&path))?,
                length: meta.len(),
                modified: observed!(io "destination.select.modified", meta.modified())?,
            }),
            Err(error) if error.code == "notFound" => None,
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            selected_parent,
            parent,
            parent_identity,
            existing,
        })
    }
    fn check(&self) -> Result<(), AppError> {
        if observed!(io "destination.check.canonicalize_parent", fs::canonicalize(&self.selected_parent))?
            != self.parent
            || observed!(io "destination.check.parent_identity", Handle::from_path(&self.parent))?
                != self.parent_identity
        {
            return Err(failure(
                "The destination directory changed. Choose it again.",
            ));
        }
        ordinary(&self.parent, true)?;
        match (&self.existing, ordinary(&self.path, false)) {
            (None, Err(error)) if error.code == "notFound" => Ok(()),
            (Some(target), Ok(meta))
                if observed!(io "destination.check.target_identity", Handle::from_path(&self.path))?
                    == target.identity
                    && target.length == meta.len()
                    && target.modified
                        == observed!(io "destination.check.modified", meta.modified())? =>
            {
                Ok(())
            }
            _ => Err(failure(
                "The selected destination changed. Choose it again and confirm replacement.",
            )),
        }
    }
}
struct Stage {
    owned: OwnedPath,
    temporary: Option<TempPath>,
}
impl Stage {
    fn create(parent: &Path) -> Result<Self, AppError> {
        let file = observed!(io "stage.file.create", tempfile::Builder::new()
            .prefix(".mdviewerrsx-export-")
            .suffix(".zip.part")
            .disable_cleanup(true)
            .tempfile_in(parent))?;
        let owned = observed!(
            "stage.file.guard",
            OwnedPath::file(file.path().to_owned(), file.as_file())
        )?;
        Ok(Self {
            owned,
            temporary: Some(file.into_temp_path()),
        })
    }
    fn persist(&mut self, destination: &Path) -> Result<(), AppError> {
        match observed!(
            "stage.temporary.persist",
            self.temporary
                .take()
                .ok_or_else(invalid)?
                .persist(destination)
        ) {
            Ok(()) => {
                self.owned.identity = None;
                Ok(())
            }
            Err(error) => {
                self.temporary = Some(error.path);
                Err(error.error.into())
            }
        }
    }
}

#[cfg(test)]
mod failure_tests;
#[cfg(test)]
mod tests;
