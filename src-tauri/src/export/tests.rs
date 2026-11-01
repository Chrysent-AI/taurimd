use super::*;
use crate::documents::read_document;
use std::sync::atomic::AtomicBool;

pub(super) const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -4 120 60"><style>text{fill:#123}</style><text x="8" y="20">Whole diagram</text></svg>"#;
pub(super) fn fixture(mode: Mode, ordinals: Vec<u32>) -> (tempfile::TempDir, Session, Arc<Job>) {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("source.md"), "# Original source").unwrap();
    let mut session = Session::default();
    let cancel = session.begin(1).unwrap();
    let doc = read_document(&root.path().join("source.md"), None, 1, 1, &cancel).unwrap();
    session.stage(1, doc).unwrap();
    session.commit(1).unwrap();
    let job = Job::enroll(
        &mut session,
        "reader",
        Begin {
            document_id: 1,
            revision: 1,
            mode,
            ordinals,
        },
    )
    .unwrap();
    job.prepare(&root.path().join("cache")).unwrap();
    (root, session, job)
}
pub(super) fn close(root: tempfile::TempDir, mut session: Session, job: Arc<Job>) {
    job.reap().unwrap();
    assert_eq!(
        fs::read(root.path().join("source.md")).unwrap(),
        b"# Original source"
    );
    session.export = None;
    drop(job);
    drop(session);
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}
pub(super) fn cache_empty(root: &Path) {
    assert_eq!(
        fs::read_dir(root.join("cache"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>(),
        ["coordination.lock"]
    );
}
fn binding(job: &Job) -> Binding {
    Binding {
        export_id: job.id,
        document_id: 1,
        revision: 1,
        mode: job.begin.mode,
    }
}
#[test]
fn manifest_binding_shape_and_append_abort_are_native_authority() {
    for ordinals in [vec![], vec![0], vec![1, 1], vec![3, 1]] {
        let (root, mut session, job) = fixture(Mode::Svg, vec![1]);
        session.export = None;
        assert!(Job::enroll(
            &mut session,
            "reader",
            Begin {
                document_id: 1,
                revision: 1,
                mode: Mode::Svg,
                ordinals
            }
        )
        .is_err());
        close(root, session, job);
    }
    for bytes in [
        b"<svg/>".as_slice(),
        b"\xff",
        b"not svg",
        b"\x89PNG\r\n\x1a\n",
    ] {
        let (root, session, job) = fixture(Mode::Svg, vec![1]);
        assert!(job.append(1, bytes).is_err());
        assert!(job.append(1, SVG).is_err());
        cache_empty(root.path());
        close(root, session, job);
    }
    let (root, session, job) = fixture(Mode::Svg, vec![1, 3]);
    for caller in ["guide", "other"] {
        assert!(Job::lookup(&session, caller, &binding(&job)).is_err());
    }
    let mut wrong = binding(&job);
    wrong.export_id += 1;
    assert!(Job::lookup(&session, "reader", &wrong).is_err());
    wrong = binding(&job);
    wrong.document_id += 1;
    assert!(Job::lookup(&session, "reader", &wrong).is_err());
    wrong = binding(&job);
    wrong.revision += 1;
    assert!(Job::lookup(&session, "reader", &wrong).is_err());
    wrong = binding(&job);
    wrong.mode = Mode::Png;
    assert!(Job::lookup(&session, "reader", &wrong).is_err());
    assert!(job.finalize().is_err());
    assert!(job.append(3, SVG).is_err());
    assert!(serde_json::from_value::<Begin>(
        serde_json::json!({"documentId":1,"revision":1,"mode":"svg","ordinals":[1],"path":"bad"})
    )
    .is_err());
    assert!(serde_json::from_value::<Image>(serde_json::json!({"binding":{"exportId":1,"documentId":1,"revision":1,"mode":"png"},"ordinal":1,"bytes":[256]})).is_err());
    close(root, session, job);
}
#[test]
fn stored_zip_full_svg_ordinal_gaps_atomic_hardlink_replacement() {
    let (root, mut session, job) = fixture(Mode::Svg, vec![1, 3]);
    let root_path = root.path().to_owned();
    let verification = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source = fs::read(root.path().join("source.md")).unwrap();
        let output = root.path().join("diagrams.ZIP");
        fs::hard_link(root.path().join("source.md"), &output).unwrap();
        job.append(1, SVG).unwrap();
        job.append(3, SVG).unwrap();
        let result = job
            .finish(
                || Ok(Some(output.clone())),
                |_| true,
                || job.commit_start(&session),
            )
            .unwrap();
        assert!(matches!(result, Outcome::Committed { count: 2, .. }));
        let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        for (index, ordinal) in [1, 3].iter().enumerate() {
            let mut entry = zip.by_index(index).unwrap();
            assert_eq!(entry.name().unwrap(), format!("diagram-{ordinal:03}.svg"));
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            assert_eq!(content, SVG);
        }
        drop(zip);
        assert_eq!(fs::read(root.path().join("source.md")).unwrap(), source);
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(fs::metadata(&output).unwrap().file_attributes() & 0x100, 0);
        }
        cache_empty(root.path());
        assert!(!fs::read_dir(root.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".mdviewerrsx-export-")));
    }));
    // Always finish fixture teardown before resuming the original assertion failure.
    let reaped = job.reap();
    let source_unchanged =
        fs::read(root.path().join("source.md")).is_ok_and(|bytes| bytes == b"# Original source");
    let resources_empty = job
        .io
        .lock()
        .is_ok_and(|io| io.archive.is_none() && io.stage.is_none());
    let cache_empty = fs::read_dir(root.path().join("cache"))
        .and_then(|entries| {
            entries
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect::<Result<Vec<_>, _>>()
        })
        .is_ok_and(|names| names == ["coordination.lock"]);
    let stages_empty = fs::read_dir(root.path())
        .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
        .is_ok_and(|entries| {
            !entries.iter().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".mdviewerrsx-export-")
            })
        });
    session.export = None;
    drop(job);
    drop(session);
    let removed = root.close();
    let root_absent = root_path.try_exists().is_ok_and(|exists| !exists);
    eprintln!("Export verification: cleanup reap_ok={} source_unchanged={source_unchanged} resources_empty={resources_empty} cache_empty={cache_empty} stages_empty={stages_empty} root_close_ok={} root_absent={root_absent}", reaped.is_ok(), removed.is_ok());
    if let Err(error) = &reaped {
        eprintln!("Export verification: cleanup_code={}", error.code);
    }
    if let Err(error) = &removed {
        eprintln!(
            "Export verification: root_close_kind={:?} os={:?}",
            error.kind(),
            error.raw_os_error()
        );
    }
    if let Err(panic) = verification {
        std::panic::resume_unwind(panic);
    }
    assert!(
        reaped.is_ok()
            && source_unchanged
            && resources_empty
            && cache_empty
            && stages_empty
            && removed.is_ok()
            && root_absent
    );
}
#[test]
fn stored_zip_new_and_ordinary_existing_destinations_commit_atomically() {
    for existing in [false, true] {
        let (root, session, job) = fixture(Mode::Svg, vec![1, 3]);
        let output = root.path().join("diagrams.zip");
        if existing {
            fs::write(&output, b"previous archive").unwrap();
        }
        job.append(1, SVG).unwrap();
        job.append(3, SVG).unwrap();
        let mut approved = false;
        let outcome = job
            .finish(
                || Ok(Some(output.clone())),
                |selected| {
                    assert!(existing);
                    assert_eq!(selected, fs::canonicalize(&output).unwrap().as_path());
                    approved = true;
                    true
                },
                || job.commit_start(&session),
            )
            .unwrap();
        assert_eq!(approved, existing);
        assert!(matches!(outcome, Outcome::Committed { count: 2, .. }));
        let mut archive = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        for (index, ordinal) in [1, 3].iter().enumerate() {
            let mut entry = archive.by_index(index).unwrap();
            assert_eq!(entry.name().unwrap(), format!("diagram-{ordinal:03}.svg"));
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            assert_eq!(content, SVG);
        }
        drop(archive);
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(fs::metadata(&output).unwrap().file_attributes() & 0x100, 0);
        }
        assert!(job
            .io
            .lock()
            .is_ok_and(|io| io.archive.is_none() && io.stage.is_none()));
        cache_empty(root.path());
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".mdviewerrsx-export-")));
        close(root, session, job);
    }
}
#[test]
fn cancel_decline_bad_destination_and_target_changes_preserve_previous_bytes() {
    for scenario in 0..6 {
        let (root, session, job) = fixture(Mode::Svg, vec![1]);
        job.append(1, SVG).unwrap();
        let path = root.path().join(if scenario == 2 {
            "source.md"
        } else {
            "output.zip"
        });
        if scenario != 2 {
            fs::write(&path, b"previous ZIP").unwrap();
        }
        let before = fs::read(&path).unwrap();
        let result = job.finish(
            || {
                if scenario == 0 {
                    Ok(None)
                } else {
                    Ok(Some(path.clone()))
                }
            },
            |_| {
                if scenario == 3 {
                    fs::write(&path, b"changed independently").unwrap();
                }
                if scenario == 4 {
                    job.retire().unwrap();
                }
                scenario != 1
            },
            || {
                if scenario == 5 {
                    Err(failure("injected commit failure"))
                } else {
                    job.commit_start(&session)
                }
            },
        );
        if scenario <= 1 || scenario == 4 {
            assert_eq!(result.unwrap(), Outcome::Cancelled);
        } else {
            assert!(result.is_err());
        }
        assert_eq!(
            fs::read(&path).unwrap(),
            if scenario == 3 {
                b"changed independently".to_vec()
            } else {
                before
            }
        );
        cache_empty(root.path());
        assert!(!fs::read_dir(root.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".mdviewerrsx-export-")));
        close(root, session, job);
    }
}
#[cfg(unix)]
#[test]
fn symlink_nonregular_and_parent_retarget_are_rejected() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("source.md");
    fs::write(&original, b"untouched").unwrap();
    let alias = root.path().join("alias.zip");
    symlink(&original, &alias).unwrap();
    assert!(Destination::select(alias).is_err());
    fs::create_dir(root.path().join("directory.zip")).unwrap();
    assert!(Destination::select(root.path().join("directory.zip")).is_err());
    for dir in ["one", "two"] {
        fs::create_dir(root.path().join(dir)).unwrap();
    }
    let parent = root.path().join("parent");
    symlink(root.path().join("one"), &parent).unwrap();
    let target = Destination::select(parent.join("new.zip")).unwrap();
    fs::remove_file(&parent).unwrap();
    symlink(root.path().join("two"), &parent).unwrap();
    assert!(target.check().is_err());
    drop(target);
    assert_eq!(fs::read(original).unwrap(), b"untouched");
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}
#[test]
fn identity_mismatch_and_persist_error_recover_owned_stage() {
    let root = tempfile::tempdir().unwrap();
    let mut stage = Stage::create(root.path()).unwrap();
    let moved = root.path().join("original");
    fs::rename(&stage.owned.path, &moved).unwrap();
    fs::write(&stage.owned.path, b"foreign replacement").unwrap();
    assert!(stage.owned.remove().is_err());
    assert_eq!(fs::read(&stage.owned.path).unwrap(), b"foreign replacement");
    fs::remove_file(&stage.owned.path).unwrap();
    fs::rename(moved, &stage.owned.path).unwrap();
    stage.owned.remove().unwrap();
    drop(stage);
    for retry in [false, true] {
        let mut stage = Stage::create(root.path()).unwrap();
        fs::write(&stage.owned.path, b"prepared archive").unwrap();
        let target = root.path().join("directory.zip");
        fs::create_dir(&target).unwrap();
        let child = target.join("foreign-child");
        fs::write(&child, b"preserve destination").unwrap();
        assert!(stage.persist(&target).is_err());
        assert!(stage.temporary.is_some());
        assert!(stage.owned.identity.is_some());
        stage.owned.check().unwrap();
        assert_eq!(fs::read(&stage.owned.path).unwrap(), b"prepared archive");
        assert_eq!(fs::read(&child).unwrap(), b"preserve destination");
        fs::remove_file(child).unwrap();
        fs::remove_dir(&target).unwrap();
        let path = stage.owned.path.clone();
        if retry {
            stage.persist(&target).unwrap();
            assert!(stage.temporary.is_none());
            assert!(stage.owned.identity.is_none());
            assert_eq!(fs::read(&target).unwrap(), b"prepared archive");
            fs::remove_file(target).unwrap();
        } else {
            stage.owned.remove().unwrap();
        }
        assert!(!path.exists());
        drop(stage);
    }
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}
#[test]
fn two_live_owners_unknown_and_abandoned_cache_are_distinguished() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let mut first = Archive::create(&cache).unwrap();
    let mut second = Archive::create(&cache).unwrap();
    let mut abandoned = Archive::create(&cache).unwrap();
    let abandoned_path = abandoned.run.path.clone();
    abandoned.writer = None;
    abandoned.file = None;
    abandoned.lock = None;
    abandoned.archive.identity = None;
    abandoned.owner.identity = None;
    abandoned.run.identity = None;
    drop(abandoned);
    let unknown = cache.join("run-ABC123");
    fs::create_dir(&unknown).unwrap();
    fs::write(unknown.join("foreign"), b"keep").unwrap();
    sweep(&cache).unwrap();
    assert!(first.run.path.exists());
    assert!(second.run.path.exists());
    assert!(!abandoned_path.exists());
    assert!(unknown.join("foreign").exists());
    first.cleanup().unwrap();
    second.cleanup().unwrap();
    drop(first);
    drop(second);
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}
#[test]
fn held_save_cancellation_document_retirement_and_commit_arbitration() {
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    let state = Arc::new(Mutex::new(session));
    let (entered, receive_entered) = std::sync::mpsc::channel();
    let (selected, receive_selected) = std::sync::mpsc::channel();
    let worker = {
        let job = job.clone();
        let state = state.clone();
        std::thread::spawn(move || {
            job.finish(
                || {
                    entered.send(()).unwrap();
                    Ok(receive_selected.recv().unwrap())
                },
                |_| true,
                || job.commit_start(&state.lock().unwrap()),
            )
        })
    };
    receive_entered
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    {
        let state = state.lock().unwrap();
        Job::lookup(&state, "reader", &binding(&job))
            .unwrap()
            .retire()
            .unwrap();
    }
    job.reap().unwrap();
    cache_empty(root.path());
    selected.send(Some(root.path().join("late.zip"))).unwrap();
    assert_eq!(worker.join().unwrap().unwrap(), Outcome::Cancelled);
    assert!(!root.path().join("late.zip").exists());
    let session = Arc::try_unwrap(state).ok().unwrap().into_inner().unwrap();
    close(root, session, job);
    let (root, mut session, job) = fixture(Mode::Svg, vec![1]);
    job.commit_start(&session).unwrap();
    assert!(job.retire().is_err());
    assert!(session.begin(2).is_err());
    job.phase.store(0, Ordering::Release);
    session.begin(2).unwrap();
    assert!(job.live().is_err());
    job.reap().unwrap();
    close(root, session, job);
}
#[test]
fn checked_copy_stops_on_cancel_or_write_failure_without_writing_destination() {
    struct Denied;
    impl Write for Denied {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::PermissionDenied.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut input = SVG;
    assert!(copy_checked(&mut input, &mut Denied, || Ok(()), |_| Ok(())).is_err());
    let cancelled = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut input = SVG;
    assert!(copy_checked(
        &mut input,
        &mut output,
        || {
            cancelled.store(true, Ordering::Relaxed);
            Err(Session::stale())
        },
        |_| Ok(())
    )
    .is_err());
    assert!(output.is_empty());
}
#[test]
#[ignore = "requires actual-App browser export evidence directory"]
fn real_browser_payloads_use_native_stored_archive_path_when_supplied() {
    let folder = std::env::var("MDVIEWERRSX_EXPORT_PAYLOADS")
        .expect("set actual-App export evidence directory");
    for (mode, extension) in [(Mode::Svg, "svg"), (Mode::Png, "png")] {
        let images = [1, 3].map(|ordinal| {
            fs::read(Path::new(&folder).join(format!("diagram-{ordinal:03}.{extension}"))).unwrap()
        });
        let (root, session, job) = fixture(mode, vec![1, 3]);
        for (ordinal, bytes) in [1, 3].into_iter().zip(&images) {
            job.append(ordinal, bytes).unwrap();
        }
        let path = root.path().join("real.zip");
        job.finish(
            || Ok(Some(path.clone())),
            |_| panic!("new archive"),
            || job.commit_start(&session),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        for (index, ordinal) in [1, 3].iter().enumerate() {
            let mut entry = archive.by_index(index).unwrap();
            assert_eq!(
                entry.name().unwrap(),
                format!("diagram-{ordinal:03}.{extension}")
            );
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            let mut stored = Vec::new();
            entry.read_to_end(&mut stored).unwrap();
            assert_eq!(stored, images[index]);
        }
        drop(archive);
        close(root, session, job);
    }
}
