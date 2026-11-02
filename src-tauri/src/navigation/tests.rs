use super::*;
use crate::{documents::read_document, navigation_commands::reveal};
use std::{
    io,
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};
fn root() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}
fn reap(dir: tempfile::TempDir) {
    let path = dir.path().to_owned();
    dir.close().unwrap();
    assert!(!path.exists());
}
fn published(nav: &mut Navigation, path: &Path, recursive: bool) -> Index {
    let scope = nav
        .start(root_path(path).unwrap(), recursive, false)
        .unwrap();
    nav.publish(scan(scope, recursive).unwrap()).unwrap()
}
fn binding(index: &Index, name: &str) -> Binding {
    Binding {
        scope: index.scope,
        revision: index.revision,
        entry: index
            .entries
            .iter()
            .find(|e| e.relative == name)
            .unwrap()
            .id,
    }
}
fn entries(path: &Path) -> io::Result<Vec<io::Result<PathBuf>>> {
    fs::read_dir(path).map(|listing| listing.map(|item| item.map(|item| item.path())).collect())
}
#[test]
fn metadata_only_recursive_formats_and_shared_root_siblings() {
    let dir = root();
    fs::create_dir(dir.path().join("nested")).unwrap();
    fs::create_dir(dir.path().join("empty")).unwrap();
    fs::create_dir(dir.path().join(".secret")).unwrap();
    for name in [
        "a.MD",
        "b.markdown",
        "c.mdown",
        "d.mkd",
        "e.MKDOWN",
        "f.txt",
        "g.LOG",
        "bad.mdx",
        ".hidden.md",
        ".secret/no.md",
        "nested/a.md",
    ] {
        // Invalid UTF-8 proves enumeration never reads/parses document bodies.
        fs::write(dir.path().join(name), [0xff]).unwrap();
    }
    let mut nav = Navigation::default();
    let index = published(&mut nav, dir.path(), true);
    assert_eq!(
        index
            .entries
            .iter()
            .filter(|e| e.kind != "directory")
            .count(),
        8
    );
    assert!(
        !index
            .entries
            .iter()
            .any(|e| e.name.starts_with('.') || e.name == "bad.mdx")
    );
    assert!(index.issues.is_empty());
    let scope = nav.scope(index.scope).unwrap();
    let nested = Path::new("nested").join("a.md");
    let record = scope
        .entry(binding(&index, &nested.to_string_lossy()))
        .unwrap();
    assert_eq!(
        scope
            .read(&record, 1, 1, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "invalidUtf8"
    );
    let siblings = nav
        .root_siblings(&dir.path().join("nested/a.md").canonicalize().unwrap())
        .unwrap();
    assert_eq!(siblings.active, Some(record.entry.id));
    assert_eq!(siblings.index.scope, index.scope);
    assert_eq!(siblings.index.entries.len(), 1);
    assert_eq!(siblings.index.entries[0].id, record.entry.id);
    let top = nav
        .root_siblings(&dir.path().join("a.MD").canonicalize().unwrap())
        .unwrap();
    assert_eq!(top.index.entries.len(), 7);
    assert!(
        top.index
            .entries
            .iter()
            .all(|e| Path::new(&e.relative).components().count() == 1)
    );
    assert!(
        nav.root_siblings(&dir.path().join(".hidden.md").canonicalize().unwrap())
            .is_none()
    );
    drop(nav);
    reap(dir);
}
#[test]
fn deterministic_native_alpha_date_ties_missing_times_and_no_source_writes() {
    let dir = root();
    for name in ["z.md", "a.md", "B.log"] {
        fs::write(dir.path().join(name), name).unwrap();
    }
    let time = UNIX_EPOCH + Duration::from_secs(1_000_000);
    for name in ["z.md", "a.md", "B.log"] {
        fs::File::options()
            .write(true)
            .open(dir.path().join(name))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
    }
    let mut nav = Navigation::default();
    let scope = nav
        .start(root_path(dir.path()).unwrap(), true, false)
        .unwrap();
    let mut scope = scan(scope, true).unwrap();
    assert_eq!(
        scope
            .records
            .iter()
            .map(|r| r.entry.name.as_str())
            .collect::<Vec<_>>(),
        ["B.log", "a.md", "z.md"]
    );
    // One shared timestamp is one ascending bucket for every entry.
    assert!(scope.records.iter().all(|r| r.entry.date_rank == Some(1)));
    // Unequal sizes are distinct ascending buckets; equal sizes share one.
    // "a.md" and "z.md" hold four bytes each and "B.log" holds five.
    assert_eq!(
        scope
            .records
            .iter()
            .map(|r| r.entry.size_rank)
            .collect::<Vec<_>>(),
        [Some(2), Some(1), Some(1)]
    );
    Arc::make_mut(&mut scope.records)[0].modified = None;
    Arc::make_mut(&mut scope.records)[2].modified = Some(time + Duration::from_secs(1));
    rank(&mut scope);
    // The missing time has no rank at all and never displaces a known one.
    assert_eq!(
        scope
            .records
            .iter()
            .map(|r| r.entry.date_rank)
            .collect::<Vec<_>>(),
        [None, Some(1), Some(2)]
    );
    nav.publish(scope).unwrap();
    for name in ["z.md", "a.md", "B.log"] {
        assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), name);
    }
    drop(nav);
    reap(dir);
}
#[test]
fn metadata_ranks_cover_sizes_times_and_directory_totals() {
    let dir = root();
    fs::create_dir(dir.path().join("folder")).unwrap();
    fs::write(dir.path().join("folder/inner.md"), "inner").unwrap();
    fs::write(dir.path().join("empty.md"), "").unwrap();
    fs::write(dir.path().join("one.md"), "1").unwrap();
    fs::write(dir.path().join("two.md"), "22").unwrap();
    // A pre-epoch timestamp is a known value, not a missing one.
    let epoch = UNIX_EPOCH - Duration::from_secs(60);
    fs::File::options()
        .write(true)
        .open(dir.path().join("empty.md"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(epoch))
        .unwrap();
    let mut nav = Navigation::default();
    let index = published(&mut nav, dir.path(), true);
    let entry = |relative: &str| {
        index
            .entries
            .iter()
            .find(|e| e.relative == relative)
            .unwrap()
            .clone()
    };
    // Size is the file byte size, never a recursive folder total.
    assert_eq!(entry("empty.md").size_rank, Some(1));
    assert_eq!(entry("one.md").size_rank, Some(2));
    assert_eq!(entry("two.md").size_rank, Some(3));
    assert_eq!(entry("folder/inner.md").size_rank, Some(4));
    assert_eq!(entry("folder").size_rank, None);
    // The oldest known timestamp ranks first and keeps a rank.
    let empty = entry("empty.md");
    assert_eq!(empty.date_rank, Some(1));
    assert!(entry("one.md").date_rank.unwrap() > empty.date_rank.unwrap());
    // The scan never reads a document body to learn its metadata.
    assert_eq!(fs::read_to_string(dir.path().join("one.md")).unwrap(), "1");
    assert_eq!(fs::read_to_string(dir.path().join("two.md")).unwrap(), "22");
    drop(nav);
    reap(dir);
}
#[cfg(unix)]
#[test]
fn alias_entries_rank_with_their_validated_target() {
    use std::os::unix::fs::symlink;
    let dir = root();
    fs::write(dir.path().join("one.md"), "1").unwrap();
    fs::write(dir.path().join("two.md"), "22").unwrap();
    symlink(dir.path().join("one.md"), dir.path().join("alias.md")).unwrap();
    let mut nav = Navigation::default();
    let index = published(&mut nav, dir.path(), true);
    let entry = |relative: &str| {
        index
            .entries
            .iter()
            .find(|e| e.relative == relative)
            .unwrap()
            .clone()
    };
    // The alias reports the validated target size, so it shares one bucket.
    assert_eq!(entry("alias.md").size_rank, entry("one.md").size_rank);
    assert_eq!(entry("alias.md").size_rank, Some(1));
    assert_eq!(entry("two.md").size_rank, Some(2));
    assert_eq!(fs::read_to_string(dir.path().join("one.md")).unwrap(), "1");
    drop(nav);
    reap(dir);
}
#[test]
fn initial_iterator_and_nested_denial_are_not_false_empty_success() {
    let dir = root();
    fs::create_dir(dir.path().join("denied")).unwrap();
    fs::write(dir.path().join("good.md"), "# Good").unwrap();
    let mut nav = Navigation::default();
    let mut scope = nav
        .start(root_path(dir.path()).unwrap(), true, false)
        .unwrap();
    let denied = || io::Error::new(io::ErrorKind::PermissionDenied, "fixture denial");
    assert_eq!(
        scan_with(&mut scope, true, |_| Err::<Vec<io::Result<PathBuf>>, _>(
            denied()
        ))
        .err()
        .unwrap()
        .code,
        "denied"
    );
    scan_with(&mut scope, true, |path| {
        if path.ends_with("denied") {
            return Err(denied());
        }
        let mut result = entries(path)?;
        result.push(Err(io::Error::other("fixture iterator failure")));
        Ok(result)
    })
    .unwrap();
    assert!(scope.records.iter().any(|r| r.entry.name == "good.md"));
    assert!(
        scope
            .issues
            .iter()
            .any(|e| e.code == "denied" && e.relative == "denied")
    );
    assert!(
        scope
            .issues
            .iter()
            .any(|e| e.message.contains("iterator failure"))
    );
    fs::remove_file(dir.path().join("good.md")).unwrap();
    fs::remove_dir(dir.path().join("denied")).unwrap();
    let mut missing = scope;
    missing.path = missing.path.join("missing");
    assert_eq!(scan(missing, true).err().unwrap().code, "notFound");
    drop(nav);
    reap(dir);
}
#[cfg(unix)]
#[test]
fn file_aliases_directory_cycles_hidden_targets_and_ancestor_retarget_are_revalidated() {
    use std::os::unix::fs::symlink;
    let dir = root();
    let outside = root();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/base.md"), "# Base").unwrap();
    fs::write(dir.path().join(".private.md"), "private").unwrap();
    fs::write(outside.path().join("escape.md"), "escape").unwrap();
    fs::write(dir.path().join("bad.mdx"), "bad").unwrap();
    for (target, name) in [
        (dir.path().join("sub/base.md"), "safe.md"),
        (outside.path().join("escape.md"), "escape.md"),
        (dir.path().join(".private.md"), "hidden.md"),
        (dir.path().join("bad.mdx"), "badalias.md"),
        (dir.path().join("missing.md"), "broken.md"),
        (dir.path().to_owned(), "cycle"),
        (dir.path().join("sub/base.md"), "unsupported.mdx"),
    ] {
        symlink(target, dir.path().join(name)).unwrap();
    }
    let mut nav = Navigation::default();
    let index = published(&mut nav, dir.path(), true);
    let files: Vec<_> = index
        .entries
        .iter()
        .filter(|e| e.kind != "directory")
        .map(|e| e.relative.as_str())
        .collect();
    assert_eq!(files.len(), 2);
    assert!(files.contains(&"safe.md"));
    assert!(files.contains(&"sub/base.md"));
    let scope = nav.scope(index.scope).unwrap();
    let record = scope.entry(binding(&index, "safe.md")).unwrap();
    assert_eq!(
        scope
            .read(&record, 1, 1, &AtomicBool::new(false))
            .unwrap()
            .snapshot
            .source,
        "# Base"
    );
    let canonical = dir.path().join("sub/base.md").canonicalize().unwrap();
    assert_eq!(
        nav.root_siblings(&canonical).unwrap().active,
        Some(binding(&index, "sub/base.md").entry)
    );
    fs::remove_file(dir.path().join("safe.md")).unwrap();
    symlink(outside.path().join("escape.md"), dir.path().join("safe.md")).unwrap();
    assert_eq!(scope.validate(&record).err().unwrap().code, "denied");
    let nested = scope.entry(binding(&index, "sub/base.md")).unwrap();
    fs::rename(dir.path().join("sub"), dir.path().join("retired")).unwrap();
    symlink(dir.path().join("retired"), dir.path().join("sub")).unwrap();
    assert_eq!(scope.validate(&nested).err().unwrap().code, "denied");
    assert_eq!(
        fs::read_to_string(outside.path().join("escape.md")).unwrap(),
        "escape"
    );
    drop(nav);
    reap(dir);
    reap(outside);
}
#[cfg(target_os = "macos")]
#[test]
fn native_hidden_flag_excludes_even_a_non_dot_filename() {
    let dir = root();
    let path = dir.path().join("native-hidden.md");
    fs::write(&path, "# Hidden").unwrap();
    assert!(
        std::process::Command::new("chflags")
            .arg("hidden")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let mut nav = Navigation::default();
    let index = published(&mut nav, dir.path(), true);
    assert!(index.entries.is_empty());
    // Explicit file selection is still readable; tree policy does not revoke it.
    assert!(read_document(&path, None, 1, 1, &AtomicBool::new(false)).is_ok());
    drop(nav);
    reap(dir);
}
#[test]
fn epochs_old_ids_preview_cancellation_context_and_commit_lifetime_are_native_owned() {
    let dir = root();
    let other = root();
    fs::write(dir.path().join("same.md"), "# Same").unwrap();
    fs::write(other.path().join("same.md"), "# Same").unwrap();
    let mut session = Session::default();
    let index = published(&mut session.navigation, dir.path(), true);
    let entry = binding(&index, "same.md");
    let (scope, record, preview_cancel) = session.navigation.preview(entry, 1).unwrap();
    assert!(session.navigation.preview(entry, 1).is_err());
    let doc_cancel = session.begin(1).unwrap();
    let document = scope.read(&record, 1, 1, &doc_cancel).unwrap();
    session.stage_navigation(1, document, &scope).unwrap();
    session.commit(1).unwrap();
    let active = session.active(1, 1).unwrap();
    let active_lifetime = session.media_lifetime.clone();
    let cancel = session.begin(2).unwrap();
    let pending = scope.read(&record, 2, 2, &cancel).unwrap();
    session.stage_navigation(2, pending, &scope).unwrap();
    let refresh = session
        .navigation
        .start(scope.path.clone(), true, true)
        .unwrap();
    assert!(preview_cancel.load(Ordering::Acquire));
    assert!(scope.entry(entry).is_err());
    assert!(session.navigation.publish(scope.clone()).is_err());
    assert!(session.commit(2).is_err());
    assert!(session.active(1, 1).is_ok());
    assert!(!active_lifetime.load(Ordering::Acquire));
    assert!(session.navigation.root_siblings(&active.path).is_none());
    let fresh = session
        .navigation
        .publish(scan(refresh, true).unwrap())
        .unwrap();
    assert_ne!(fresh.entries[0].id, index.entries[0].id);
    assert_eq!(fresh.entries[0].ui_id, index.entries[0].ui_id);
    assert_eq!(fresh.entries[0].context, index.entries[0].context);
    assert!(
        session
            .navigation
            .scope(entry.scope)
            .unwrap()
            .entry(entry)
            .is_err()
    );
    assert!(session.navigation.scope(999).is_err());
    let mut forged = binding(&fresh, "same.md");
    forged.entry = 0;
    assert!(
        session
            .navigation
            .scope(forged.scope)
            .unwrap()
            .entry(forged)
            .is_err()
    );
    let foreign = published(&mut session.navigation, other.path(), true);
    assert_ne!(foreign.entries[0].context, index.entries[0].context);
    assert_eq!(active.snapshot.source, "# Same");
    session.navigation.choose(10).unwrap();
    assert!(session.navigation.choose(9).is_err());
    assert!(session.navigation.chosen(9).is_err());
    let parent = published(&mut session.navigation, dir.path(), false);
    let parent_scope = session.navigation.scope(parent.scope).unwrap();
    let cancel = session.begin(3).unwrap();
    let read = parent_scope
        .read(
            &parent_scope.entry(binding(&parent, "same.md")).unwrap(),
            3,
            3,
            &cancel,
        )
        .unwrap();
    session.stage_navigation(3, read, &parent_scope).unwrap();
    session.commit(3).unwrap();
    assert!(parent_scope.live().is_err());
    assert!(session.navigation.scope(parent.scope).is_err());
    let lifetime = session.navigation.root.as_ref().unwrap().cancel.clone();
    drop(session);
    assert!(lifetime.load(Ordering::Acquire));
    reap(dir);
    reap(other);
}
#[test]
fn unrelated_root_publication_reuses_parent_scope_and_preserves_staged_parent_open() {
    let dir = root();
    let other = root();
    fs::write(dir.path().join("active.md"), "# Active").unwrap();
    fs::write(dir.path().join("next.md"), "# Next").unwrap();
    let mut session = Session::default();
    let cancel = session.begin(1).unwrap();
    session
        .stage(
            1,
            read_document(&dir.path().join("active.md"), None, 1, 1, &cancel).unwrap(),
        )
        .unwrap();
    session.commit(1).unwrap();
    let parent = published(&mut session.navigation, dir.path(), false);
    let scope = session.navigation.scope(parent.scope).unwrap();
    let record = scope.entry(binding(&parent, "next.md")).unwrap();
    let cancel = session.begin(2).unwrap();
    let document = scope.read(&record, 2, 2, &cancel).unwrap();
    session.stage_navigation(2, document, &scope).unwrap();
    let foreign = published(&mut session.navigation, other.path(), true);
    let projection = session
        .navigation
        .parent_siblings(&dir.path().join("active.md").canonicalize().unwrap())
        .unwrap();
    assert_eq!(projection.index.scope, parent.scope);
    assert_eq!(projection.index.revision, parent.revision);
    assert_ne!(foreign.scope, parent.scope);
    session.commit(2).unwrap();
    assert_eq!(session.active(2, 2).unwrap().snapshot.name, "next.md");
    drop(session);
    reap(dir);
    reap(other);
}
#[test]
fn preview_reads_fresh_bytes_even_same_size_and_time_and_does_not_enroll_document_work() {
    let dir = root();
    let path = dir.path().join("same.md");
    fs::write(&path, "# Old").unwrap();
    let mut session = Session::default();
    let index = published(&mut session.navigation, dir.path(), true);
    let scope = session.navigation.scope(index.scope).unwrap();
    let record = scope.entry(binding(&index, "same.md")).unwrap();
    let active_cancel = session.begin(5).unwrap();
    let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
    let old = scope.read(&record, 0, 1, &AtomicBool::new(false)).unwrap();
    fs::write(&path, "# New").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(timestamp))
        .unwrap();
    let fresh = scope.read(&record, 0, 2, &AtomicBool::new(false)).unwrap();
    assert_eq!(old.snapshot.source.len(), fresh.snapshot.source.len());
    assert_ne!(old.snapshot.source, fresh.snapshot.source);
    assert_eq!(old.snapshot.context_id, fresh.snapshot.context_id);
    assert!(!active_cancel.load(Ordering::Acquire));
    session.current(5).unwrap();
    assert!(!session.has_document());
    session
        .navigation
        .preview(binding(&index, "same.md"), 99)
        .unwrap();
    session.navigation.cancel_preview(99);
    assert_eq!(fs::read_to_string(&path).unwrap(), "# New");
    drop(session);
    reap(dir);
}
#[test]
fn reveal_uses_only_current_active_grant_is_off_lock_and_failure_preserves_reader() {
    let dir = root();
    fs::write(dir.path().join("active.md"), "# Active").unwrap();
    let mut session = Session::default();
    let cancel = session.begin(1).unwrap();
    session
        .stage(
            1,
            read_document(&dir.path().join("active.md"), None, 1, 1, &cancel).unwrap(),
        )
        .unwrap();
    session.commit(1).unwrap();
    let state = Mutex::new(session);
    assert!(crate::session_for_caller("other", &state).is_err());
    let mut calls = 0;
    assert!(reveal(&state, 99, 1, |_| panic!("stale document must not reveal")).is_err());
    let result = reveal(&state, 1, 1, |path| {
        assert!(state.try_lock().is_ok());
        assert_eq!(path, dir.path().join("active.md").canonicalize().unwrap());
        calls += 1;
        Err(AppError::new("io", "fixture opener failure"))
    });
    assert_eq!(result.err().unwrap().code, "io");
    assert_eq!(calls, 1);
    assert!(state.lock().unwrap().active(1, 1).is_ok());
    fs::remove_file(dir.path().join("active.md")).unwrap();
    assert_eq!(
        reveal(&state, 1, 1, |_| panic!("missing reveal"))
            .err()
            .unwrap()
            .code,
        "notFound"
    );
    drop(state);
    reap(dir);
}
