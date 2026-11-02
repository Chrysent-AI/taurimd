use super::{
    tests::{SVG, cache_empty, close, fixture},
    *,
};

#[test]
fn copy_flush_and_sync_failures_are_checked_before_atomic_replacement() {
    struct FlushDenied(Vec<u8>);
    impl Write for FlushDenied {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::PermissionDenied.into())
        }
    }
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("old.zip");
    fs::write(&destination, b"old bytes").unwrap();
    let mut stage = Stage::create(root.path()).unwrap();
    let mut output = FlushDenied(Vec::new());
    let mut input = SVG;
    assert!(
        copy_checked(
            &mut input,
            &mut output,
            || Ok(()),
            |_| panic!("flush must precede sync")
        )
        .is_err()
    );
    assert_eq!(output.0, SVG);
    let mut file = OpenOptions::new()
        .write(true)
        .open(&stage.owned.path)
        .unwrap();
    let mut input = SVG;
    assert!(
        copy_checked(
            &mut input,
            &mut file,
            || Ok(()),
            |_| Err(std::io::ErrorKind::PermissionDenied.into())
        )
        .is_err()
    );
    drop(file);
    stage.owned.remove().unwrap();
    drop(stage);
    assert_eq!(fs::read(&destination).unwrap(), b"old bytes");
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}

#[test]
fn repeated_unexpected_and_truncated_images_abort_instead_of_changing_the_manifest() {
    for ordinal in [1, 2, 4] {
        let (root, session, job) = fixture(Mode::Svg, vec![1, 3]);
        job.append(1, SVG).unwrap();
        assert!(job.append(ordinal, SVG).is_err());
        assert!(job.finalize().is_err());
        cache_empty(root.path());
        close(root, session, job);
    }
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend(1u32.to_be_bytes());
    png.extend(1u32.to_be_bytes());
    png.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    png.extend(b"\0\0\0\x01IDAT\0\0\0\0\0\0\0\0\0IEND\xaeB`\x82");
    validate_payload(Mode::Png, &png).unwrap();
    for end in 0..png.len() {
        assert!(validate_payload(Mode::Png, &png[..end]).is_err());
    }
    assert!(validate_payload(Mode::Svg, &png).is_err());
    assert!(validate_payload(Mode::Png, SVG).is_err());
    png[16..20].fill(0);
    assert!(validate_payload(Mode::Png, &png).is_err());
}

#[test]
fn bad_append_binding_retires_the_registered_transaction() {
    for field in 0..3 {
        let (root, session, job) = fixture(Mode::Svg, vec![1]);
        assert!(Job::append_registration(&session, "other", job.id).is_err());
        assert!(Job::append_registration(&session, "reader", job.id + 1).is_err());
        let registered = Job::append_registration(&session, "reader", job.id).unwrap();
        let mut binding = Binding {
            export_id: job.id,
            document_id: 1,
            revision: 1,
            mode: Mode::Svg,
        };
        match field {
            0 => binding.document_id += 1,
            1 => binding.revision += 1,
            _ => binding.mode = Mode::Png,
        }
        assert!(
            registered
                .append_bound(&Image {
                    binding,
                    ordinal: 1,
                    bytes: SVG.to_vec()
                })
                .is_err()
        );
        assert!(job.append(1, SVG).is_err());
        cache_empty(root.path());
        drop(registered);
        close(root, session, job);
    }
}

#[cfg(unix)]
#[test]
fn read_only_selected_directory_reports_write_failure_and_preserves_old_zip() {
    use std::os::unix::fs::PermissionsExt;
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    let parent = root.path().join("selected");
    fs::create_dir(&parent).unwrap();
    let output = parent.join("previous.zip");
    fs::write(&output, b"old archive").unwrap();
    struct Restore(PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let restore = Restore(parent.clone());
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
    let result = job.finish(
        || Ok(Some(output.clone())),
        |_| true,
        || job.commit_start(&session),
    );
    drop(restore);
    assert!(result.is_err());
    assert_eq!(fs::read(&output).unwrap(), b"old archive");
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    cache_empty(root.path());
    close(root, session, job);
}

#[test]
fn close_or_document_replacement_reaps_prepared_resources_before_a_late_save_callback() {
    for close_window in [false, true] {
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
        if close_window {
            *state.lock().unwrap() = Session::default();
        } else {
            state.lock().unwrap().begin(2).unwrap();
        }
        job.reap().unwrap();
        cache_empty(root.path());
        selected
            .send(Some(root.path().join("retired.zip")))
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), Outcome::Cancelled);
        assert!(!root.path().join("retired.zip").exists());
        let session = Arc::try_unwrap(state).ok().unwrap().into_inner().unwrap();
        close(root, session, job);
    }
}

#[test]
fn consumed_writer_finish_failure_still_reaps_the_independent_archive_guard_before_save() {
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    {
        let mut io = job.io.lock().unwrap();
        let archive = io.archive.as_mut().unwrap();
        archive.writer = None;
        archive.writer = Some(ZipWriter::new(File::open(&archive.archive.path).unwrap()));
    }
    assert!(
        job.finish(
            || panic!("failed finalization must not open Save"),
            |_| panic!("no Replace"),
            || panic!("no commit")
        )
        .is_err()
    );
    cache_empty(root.path());
    close(root, session, job);
}

#[test]
fn registered_destination_stage_is_reaped_before_cancellation_acknowledgement() {
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    job.finalize().unwrap();
    job.stage(root.path()).unwrap();
    let stage = job
        .io
        .lock()
        .unwrap()
        .stage
        .as_ref()
        .unwrap()
        .owned
        .path
        .clone();
    assert!(stage.exists());
    job.retire().unwrap();
    job.reap().unwrap();
    assert!(!stage.exists());
    cache_empty(root.path());
    close(root, session, job);
}

#[test]
fn cache_cleanup_failure_precedes_persist_and_keeps_the_confirmed_old_destination() {
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    let destination = root.path().join("existing.zip");
    fs::write(&destination, b"previous archive").unwrap();
    let unknown = job
        .io
        .lock()
        .unwrap()
        .archive
        .as_ref()
        .unwrap()
        .run
        .path
        .join("unknown");
    fs::write(&unknown, b"preserve unexpected data").unwrap();
    assert!(
        job.finish(
            || Ok(Some(destination.clone())),
            |_| true,
            || job.commit_start(&session)
        )
        .is_err()
    );
    assert_eq!(fs::read(&destination).unwrap(), b"previous archive");
    assert!(unknown.exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|item| {
        item.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".taurimd-export-")
    }));
    fs::remove_file(unknown).unwrap(); // Only the fixture removes its known child.
    job.reap().unwrap();
    close(root, session, job);
}

#[test]
fn failed_directory_removal_keeps_original_identity_for_verified_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned");
    fs::create_dir(&path).unwrap();
    let mut owned = OwnedPath::directory(path.clone()).unwrap();
    let child = path.join("fixture-child");
    fs::write(&child, b"owned test child").unwrap();
    assert!(owned.remove().is_err());
    assert!(owned.identity.is_some());
    owned.check().unwrap();

    let original = root.path().join("original");
    fs::rename(&path, &original).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("replacement-child"), b"not owned by guard").unwrap();
    assert!(owned.remove().is_err());
    assert!(owned.identity.is_some());
    assert_eq!(
        fs::read(path.join("replacement-child")).unwrap(),
        b"not owned by guard"
    );
    fs::remove_file(path.join("replacement-child")).unwrap();
    fs::remove_dir(&path).unwrap();
    fs::rename(original, &path).unwrap();

    fs::remove_file(child).unwrap();
    owned.remove().unwrap();
    assert!(owned.identity.is_none());
    assert!(!path.exists());
    drop(owned);
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}

#[test]
fn destination_appearance_cleanup_failure_and_mid_copy_cancel_leave_old_output_intact() {
    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    job.append(1, SVG).unwrap();
    let destination = root.path().join("new.zip");
    let observed = Destination::select(destination.clone()).unwrap();
    fs::write(&destination, b"appeared").unwrap();
    assert!(observed.check().is_err());
    drop(observed);
    let archive_path = job
        .io
        .lock()
        .unwrap()
        .archive
        .as_ref()
        .unwrap()
        .archive
        .path
        .clone();
    let original = root.path().join("held-archive");
    fs::rename(&archive_path, &original).unwrap();
    fs::write(&archive_path, b"foreign archive").unwrap();
    assert!(
        job.finish(
            || Ok(Some(destination.clone())),
            |_| true,
            || job.commit_start(&session)
        )
        .is_err()
    );
    assert_eq!(fs::read(&destination).unwrap(), b"appeared");
    assert_eq!(fs::read(&archive_path).unwrap(), b"foreign archive");
    fs::remove_file(&archive_path).unwrap();
    fs::rename(original, archive_path).unwrap();
    job.reap().unwrap();
    close(root, session, job);

    let (root, session, job) = fixture(Mode::Svg, vec![1]);
    struct CancelWriter<'a> {
        job: &'a Job,
        bytes: Vec<u8>,
    }
    impl Write for CancelWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            self.job.retire().unwrap();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("cancel precedes flush")
        }
    }
    let mut output = CancelWriter {
        job: &job,
        bytes: Vec::new(),
    };
    let mut input = SVG;
    assert!(copy_checked(&mut input, &mut output, || job.live(), |_| Ok(())).is_err());
    job.reap().unwrap();
    cache_empty(root.path());
    close(root, session, job);
}
