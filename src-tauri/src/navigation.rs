pub mod query;
use crate::documents::{AppError, Format, Session, classify, contained_file};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::SystemTime,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub scope: u32,
    pub revision: u32,
    pub entry: u32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u32,
    pub ui_id: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub relative: String,
    pub kind: &'static str,
    pub context: u32,
    pub alpha_rank: usize,
    /// Ascending native modification-time bucket; equal timestamps share a
    /// rank and an unknown time is absent rather than ranked.
    pub date_rank: Option<usize>,
    /// Ascending native byte-size bucket; equal sizes share a rank and a
    /// directory or unknown size is absent rather than ranked.
    pub size_rank: Option<usize>,
}
#[derive(Clone, Serialize)]
pub struct Issue {
    pub relative: String,
    pub code: &'static str,
    pub message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub scope: u32,
    pub revision: u32,
    pub name: String,
    pub entries: Vec<Entry>,
    pub issues: Vec<Issue>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Siblings {
    pub index: Index,
    pub active: Option<u32>,
    pub in_root: bool,
    pub root_active: Option<u32>,
}
#[derive(Clone)]
pub struct Record {
    pub lexical: PathBuf,
    pub canonical: PathBuf,
    modified: Option<SystemTime>,
    byte_size: Option<u64>,
    pub entry: Entry,
}
#[derive(Clone)]
pub struct Scope {
    pub id: u32,
    pub revision: u32,
    pub path: PathBuf,
    pub cancel: Arc<AtomicBool>,
    pub lifetime: Arc<AtomicBool>,
    pub filters: Arc<AtomicU64>,
    published: bool,
    pub records: Arc<Vec<Record>>,
    issues: Vec<Issue>,
}
impl Scope {
    pub fn live(&self) -> Result<(), AppError> {
        if self.cancel.load(Ordering::Acquire) || self.lifetime.load(Ordering::Acquire) {
            Err(Session::stale())
        } else {
            Ok(())
        }
    }
    pub fn index(&self) -> Index {
        Index {
            scope: self.id,
            revision: self.revision,
            name: self.path.to_string_lossy().into_owned(),
            entries: self.records.iter().map(|r| r.entry.clone()).collect(),
            issues: self.issues.clone(),
        }
    }
    pub fn entry(&self, binding: Binding) -> Result<Record, AppError> {
        self.live()?;
        if !self.published || binding.scope != self.id || binding.revision != self.revision {
            return Err(Session::stale());
        }
        self.records
            .iter()
            .find(|r| r.entry.id == binding.entry && r.entry.kind != "directory")
            .cloned()
            .ok_or_else(Session::stale)
    }
    pub fn validate(&self, record: &Record) -> Result<PathBuf, AppError> {
        self.live()?;
        let canonical = candidate(&self.path, &record.lexical, false)?;
        if canonical != record.canonical {
            return Err(Session::stale());
        }
        Ok(canonical)
    }
    pub fn read(
        &self,
        record: &Record,
        id: u32,
        revision: u32,
        cancel: &AtomicBool,
    ) -> Result<crate::documents::GrantedDocument, AppError> {
        let path = self.validate(record)?;
        let mut document =
            crate::documents::read_document(&path, Some(&self.path), id, revision, cancel)?;
        self.validate(record)?;
        document.snapshot.context_id = record.entry.context;
        Ok(document)
    }
    pub fn member(&self, canonical: &Path) -> Option<u32> {
        if !self.published || self.live().is_err() {
            return None;
        }
        self.records
            .iter()
            .filter(|r| r.entry.kind != "directory" && r.canonical == canonical)
            .min_by_key(|r| (r.lexical != r.canonical, r.entry.alpha_rank))
            .map(|r| r.entry.id)
    }
}
#[derive(Default)]
pub struct Navigation {
    pub root: Option<Scope>,
    pub siblings: Option<Scope>,
    pub worker: Option<crate::navigation_cache::RootWorker>,
    pub status: crate::navigation_cache::Status,
    next: u32,
    contexts: HashMap<PathBuf, u32>,
    previews: HashMap<u32, (u32, Arc<AtomicBool>)>,
    latest_root: u32,
}
impl Navigation {
    fn number(&mut self) -> Result<u32, AppError> {
        self.next = self.next.checked_add(1).ok_or_else(|| {
            AppError::new(
                "resourceFailure",
                "Reopen the reader to renew navigation identities.",
            )
        })?;
        Ok(self.next)
    }
    pub fn retire_siblings(&mut self) {
        if let Some(scope) = self.siblings.take() {
            scope.cancel.store(true, Ordering::Release);
        }
    }
    pub fn root_siblings(&self, path: &Path) -> Option<Siblings> {
        let root = self.root.as_ref()?;
        let active = root.member(path)?;
        let parent = path.parent()?;
        let mut index = root.index();
        index.entries = root
            .records
            .iter()
            .filter(|record| {
                record.entry.kind != "directory" && record.lexical.parent() == Some(parent)
            })
            .map(|record| record.entry.clone())
            .collect();
        if !index.entries.iter().any(|entry| entry.id == active) {
            return None;
        }
        Some(Siblings {
            index,
            active: Some(active),
            root_active: Some(active),
            in_root: true,
        })
    }
    pub fn parent_siblings(&self, path: &Path) -> Option<Siblings> {
        let scope = self.siblings.as_ref()?;
        if scope.path != path.parent()? || !scope.published || scope.live().is_err() {
            return None;
        }
        Some(Siblings {
            index: scope.index(),
            active: scope.member(path),
            in_root: false,
            root_active: None,
        })
    }
    pub fn context(&mut self, path: &Path) -> Result<u32, AppError> {
        if let Some(id) = self.contexts.get(path) {
            return Ok(*id);
        }
        let id = self.number()?;
        self.contexts.insert(path.to_owned(), id);
        Ok(id)
    }
    pub fn choose(&mut self, request: u32) -> Result<(), AppError> {
        if request <= self.latest_root {
            return Err(Session::stale());
        }
        self.latest_root = request;
        Ok(())
    }
    pub fn chosen(&self, request: u32) -> Result<(), AppError> {
        if request == self.latest_root {
            Ok(())
        } else {
            Err(Session::stale())
        }
    }
    pub fn start(&mut self, path: PathBuf, root: bool, refresh: bool) -> Result<Scope, AppError> {
        let old = if root {
            self.root.as_ref()
        } else {
            self.siblings.as_ref()
        };
        let retained = old.filter(|s| s.path == path).cloned();
        if let Some(old) = old {
            old.cancel.store(true, Ordering::Release);
            if !refresh {
                old.lifetime.store(true, Ordering::Release);
            }
            for (scope, cancel) in self.previews.values() {
                if *scope == old.id {
                    cancel.store(true, Ordering::Release);
                }
            }
        }
        let id = if refresh {
            retained.as_ref().map(|s| s.id)
        } else {
            None
        }
        .map_or_else(|| self.number(), Ok)?;
        let revision = self.number()?;
        let scope = Scope {
            id,
            revision,
            path,
            filters: if refresh {
                retained
                    .as_ref()
                    .map(|scope| scope.filters.clone())
                    .unwrap_or_default()
            } else {
                Arc::default()
            },
            lifetime: if refresh {
                retained
                    .as_ref()
                    .map(|scope| scope.lifetime.clone())
                    .unwrap_or_default()
            } else {
                Arc::default()
            },
            cancel: Arc::new(AtomicBool::new(false)),
            published: false,
            records: retained.map(|s| s.records).unwrap_or_default(),
            issues: Vec::new(),
        };
        if root {
            self.root = Some(scope.clone());
        } else {
            self.siblings = Some(scope.clone());
        }
        Ok(scope)
    }
    pub fn scope(&self, id: u32) -> Result<Scope, AppError> {
        self.root
            .iter()
            .chain(self.siblings.iter())
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(Session::stale)
    }
    pub fn publish(&mut self, mut scope: Scope) -> Result<Index, AppError> {
        let current = self.scope(scope.id)?;
        current.live()?;
        if current.revision != scope.revision {
            return Err(Session::stale());
        }
        for record in Arc::make_mut(&mut scope.records) {
            record.entry.id = self.number()?;
            record.entry.ui_id = current
                .records
                .iter()
                .find(|r| r.lexical == record.lexical && r.entry.kind == record.entry.kind)
                .map(|r| r.entry.ui_id)
                .unwrap_or(record.entry.id);
            record.entry.context = self.context(&record.canonical)?;
        }
        // Parent IDs are resolved after immutable IDs have been allocated.
        let parents: HashMap<_, _> = scope
            .records
            .iter()
            .filter(|r| r.entry.kind == "directory")
            .map(|r| (r.lexical.clone(), r.entry.id))
            .collect();
        for record in Arc::make_mut(&mut scope.records) {
            record.entry.parent = record
                .lexical
                .parent()
                .and_then(|p| parents.get(p))
                .copied();
        }
        scope.published = true;
        let index = scope.index();
        if self.root.as_ref().is_some_and(|s| s.id == scope.id) {
            self.root = Some(scope);
        } else {
            self.siblings = Some(scope);
        }
        Ok(index)
    }
    pub fn preview(
        &mut self,
        binding: Binding,
        request: u32,
    ) -> Result<(Scope, Record, Arc<AtomicBool>), AppError> {
        let scope = self.scope(binding.scope)?;
        let record = scope.entry(binding)?;
        if self.previews.contains_key(&request) {
            return Err(Session::stale());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.previews.insert(request, (scope.id, cancel.clone()));
        Ok((scope, record, cancel))
    }
    pub fn stop(&self) {
        for scope in self.root.iter().chain(self.siblings.iter()) {
            scope.cancel.store(true, Ordering::Release);
            scope.lifetime.store(true, Ordering::Release);
        }
        for (_, cancel) in self.previews.values() {
            cancel.store(true, Ordering::Release);
        }
        if let Some(worker) = &self.worker {
            worker.stop();
        }
    }
    pub fn cancel_preview(&mut self, request: u32) {
        if let Some((_, cancel)) = self.previews.remove(&request) {
            cancel.store(true, Ordering::Release);
        }
    }
}
impl Drop for Navigation {
    fn drop(&mut self) {
        self.stop();
    }
}

fn hidden(path: &Path, metadata: &fs::Metadata) -> bool {
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        if metadata.st_flags() & 0x8000 != 0 {
            return true;
        }
    }
    let _ = metadata;
    false
}
fn directory_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
pub fn root_path(path: &Path) -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    crate::documents::validate_windows_path(path)?;
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    crate::documents::validate_windows_path(&canonical)?;
    if !fs::metadata(&canonical)?.is_dir() {
        return Err(AppError::new("unsupported", "Choose a directory."));
    }
    Ok(canonical)
}
// Recheck each lexical and canonical ancestor: queued paths and cached entries
// are not permission to follow a directory replaced by a link after discovery.
fn visible_ancestors(root: &Path, path: &Path, include_file: bool) -> Result<(), AppError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::new("denied", "Entry is outside the selected folder."))?;
    if root_path(root)? != root {
        return Err(Session::stale());
    }
    let mut current = root.to_owned();
    let components: Vec<_> = relative.components().collect();
    for (position, part) in components.iter().enumerate() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current)?;
        let last = position + 1 == components.len();
        if hidden(&current, &metadata)
            || ((!last || !include_file) && (directory_link(&metadata) || !metadata.is_dir()))
        {
            return Err(AppError::new(
                "denied",
                "Hidden entries and directory links are excluded.",
            ));
        }
    }
    Ok(())
}
fn candidate(root: &Path, path: &Path, directory: bool) -> Result<PathBuf, AppError> {
    visible_ancestors(root, path, !directory)?;
    let canonical = if directory {
        root_path(path)?
    } else {
        classify(path)?;
        contained_file(path, Some(root))?
    };
    if !canonical.starts_with(root) {
        return Err(AppError::new("denied", "Entry leaves the selected folder."));
    }
    visible_ancestors(root, &canonical, !directory)?;
    if !directory {
        classify(&canonical)?;
    }
    Ok(canonical)
}
pub fn scan(scope: Scope, recursive: bool) -> Result<Scope, AppError> {
    scan_progress(scope, recursive, |_| {})
}
pub fn scan_progress(
    mut scope: Scope,
    recursive: bool,
    progress: impl FnMut(usize),
) -> Result<Scope, AppError> {
    let directory = scope.path.clone();
    scan_listing(
        &mut scope,
        recursive,
        directory,
        true,
        |path| {
            fs::read_dir(path).map(|entries| entries.map(|entry| entry.map(|entry| entry.path())))
        },
        progress,
    )?;
    Ok(scope)
}
pub fn scan_directory(mut scope: Scope, directory: PathBuf) -> Result<Scope, AppError> {
    candidate(&scope.path, &directory, true)?;
    let missing: Vec<_> = directory
        .ancestors()
        .take_while(|path| *path != scope.path)
        .filter(|path| !scope.records.iter().any(|record| record.lexical == *path))
        .map(Path::to_owned)
        .collect();
    for path in missing.into_iter().rev() {
        let canonical = candidate(&scope.path, &path, true)?;
        add_record(&mut scope, path, canonical, true)?;
    }
    scan_listing(
        &mut scope,
        false,
        directory,
        false,
        |path| {
            fs::read_dir(path).map(|entries| entries.map(|entry| entry.map(|entry| entry.path())))
        },
        |_| {},
    )?;
    Ok(scope)
}
#[cfg(test)]
fn scan_with<I: IntoIterator<Item = std::io::Result<PathBuf>>>(
    scope: &mut Scope,
    recursive: bool,
    read_dir: impl Fn(&Path) -> std::io::Result<I>,
) -> Result<(), AppError> {
    scan_listing(scope, recursive, scope.path.clone(), true, read_dir, |_| {})
}
fn scan_listing<I: IntoIterator<Item = std::io::Result<PathBuf>>>(
    scope: &mut Scope,
    recursive: bool,
    directory: PathBuf,
    reset: bool,
    read_dir: impl Fn(&Path) -> std::io::Result<I>,
    mut progress: impl FnMut(usize),
) -> Result<(), AppError> {
    if reset {
        Arc::make_mut(&mut scope.records).clear();
        scope.issues.clear();
    } else {
        Arc::make_mut(&mut scope.records)
            .retain(|record| record.lexical.parent() != Some(&directory));
    }
    let mut stack = vec![directory];
    while let Some(directory) = stack.pop() {
        scope.live()?;
        let listing = candidate(&scope.path, &directory, true)
            .and_then(|_| read_dir(&directory).map_err(AppError::from));
        let listing = match listing {
            Ok(listing) => listing,
            Err(error) if directory == scope.path => return Err(error),
            Err(error) => {
                issue(scope, &directory, error);
                continue;
            }
        };
        for item in listing {
            scope.live()?;
            let path = match item {
                Ok(path) => path,
                Err(error) => {
                    issue(scope, &directory, error.into());
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(error) => {
                    issue(scope, &path, error.into());
                    continue;
                }
            };
            if hidden(&path, &metadata) {
                continue;
            }
            if metadata.is_dir() && directory_link(&metadata) {
                continue;
            }
            let directory = metadata.is_dir();
            if !directory && classify(&path).is_err() {
                continue;
            }
            let canonical = match candidate(&scope.path, &path, directory) {
                Ok(p) => p,
                Err(error) => {
                    if !matches!(error.code, "denied" | "unsupported") {
                        issue(scope, &path, error);
                    }
                    continue;
                }
            };
            if directory && recursive {
                stack.push(path.clone());
            }
            add_record(scope, path, canonical, directory)?;
            if scope.records.len().is_multiple_of(128) {
                progress(scope.records.len());
            }
        }
        progress(scope.records.len());
    }
    rank(scope);
    scope.live()
}
fn add_record(
    scope: &mut Scope,
    path: PathBuf,
    canonical: PathBuf,
    directory: bool,
) -> Result<(), AppError> {
    let kind = if directory {
        "directory"
    } else if classify(&canonical)? == Format::Markdown {
        "markdown"
    } else {
        "text"
    };
    // One stat call supplies both orderable file facts. A directory length is
    // not a folder total, so directories never carry a byte size.
    let metadata = fs::metadata(&canonical).ok();
    let modified = metadata.as_ref().and_then(|m| m.modified().ok());
    let byte_size = metadata.as_ref().filter(|m| m.is_file()).map(|m| m.len());
    let entry = Entry {
        id: 0,
        ui_id: 0,
        parent: None,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        relative: path
            .strip_prefix(&scope.path)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned(),
        kind,
        context: 0,
        alpha_rank: 0,
        date_rank: None,
        size_rank: None,
    };
    Arc::make_mut(&mut scope.records).push(Record {
        lexical: path,
        canonical,
        modified,
        byte_size,
        entry,
    });
    Ok(())
}
fn rank(scope: &mut Scope) {
    Arc::make_mut(&mut scope.records).sort_by(|a, b| {
        a.lexical
            .file_name()
            .cmp(&b.lexical.file_name())
            .then_with(|| a.lexical.cmp(&b.lexical))
    });
    for (rank, record) in Arc::make_mut(&mut scope.records).iter_mut().enumerate() {
        record.entry.alpha_rank = rank;
        record.entry.date_rank = None;
        record.entry.size_rank = None;
    }
    // Metadata ranks are ascending native buckets: equal values share a rank
    // and an absent value stays absent so the reader can order it last in
    // both directions. The record vector keeps its alpha order.
    let mut dated: Vec<usize> = (0..scope.records.len())
        .filter(|index| scope.records[*index].modified.is_some())
        .collect();
    dated.sort_by(|a, b| {
        scope.records[*a]
            .modified
            .cmp(&scope.records[*b].modified)
            .then_with(|| a.cmp(b))
    });
    let mut previous: Option<SystemTime> = None;
    let mut bucket = 0usize;
    for index in dated {
        let modified = scope.records[index].modified;
        if previous != modified {
            bucket += 1;
            previous = modified;
        }
        Arc::make_mut(&mut scope.records)[index].entry.date_rank = Some(bucket);
    }
    let mut sized: Vec<usize> = (0..scope.records.len())
        .filter(|index| scope.records[*index].byte_size.is_some())
        .collect();
    sized.sort_by(|a, b| {
        scope.records[*a]
            .byte_size
            .cmp(&scope.records[*b].byte_size)
            .then_with(|| a.cmp(b))
    });
    let mut previous_size: Option<u64> = None;
    let mut bucket = 0usize;
    for index in sized {
        let size = scope.records[index].byte_size;
        if previous_size != size {
            bucket += 1;
            previous_size = size;
        }
        Arc::make_mut(&mut scope.records)[index].entry.size_rank = Some(bucket);
    }
}
fn issue(scope: &mut Scope, path: &Path, error: AppError) {
    scope.issues.push(Issue {
        relative: path
            .strip_prefix(&scope.path)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned(),
        code: error.code,
        message: error.message,
    });
}

#[cfg(test)]
mod tests;
