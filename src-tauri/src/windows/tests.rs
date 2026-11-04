use super::*;
use crate::{export, media, navigation, navigation_cache};
use std::{fs, sync::mpsc, time::Duration};
use tauri::http::Request as HttpRequest;

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    for (name, contents) in [("a.md", "# A"), ("b.md", "# B"), ("sound.wav", "audio")] {
        fs::write(root.path().join(name), contents).unwrap();
    }
    root
}
fn stage(windows: &Registry, label: &str, path: &std::path::Path, request: u32) {
    let state = &windows.readers[label].session;
    let cancel = state.lock().unwrap().begin(request).unwrap();
    let document = documents::read_document(path, None, request, request, &cancel).unwrap();
    state.lock().unwrap().stage(request, document).unwrap();
}
fn cleanup(mut windows: Registry, root: tempfile::TempDir) {
    let labels = windows.readers.keys().cloned().collect::<Vec<_>>();
    for label in labels {
        retire(windows.detach(&label).unwrap()).unwrap();
    }
    let path = root.path().to_owned();
    root.close().unwrap();
    assert!(!path.exists());
}
#[test]
fn native_reservations_readiness_commit_and_route_specific_replacement() {
    let root = fixture();
    let a = root.path().join("a.md").canonicalize().unwrap();
    let b = root.path().join("b.md").canonicalize().unwrap();
    let mut windows = Registry::default();
    let origin = windows.enroll(None).unwrap();
    stage(&windows, &origin, &a, 1);
    windows.commit(&origin, 1).unwrap();
    let source = windows.readers[&origin].session.clone();
    source.lock().unwrap().begin(2).unwrap();
    let (destination, created) = windows
        .reserve(b.clone(), None, Some((&source, 2, None)), false)
        .unwrap()
        .unwrap();
    assert!(created);
    assert!(windows.owner(&b).is_none());
    assert_eq!(windows.reservation(&b), Some(destination.clone()));
    let token = windows.readers[&destination]
        .pending
        .as_ref()
        .unwrap()
        .token;
    assert!(windows.accept(&destination, token, 1).is_err());
    assert!(
        matches!(windows.pending(&destination).unwrap(), Some(Request::Open { token: actual }) if actual == token)
    );
    assert!(matches!(
        windows.pending(&destination).unwrap(),
        Some(Request::Open { .. })
    ));
    assert_eq!(
        windows
            .reserve(b.clone(), Some("part".into()), None, false)
            .unwrap(),
        Some((destination.clone(), false))
    );
    let opening = windows.accept(&destination, token, 1).unwrap();
    assert_eq!(opening.fragment.as_deref(), Some("part"));
    assert!(windows.pending(&destination).unwrap().is_none());
    assert!(windows.accept(&destination, token, 2).is_err());
    assert!(
        windows
            .reserve(b.clone(), Some("later-section".into()), None, false)
            .is_err()
    );
    // Acceptance transfers lifetime: closing the source cannot revoke destination work.
    retire(windows.detach(&origin).unwrap()).unwrap();
    assert!(source.lock().unwrap().begin(3).is_err());
    assert!(source.lock().unwrap().caller(&origin).is_err());
    let document = documents::read_document(&opening.path, None, 1, 1, &opening.cancel).unwrap();
    opening.state.lock().unwrap().stage(1, document).unwrap();
    assert!(windows.owner(&b).is_none());
    windows.commit(&destination, 1).unwrap();
    assert!(windows.owns(&destination, &b));
    assert_eq!(windows.owner(&b), Some(destination.clone()));
    assert!(windows.reservation(&b).is_none());
    // No read/reload: an externally changed file does not change the displayed snapshot.
    fs::write(&b, "# Changed on disk").unwrap();
    assert_eq!(
        windows.reserve(b.clone(), None, None, true).unwrap(),
        Some((destination.clone(), false))
    );
    assert_eq!(
        opening
            .state
            .lock()
            .unwrap()
            .active(1, 1)
            .unwrap()
            .snapshot
            .source,
        "# B"
    );
    assert!(
        windows
            .reserve(a.clone(), None, None, true)
            .unwrap()
            .is_none()
    );
    // Retained sidebar/sibling replacement may display an already-open path.
    let duplicate = windows.enroll(None).unwrap();
    stage(&windows, &duplicate, &b, 1);
    windows.commit(&duplicate, 1).unwrap();
    assert_eq!(
        windows
            .readers
            .values()
            .filter(|reader| reader.path.as_ref() == Some(&b))
            .count(),
        2
    );
    cleanup(windows, root);
}
#[test]
fn cancelled_staged_and_closed_requests_release_only_the_matching_reservation() {
    let root = fixture();
    let b = root.path().join("b.md").canonicalize().unwrap();
    let mut windows = Registry::default();
    let (label, _) = windows
        .reserve(b.clone(), None, None, false)
        .unwrap()
        .unwrap();
    let token = windows.readers[&label].pending.as_ref().unwrap().token;
    windows.pending(&label).unwrap();
    let opening = windows.accept(&label, token, 7).unwrap();
    windows.cancel(&label, 6).unwrap();
    assert!(windows.reservation(&b).is_some());
    windows.cancel(&label, 7).unwrap();
    assert!(windows.reservation(&b).is_none());
    assert!(documents::read_document(&b, None, 7, 7, &opening.cancel).is_err());
    let (next, _) = windows
        .reserve(b.clone(), None, None, false)
        .unwrap()
        .unwrap();
    assert_ne!(label, next);
    assert_ne!(
        token,
        windows.readers[&next].pending.as_ref().unwrap().token
    );
    retire(windows.detach(&label).unwrap()).unwrap();
    assert_eq!(windows.reservation(&b), Some(next.clone()));
    let stale = windows.readers[&next].session.clone();
    retire(windows.detach(&next).unwrap()).unwrap();
    assert!(windows.reservation(&b).is_none());
    assert!(stale.lock().unwrap().begin(1).is_err());
    cleanup(windows, root);
}
#[test]
fn canonical_alias_races_share_one_pending_receiver() {
    let root = fixture();
    let path = root.path().join("a.md");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&path, root.path().join("alias.md")).unwrap();
    #[cfg(not(unix))]
    let alias = path.clone();
    #[cfg(unix)]
    let alias = root.path().join("alias.md");
    let registry = Arc::new(Mutex::new(Registry::default()));
    let threads = [path, alias]
        .into_iter()
        .map(|path| {
            let registry = registry.clone();
            std::thread::spawn(move || {
                let path = documents::contained_file(&path, None).unwrap();
                registry
                    .lock()
                    .unwrap()
                    .reserve(path, None, None, false)
                    .unwrap()
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let outcomes = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes[0].0, outcomes[1].0);
    assert_eq!(outcomes.iter().filter(|(_, create)| *create).count(), 1);
    cleanup(
        Arc::try_unwrap(registry)
            .ok()
            .unwrap()
            .into_inner()
            .unwrap(),
        root,
    );
}
#[test]
fn startup_suppresses_the_initial_empty_reader_only_when_file_work_exists() {
    // (a) No startup file and no queued work: one empty reader, as before.
    let mut windows = Registry::default();
    let label = windows.startup(&[]).unwrap().unwrap();
    assert_eq!(windows.readers.len(), 1);
    let reader = &windows.readers[&label];
    assert!(reader.path.is_none() && reader.pending.is_none());
    assert!(windows.started);
    // (d) Rejected startup entries count as work too: no blank reader; the
    // drain worker converts each entry into an error reader through the
    // unchanged `empty(Some(error))` recovery path.
    let rejected = Err(AppError::new(
        "denied",
        "The opening application's directory is unavailable.",
    ));
    let mut windows = Registry::default();
    assert!(windows.startup(&[rejected]).unwrap().is_none());
    assert!(windows.started && windows.readers.is_empty());
    // (b) A startup file: no blank reader is enrolled, and the file still
    // reserves a fresh first reader carrying its pending request.
    let root = fixture();
    let a = root.path().join("a.md").canonicalize().unwrap();
    let mut windows = Registry::default();
    assert!(windows.startup(&[Ok(a.clone())]).unwrap().is_none());
    assert!(windows.started && windows.readers.is_empty());
    let (label, created) = windows.reserve(a, None, None, false).unwrap().unwrap();
    assert!(created);
    assert_eq!(label, "reader-1"); // The suppressed blank never consumed a label.
    assert!(windows.readers[&label].pending.is_some());
    cleanup(windows, root);
    // (c) Work queued before setup (an early single-instance callback): the
    // blank is suppressed and the queue is left for the started drain.
    let root = fixture();
    let b = root.path().join("b.md").canonicalize().unwrap();
    let mut windows = Registry::default();
    windows.incoming.push(Ok(b));
    assert!(windows.startup(&[]).unwrap().is_none());
    assert!(windows.started);
    assert_eq!(windows.incoming.len(), 1);
    cleanup(windows, root);
}
#[test]
fn an_enqueue_racing_the_startup_decision_never_leaves_a_stranded_blank_window() {
    // Each thread mimics `enqueue`: extend `incoming` and snapshot
    // `started` under one lock hold, exactly as the single-instance
    // callback does when it races setup's initial-empty decision.
    let registry = Arc::new(Mutex::new(Registry::default()));
    let pushers = (0..4)
        .map(|n| {
            let registry = registry.clone();
            std::thread::spawn(move || {
                let mut early = false;
                if let Ok(mut windows) = registry.lock() {
                    windows
                        .incoming
                        .push(Ok(PathBuf::from(format!("race-{n}.md"))));
                    early = !windows.started;
                }
                early
            })
        })
        .collect::<Vec<_>>();
    let decision = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            let mut windows = registry.lock().unwrap();
            windows.startup(&[]).unwrap()
        })
    };
    let early = pushers
        .into_iter()
        .map(|pusher| pusher.join().unwrap())
        .filter(|early| *early)
        .count();
    let suppressed = decision.join().unwrap().is_none();
    // A pusher that observed `started == false` queued its entry strictly
    // before the decision's critical section, so the decision must have
    // suppressed the blank; an enrolled blank implies `started` flipped with
    // the enroll, and every racing enqueue observes it and drains itself.
    assert_eq!(early > 0, suppressed);
    let windows = Arc::try_unwrap(registry)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap();
    assert!(windows.started);
    assert_eq!(windows.readers.len(), usize::from(!suppressed));
    if let Some(label) = windows.readers.keys().next() {
        let reader = &windows.readers[label];
        assert!(reader.path.is_none() && reader.pending.is_none());
    }
}
#[test]
fn same_numeric_ids_do_not_cross_media_root_export_or_presentation_owners() {
    let root = fixture();
    let mut windows = Registry::default();
    let a = windows.enroll(None).unwrap();
    let b = windows.enroll(None).unwrap();
    for (label, name) in [(&a, "a.md"), (&b, "b.md")] {
        stage(&windows, label, &root.path().join(name), 1);
        windows.commit(label, 1).unwrap();
    }
    let one = windows.readers[&a].session.clone();
    let two = windows.readers[&b].session.clone();
    assert!(one.lock().unwrap().caller(&b).is_err());
    assert!(two.lock().unwrap().caller("reader-999").is_err());
    assert!(two.lock().unwrap().caller("reader-").is_err());
    let scope = media::scope(&one.lock().unwrap(), &a, 1, 1).unwrap();
    let grant = media::resolve(scope, "sound.wav").unwrap();
    let media = media::insert(&mut one.lock().unwrap(), grant).unwrap();
    let request = || {
        HttpRequest::builder()
            .uri(format!("reader-media://localhost/{}", media.id))
            .body(Vec::new())
            .unwrap()
    };
    let policy = crate::remote_images::Policy::new(&[]);
    assert_eq!(
        media::serve(&policy, &one, &a, request(), |r| r.status()),
        200
    );
    assert_eq!(
        media::serve(&policy, &two, &b, request(), |r| r.status()),
        404
    );
    assert_eq!(
        media::serve(&policy, &one, &b, request(), |r| r.status()),
        403
    );
    let scope = one
        .lock()
        .unwrap()
        .navigation
        .start(navigation::root_path(root.path()).unwrap(), false)
        .unwrap();
    let scope = navigation::scan(scope, true).unwrap();
    let index = one.lock().unwrap().navigation.publish(scope).unwrap();
    assert!(two.lock().unwrap().navigation.scope(index.scope).is_err());
    let begin = export::Begin {
        document_id: 1,
        revision: 1,
        mode: export::Mode::Svg,
        ordinals: vec![1],
    };
    let job = export::Job::enroll(&mut one.lock().unwrap(), &a, begin).unwrap();
    job.prepare(&root.path().join("cache")).unwrap();
    let binding = export::Binding {
        export_id: job.id,
        document_id: 1,
        revision: 1,
        mode: export::Mode::Svg,
    };
    assert!(export::Job::lookup(&two.lock().unwrap(), &b, &binding).is_err());
    assert!(export::Job::lookup(&one.lock().unwrap(), &b, &binding).is_err());
    windows
        .readers
        .get_mut(&a)
        .unwrap()
        .presentation
        .accept(Presentation {
            sequence: 99,
            status_visible: false,
            ..Presentation::default()
        })
        .unwrap();
    windows
        .readers
        .get_mut(&b)
        .unwrap()
        .presentation
        .accept(Presentation {
            sequence: 1,
            page_zoom: 130,
            ..Presentation::default()
        })
        .unwrap();
    assert!(windows.readers[&b].presentation.status_visible);
    assert_eq!(windows.readers[&b].presentation.page_zoom, 130);
    retire(windows.detach(&a).unwrap()).unwrap();
    let policy = crate::remote_images::Policy::new(&[]);
    assert_eq!(
        media::serve(&policy, &one, &a, request(), |r| r.status()),
        403
    );
    assert!(two.lock().unwrap().active(1, 1).is_ok());
    assert!(!root.path().join("cache").read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("run-")
    }));
    cleanup(windows, root);
}
#[test]
fn forwarded_paths_capture_cwd_preserve_native_paths_and_reject_lossy_items_independently() {
    let cwd = PathBuf::from(if cfg!(windows) {
        "C:\\fixture"
    } else {
        "/fixture"
    });
    let replies = arguments(
        ["space name.md", "Unicode-文.md", "broken-�.md"]
            .into_iter()
            .map(PathBuf::from),
        Some(cwd.clone()),
        true,
    );
    assert_eq!(replies[0].as_ref().unwrap(), &cwd.join("space name.md"));
    assert_eq!(replies[1].as_ref().unwrap(), &cwd.join("Unicode-文.md"));
    assert!(replies[2].is_err());
    assert!(arguments(["relative.md".into()], None, false)[0].is_err());
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let native = PathBuf::from(std::ffi::OsString::from_vec(b"native-\xff.md".to_vec()));
        assert_eq!(
            arguments([native.clone()], Some(cwd.clone()), false)[0]
                .as_ref()
                .unwrap(),
            &cwd.join(native)
        );
    }
}
#[test]
fn focus_fragments_bind_displayed_revision_and_reject_actual_native_owners() {
    let root = fixture();
    let path = root.path().join("a.md").canonicalize().unwrap();
    let mut windows = Registry::default();
    let label = windows.enroll(None).unwrap();
    stage(&windows, &label, &path, 1);
    windows.commit(&label, 1).unwrap();
    windows.pending(&label).unwrap();
    for (busy, composing, modal) in [
        (true, false, crate::presentation::Modal::None),
        (false, true, crate::presentation::Modal::None),
        (false, false, crate::presentation::Modal::Other),
    ] {
        windows.readers.get_mut(&label).unwrap().presentation = Presentation {
            busy,
            composing,
            modal,
            ..Presentation::default()
        };
        assert!(
            windows
                .reserve(path.clone(), Some("heading".into()), None, false)
                .is_err()
        );
        assert!(windows.reserve(path.clone(), None, None, false).is_ok());
        assert!(windows.readers[&label].pending.is_none());
    }
    windows.readers.get_mut(&label).unwrap().presentation = Presentation::default();
    windows
        .reserve(path, Some("heading".into()), None, false)
        .unwrap();
    assert!(matches!(
        windows.pending(&label).unwrap(),
        Some(Request::Focus {
            document_id: 1,
            revision: 1,
            ..
        })
    ));
    cleanup(windows, root);
}
#[test]
fn the_reader_folder_refresh_seam_rescans_a_live_worker_and_tolerates_none() {
    let root = fixture();
    let mut windows = Registry::default();
    let label = windows.enroll(None).unwrap();
    let state = windows.readers[&label].session.clone();
    // No worker yet: the settings-driven seam is a no-op, never a failure.
    refresh_reader_folder(&state);
    let scope = state
        .lock()
        .unwrap()
        .navigation
        .start(navigation::root_path(root.path()).unwrap(), false)
        .unwrap();
    let lifetime = scope.lifetime.clone();
    let id = scope.id;
    let callback_state = state.clone();
    let (published, ready) = mpsc::channel();
    let worker =
        navigation_cache::RootWorker::start(root.path().to_owned(), lifetime, move |work| {
            navigation_cache::apply(&callback_state, id, work, 4, |_| {
                let _ = published.send(());
            })
        })
        .unwrap();
    state.lock().unwrap().navigation.worker = Some(worker);
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let scans_before = state.lock().unwrap().navigation.status.scans;
    // The settings-commit path refreshes through this seam; the worker's
    // next full scan is the depth rescan.
    refresh_reader_folder(&state);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while state.lock().unwrap().navigation.status.scans == scans_before {
        assert!(std::time::Instant::now() < deadline, "bounded rescan wait");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(state.lock().unwrap().navigation.status.scans > scans_before);
    cleanup(windows, root);
}
#[test]
fn retirement_reaps_root_worker_and_waits_for_non_cancellable_export_completion() {
    let root = fixture();
    let mut windows = Registry::default();
    let label = windows.enroll(None).unwrap();
    stage(&windows, &label, &root.path().join("a.md"), 1);
    windows.commit(&label, 1).unwrap();
    let state = windows.readers[&label].session.clone();
    let scope = state
        .lock()
        .unwrap()
        .navigation
        .start(navigation::root_path(root.path()).unwrap(), false)
        .unwrap();
    let lifetime = scope.lifetime.clone();
    let id = scope.id;
    let callback_state = state.clone();
    let (published, ready) = mpsc::channel();
    let worker =
        navigation_cache::RootWorker::start(root.path().to_owned(), lifetime, move |work| {
            navigation_cache::apply(&callback_state, id, work, 4, |_| {
                let _ = published.send(());
            })
        })
        .unwrap();
    state.lock().unwrap().navigation.worker = Some(worker);
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let job = export::Job::enroll(
        &mut state.lock().unwrap(),
        &label,
        export::Begin {
            document_id: 1,
            revision: 1,
            mode: export::Mode::Svg,
            ordinals: vec![1],
        },
    )
    .unwrap();
    job.prepare(&root.path().join("cache")).unwrap();
    job.append(
        1,
        b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>",
    )
    .unwrap();
    let finish_state = state.clone();
    let target = root.path().join("result.zip");
    let destination = target.clone();
    let (committing, started) = mpsc::channel();
    let (release, continue_commit) = mpsc::channel();
    let output = std::thread::spawn(move || {
        job.finish(
            || Ok(Some(destination)),
            |_| true,
            || {
                job.commit_start(&finish_state.lock().unwrap())?;
                committing.send(()).unwrap();
                continue_commit
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(())
            },
        )
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let reader = windows.detach(&label).unwrap();
    let (retired, completion) = mpsc::channel();
    let reaper = std::thread::spawn(move || {
        let result = retire(reader);
        retired.send(result).unwrap();
    });
    assert!(completion.try_recv().is_err());
    release.send(()).unwrap();
    assert!(matches!(
        output.join().unwrap().unwrap(),
        export::Outcome::Committed { .. }
    ));
    completion
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    reaper.join().unwrap();
    assert!(target.is_file());
    assert!(state.lock().unwrap().navigation.worker.is_none());
    assert!(state.lock().unwrap().begin(2).is_err());
    cleanup(windows, root);
}

#[test]
fn colliding_root_bindings_resolve_only_local_entries_and_root_replacement_rejects_unaccepted_handoffs()
 {
    let root = fixture();
    let paths = [root.path().join("one"), root.path().join("two")];
    for (path, source) in paths.iter().zip(["# One", "# Two"]) {
        fs::create_dir(path).unwrap();
        fs::write(path.join("doc.md"), source).unwrap();
    }
    let mut windows = Registry::default();
    let labels = [windows.enroll(None).unwrap(), windows.enroll(None).unwrap()];
    let mut indexes = Vec::new();
    for (label, path) in labels.iter().zip(&paths) {
        stage(&windows, label, &path.join("doc.md"), 1);
        windows.commit(label, 1).unwrap();
        let state = &windows.readers[label].session;
        let scope = state
            .lock()
            .unwrap()
            .navigation
            .start(navigation::root_path(path).unwrap(), false)
            .unwrap();
        let scope = navigation::scan(scope, true).unwrap();
        indexes.push(state.lock().unwrap().navigation.publish(scope).unwrap());
    }
    assert_eq!(indexes[0].scope, indexes[1].scope);
    assert_eq!(indexes[0].revision, indexes[1].revision);
    assert_eq!(indexes[0].entries[0].id, indexes[1].entries[0].id);
    let binding = navigation::Binding {
        scope: indexes[0].scope,
        revision: indexes[0].revision,
        entry: indexes[0].entries[0].id,
    };
    let other = windows.readers[&labels[1]].session.clone();
    let scope = other
        .lock()
        .unwrap()
        .navigation
        .scope(binding.scope)
        .unwrap();
    let entry = scope.entry(binding).unwrap();
    let read = scope
        .read(&entry, 2, 2, &std::sync::atomic::AtomicBool::new(false))
        .unwrap();
    assert_eq!(read.snapshot.source, "# Two");
    assert_eq!(read.path, paths[1].join("doc.md").canonicalize().unwrap());
    let source = windows.readers[&labels[0]].session.clone();
    let stale_scope = source
        .lock()
        .unwrap()
        .navigation
        .scope(binding.scope)
        .unwrap();
    source.lock().unwrap().begin(2).unwrap();
    source
        .lock()
        .unwrap()
        .navigation
        .start(navigation::root_path(&paths[1]).unwrap(), false)
        .unwrap();
    assert!(source.lock().unwrap().current(2).is_ok());
    assert!(
        windows
            .reserve(
                root.path().join("b.md").canonicalize().unwrap(),
                None,
                Some((&source, 2, Some(&stale_scope))),
                false
            )
            .is_err()
    );
    assert_eq!(windows.readers.len(), 2);
    retire(windows.detach(&labels[0]).unwrap()).unwrap();
    scope.live().unwrap();
    other.lock().unwrap().active(1, 1).unwrap();
    cleanup(windows, root);
}

#[test]
fn package_configuration_keeps_viewer_aliases_supported_platforms_and_narrow_delivery_seams() {
    let common: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let bundle = &common["bundle"];
    assert_eq!(common["productName"], "taurimd");
    assert_eq!(common["mainBinaryName"], "taurimd");
    // Preserve existing identifier-derived preferences and single-instance behavior.
    assert_eq!(common["identifier"], "com.chrysent.mdviewerrsx");
    assert_eq!(common["build"]["frontendDist"], "frontend-dist");
    assert_eq!(bundle["fileAssociations"][0]["name"], "taurimd.Markdown");
    assert_eq!(bundle["publisher"], "Chrysent");
    assert_eq!(bundle["license"], "MIT");
    assert_eq!(bundle["fileAssociations"].as_array().unwrap().len(), 1);
    assert_eq!(bundle["fileAssociations"][0]["role"], "Viewer");
    assert_eq!(
        bundle["fileAssociations"][0]["ext"],
        serde_json::json!(["md", "markdown", "mdown", "mkd", "mkdown"])
    );
    let csp = common["app"]["security"]["csp"].as_str().unwrap();
    for policy in [
        "default-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
    ] {
        assert!(csp.contains(policy));
    }
    assert!(!csp.contains("https:"));
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/reader.json")).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["reader-*"]));
    // The Escape fullscreen seam stays a granted reader command; dropping it
    // would silently disable the keypress instead of failing loudly.
    assert!(
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission == "allow-exit-fullscreen-if")
    );
    for (text, targets) in [
        (
            include_str!("../../tauri.macos.conf.json"),
            serde_json::json!(["app", "dmg"]),
        ),
        (
            include_str!("../../tauri.windows.conf.json"),
            serde_json::json!(["nsis"]),
        ),
        (
            include_str!("../../tauri.linux.conf.json"),
            serde_json::json!(["deb", "appimage"]),
        ),
    ] {
        let config: serde_json::Value = serde_json::from_str(text).unwrap();
        let _: tauri::utils::config::BundleConfig =
            serde_json::from_value(config["bundle"].clone()).unwrap();
        assert_eq!(config["bundle"]["targets"], targets);
    }
    assert!(include_str!("../../packaging/taurimd.desktop").contains("Exec={{exec}} %F"));
    assert!(
        include_str!("../../packaging/associations.nsh")
            .contains("Software\\Classes\\taurimd.Markdown\\shell\\open\\command")
    );
    let linux: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.linux.conf.json")).unwrap();
    assert_eq!(
        linux["bundle"]["linux"]["deb"]["files"]["/usr/share/mime/packages/taurimd.xml"],
        "packaging/taurimd.xml"
    );
    assert!(include_str!("../../packaging/associations.nsh").contains("NSIS_HOOK_POSTINSTALL"));
    assert!(include_str!("../../packaging/associations.nsh").contains("$\\\"%1$\\\""));
    // The binstall metadata resolves the archived candidate that the
    // validated tag-only package-candidates job retains, and names the
    // versioned directory the binary sits inside.
    let cargo = include_str!("../../Cargo.toml");
    assert!(cargo.contains("repository = \"https://github.com/Chrysent-AI/taurimd\""));
    assert!(cargo.contains("[package.metadata.binstall]"));
    assert!(cargo.contains(
        "pkg-url = \"{ repo }/releases/download/v{ version }/{ name }-{ target }-v{ version }.tgz\"",
    ));
    assert!(
        cargo.contains("bin-dir = \"{ name }-{ target }-v{ version }/{ bin }{ binary-ext }\"",)
    );
    assert!(cargo.contains("pkg-fmt = \"tgz\""));
}
