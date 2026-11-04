use super::*;
use notify::event::{AccessKind, Flag};
use std::{fs, path::Path, sync::mpsc};
fn control() -> (Arc<Control>, Receiver<()>) {
    let (wake, receiver) = mpsc::sync_channel(1);
    (
        Arc::new(Control {
            stopped: Arc::new(AtomicBool::new(false)),
            dirty: AtomicBool::new(false),
            manual: AtomicBool::new(false),
            error: AtomicBool::new(false),
            directory: Mutex::new(None),
            wake,
        }),
        receiver,
    )
}
fn handler_with(control: &Arc<Control>, root: &Path) -> Handler {
    Handler {
        control: control.clone(),
        root: root.to_path_buf(),
        released: None,
    }
}
#[test]
fn production_handler_ignores_access_and_preserves_dirty_error_on_full_wake() {
    assert!(!watch_config().follow_symlinks());
    let (control, wake) = control();
    let (sender, released) = mpsc::sync_channel(1);
    let mut handler = Handler {
        control: control.clone(),
        root: PathBuf::from("/fixture-root"),
        released: Some(sender),
    };
    handler.handle_event(Ok(notify::Event::new(EventKind::Access(AccessKind::Read))));
    assert!(!control.dirty.load(Ordering::Acquire));
    handler.handle_event(Ok(notify::Event::new(EventKind::Any).set_flag(Flag::Rescan)));
    for _ in 0..1000 {
        handler.handle_event(Ok(notify::Event::new(EventKind::Create(
            notify::event::CreateKind::File,
        ))));
    }
    handler.handle_event(Err(notify::Error::generic("fixture")));
    assert!(control.dirty.swap(false, Ordering::AcqRel));
    assert!(control.error.swap(false, Ordering::AcqRel));
    assert!(wake.try_recv().is_ok());
    assert!(wake.try_recv().is_err());
    control.stopped.store(true, Ordering::Release);
    handler.handle_event(Ok(notify::Event::new(EventKind::Any)));
    assert!(!control.dirty.load(Ordering::Acquire));
    drop(handler);
    released.recv_timeout(Duration::from_secs(2)).unwrap();
}
#[test]
fn watcher_events_from_ignored_subtrees_never_mark_dirty_and_others_still_do() {
    let (control, wake) = control();
    let root = PathBuf::from("/fixture-root");
    let mut handler = handler_with(&control, &root);
    let create = || notify::Event::new(EventKind::Create(notify::event::CreateKind::File));
    let mut mark_dirty = |event: notify::Event| {
        handler.handle_event(Ok(event));
        let dirty = control.dirty.swap(false, Ordering::AcqRel);
        if dirty {
            let _ = wake.try_recv();
        }
        dirty
    };
    // Every ignored name filters at any depth, including the ignored
    // directory itself: its creation or removal changes nothing recorded.
    for relative in [
        "node_modules",
        "node_modules/pkg/index.js",
        ".git/objects/ab/cd",
        "target/debug/deps/lib.rs",
        "dist/bundle.js",
        "build/out.o",
        ".venv/bin/python",
        "venv/lib/site.py",
        "__pycache__/mod.cpython.pyc",
        "src/node_modules/deep/inner.md",
    ] {
        assert!(
            !mark_dirty(create().add_path(root.join(relative))),
            "{relative}"
        );
    }
    // Paths the root cannot attribute are never filtered.
    assert!(mark_dirty(
        create().add_path(PathBuf::from("/fixture-rooter/src/a.md"))
    ));
    // A mixed event still wakes: some path is actionable.
    assert!(mark_dirty(
        create()
            .add_path(root.join("node_modules/x.js"))
            .add_path(root.join("src/a.md"))
    ));
    // No attributable paths at all stays dirty.
    assert!(mark_dirty(create()));
    // Access events remain ignored everywhere.
    assert!(!mark_dirty(
        notify::Event::new(EventKind::Access(AccessKind::Read)).add_path(root.join("src/a.md"))
    ));
    // An explicit rescan flag is honored even from an ignored subtree.
    assert!(mark_dirty(
        notify::Event::new(EventKind::Any)
            .set_flag(Flag::Rescan)
            .add_path(root.join("node_modules/x.js"))
    ));
}
#[test]
fn ignored_subtree_predicate_needs_the_root_and_exact_names() {
    let root = Path::new("/fixture-root");
    assert!(navigation::in_ignored_subtree(
        root,
        &root.join("build/deep/a.md")
    ));
    // The watched root itself is never inside an ignored subtree, so its
    // own events stay actionable.
    assert!(!navigation::in_ignored_subtree(root, root));
    assert!(!navigation::in_ignored_subtree(
        root,
        &root.join("built/a.md")
    ));
    assert!(!navigation::in_ignored_subtree(
        root,
        &root.join("src/a.md")
    ));
    // Name matching is exact and case-sensitive, like the scan's descent.
    assert!(!navigation::in_ignored_subtree(
        root,
        &root.join("Node_Modules/x.js")
    ));
    assert!(!navigation::in_ignored_subtree(
        root,
        &root.join("node_modules.md")
    ));
    assert!(navigation::ignored_directory(std::ffi::OsStr::new(
        "__pycache__"
    )));
    assert!(!navigation::ignored_directory(std::ffi::OsStr::new(
        "pycache"
    )));
    // A plain file sharing an ignored name is not a directory predicate hit.
    assert_eq!(navigation::IGNORED_DIRECTORIES.len(), 8);
}
#[test]
fn injected_schedule_has_one_overdue_pass_and_no_catch_up_storm() {
    let now = Instant::now();
    let wall = SystemTime::now();
    let mut schedule = Schedule::new(now, wall, RECONCILE);
    schedule.scanned(now, wall);
    assert!(!schedule.due(now + RECONCILE - Duration::from_nanos(1), wall));
    assert!(schedule.due(now + RECONCILE, wall));
    // Suspend can advance wall time without advancing the platform's Instant.
    let resumed_wall = wall + RECONCILE * 100;
    assert!(schedule.due(now, resumed_wall));
    schedule.scanned(now, resumed_wall);
    assert!(!schedule.due(now, resumed_wall));
    assert_eq!(schedule.wait(now, false), RECONCILE);
    // A clock correction backwards does not suppress the monotonic deadline.
    assert!(schedule.due(now + RECONCILE, wall));
}
fn fixture() -> (tempfile::TempDir, Arc<Mutex<Session>>, u32) {
    let dir = tempfile::tempdir().unwrap();
    let mut session = Session::default();
    let scope = session
        .navigation
        .start(navigation::root_path(dir.path()).unwrap(), false)
        .unwrap();
    session.navigation.status = Status {
        scope: scope.id,
        revision: scope.revision,
        phase: "loading",
        ..Status::default()
    };
    (dir, Arc::new(Mutex::new(session)), scope.id)
}
fn reap(dir: tempfile::TempDir) {
    let path = dir.path().to_owned();
    dir.close().unwrap();
    assert!(!path.exists());
}
fn until(
    receiver: &Receiver<Status>,
    state: &Mutex<Session>,
    predicate: impl Fn(&Snapshot) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if predicate(&Snapshot::get(&state.lock().unwrap())) {
            return;
        }
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("bounded publication condition");
    }
}
#[test]
fn real_backend_watch_before_scan_create_rename_remove_then_handler_release_and_worker_join() {
    let (dir, state, id) = fixture();
    let path = navigation::root_path(dir.path()).unwrap();
    let (events, receiver) = mpsc::channel();
    let host = state.clone();
    let marker = path.join("before-scan.md");
    let (registration, registered) = mpsc::sync_channel(1);
    let mut first_registration = true;
    let lifetime = state
        .lock()
        .unwrap()
        .navigation
        .root
        .as_ref()
        .unwrap()
        .lifetime
        .clone();
    let worker = RootWorker::start(path.clone(), lifetime, move |work| {
        if first_registration && matches!(work, Work::Health(false)) {
            // The caller waits on registration before starting concurrent getters.
            assert!(host.try_lock().is_ok());
            first_registration = false;
            fs::write(&marker, "before scan").unwrap();
            registration.send(()).unwrap();
        }
        apply(&host, id, work, 4, |status| {
            let _ = events.send(status);
        })
    })
    .unwrap();
    registered.recv_timeout(Duration::from_secs(10)).unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "before-scan.md")
    });
    fs::write(path.join("created.md"), "# created").unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "created.md")
    });
    fs::rename(path.join("created.md"), path.join("renamed.log")).unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "renamed.log")
            && !snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "created.md")
    });
    fs::remove_file(path.join("renamed.log")).unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && !snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "renamed.log")
    });
    // Close revokes reading immediately, then extracts and reaps off Session.
    let cancel = state.lock().unwrap().begin(1).unwrap();
    let media = state.lock().unwrap().media_lifetime.clone();
    let retired = {
        let mut session = state.lock().unwrap();
        session.close_reads();
        std::mem::take(&mut *session)
    };
    assert!(cancel.load(Ordering::Acquire));
    assert!(media.load(Ordering::Acquire));
    drop(retired);
    // retire returns only after the actual handler guard and application worker.
    assert!(state.try_lock().is_ok());
    worker.retire();
    assert!(state.try_lock().is_ok());
    drop(state);
    reap(dir);
}
#[test]
fn dirty_during_held_initial_scan_repeats_and_root_replacement_rejects_late_work() {
    let (dir, state, id) = fixture();
    let path = navigation::root_path(dir.path()).unwrap();
    let (entered, holding) = mpsc::sync_channel(1);
    let (release, held) = mpsc::sync_channel(1);
    let (events, receiver) = mpsc::channel();
    let host = state.clone();
    let mut first = true;
    let lifetime = state
        .lock()
        .unwrap()
        .navigation
        .root
        .as_ref()
        .unwrap()
        .lifetime
        .clone();
    let worker = RootWorker::start(path.clone(), lifetime, move |work| {
        let pause = matches!(work, Work::Scan(_, _)) && first;
        if pause {
            first = false;
        }
        let boundary = AtomicBool::new(pause);
        apply(&host, id, work, 4, |status| {
            if boundary.swap(false, Ordering::AcqRel) {
                assert!(host.try_lock().is_ok(), "status publication is off Session");
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            let _ = events.send(status);
        })
    })
    .unwrap();
    holding.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(state.try_lock().is_ok());
    worker.control.dirty();
    worker.refresh();
    worker.refresh();
    release.send(()).unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready" && snapshot.status.scans >= 2
    });
    let before = state.lock().unwrap().navigation.status.sequence;
    let replacement = state.lock().unwrap().navigation.start(path, false).unwrap();
    assert_ne!(replacement.id, id);
    assert!(!apply(&state, id, Work::Health(true), 4, |_| panic!(
        "old publication"
    )));
    assert_eq!(state.lock().unwrap().navigation.status.sequence, before);
    worker.retire();
    drop(state);
    reap(dir);
}
#[test]
fn cache_filters_and_explicit_one_directory_traversal_have_distinct_production_counters() {
    let (dir, state, id) = fixture();
    fs::write(dir.path().join("kept.md"), [0xff]).unwrap();
    assert!(apply(&state, id, Work::Scan(None, true), 4, |_| {
        assert!(state.try_lock().is_ok());
    }));
    assert!(apply(&state, id, Work::Settled, 4, |_| {}));
    let scope = state.lock().unwrap().navigation.root.clone().unwrap();
    for query_id in 0..10 {
        let answer = navigation::query::query(
            &scope,
            navigation::query::Query {
                scope: scope.id,
                revision: scope.revision,
                query_id,
                text: "kept".into(),
                directory: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(answer.reply.total, 1);
    }
    assert_eq!(scope.filters.load(Ordering::Relaxed), 10);
    assert_eq!(state.lock().unwrap().navigation.status.scans, 1);
    assert_eq!(state.lock().unwrap().navigation.status.traversals, 0);
    fs::create_dir(dir.path().join("new")).unwrap();
    fs::write(dir.path().join("new/added.md"), "added").unwrap();
    let target = navigation::root_path(dir.path()).unwrap().join("new");
    assert!(apply(&state, id, Work::Scan(Some(target), true), 4, |_| {}));
    assert!(apply(&state, id, Work::Settled, 4, |_| {}));
    let snapshot = Snapshot::get(&state.lock().unwrap());
    assert_eq!(snapshot.status.scans, 1);
    assert_eq!(snapshot.status.traversals, 1);
    let added = PathBuf::from("new").join("added.md");
    assert!(
        snapshot
            .index
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.relative == added.to_string_lossy() && entry.parent.is_some())
    );
    assert!(!state.lock().unwrap().has_document());
    drop(scope);
    drop(state);
    reap(dir);
}
#[test]
fn a_depth_change_takes_effect_on_the_next_worker_scan_without_restarting() {
    let (dir, state, id) = fixture();
    fs::create_dir_all(dir.path().join("one/two")).unwrap();
    fs::write(dir.path().join("top.md"), "# Top").unwrap();
    fs::write(dir.path().join("one/mid.md"), "# Mid").unwrap();
    fs::write(dir.path().join("one/two/deep.md"), "# Deep").unwrap();
    let path = navigation::root_path(dir.path()).unwrap();
    let (events, receiver) = mpsc::channel();
    let host = state.clone();
    let lifetime = state
        .lock()
        .unwrap()
        .navigation
        .root
        .as_ref()
        .unwrap()
        .lifetime
        .clone();
    // The lifetime handle outlives the worker's ownership so the test can
    // prove the worker was never retired across the depth change.
    let lifetime_handle = lifetime.clone();
    // The host closure reads the depth at scan time exactly like production:
    // a settings change writes the new value and the next scan honors it.
    let depth = Arc::new(std::sync::atomic::AtomicUsize::new(1));
    let scan_depth = depth.clone();
    let worker = RootWorker::start(path.clone(), lifetime, move |work| {
        apply(
            &host,
            id,
            work,
            scan_depth.load(Ordering::SeqCst),
            |status| {
                let _ = events.send(status);
            },
        )
    })
    .unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .all(|entry| !entry.relative.contains('/'))
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "top.md")
    });
    let revision_before = state.lock().unwrap().navigation.status.revision;
    // The settings commit writes the new depth and refreshes the worker.
    depth.store(4, Ordering::SeqCst);
    worker.refresh();
    let deep = PathBuf::from("one").join("two").join("deep.md");
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready"
            && snapshot
                .index
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.relative == deep.to_string_lossy())
    });
    // The depth change took effect on the same worker owner — no restart:
    // the root scope identity is unchanged, its lifetime was never set (a
    // restart would have retired the old scope), and the status still tracks
    // that identity under a newer revision from the rescan. Platform watcher
    // events legitimately coalesce extra rescans, so the scan count pins a
    // floor (the initial scan plus the refresh rescan), never an exact value.
    let session = state.lock().unwrap();
    assert_eq!(session.navigation.root.as_ref().unwrap().id, id);
    assert!(!lifetime_handle.load(Ordering::Acquire));
    assert_eq!(session.navigation.status.scope, id);
    assert!(session.navigation.status.revision > revision_before);
    assert!(session.navigation.status.scans >= 2);
    drop(session);
    worker.retire();
    drop(state);
    reap(dir);
}
#[test]
fn registration_failure_degrades_but_manual_refresh_and_retry_use_same_owner() {
    let (dir, state, id) = fixture();
    let path = navigation::root_path(dir.path())
        .unwrap()
        .join("initially-missing");
    state.lock().unwrap().navigation.root.as_mut().unwrap().path = path.clone();
    let (events, receiver) = mpsc::channel();
    let host = state.clone();
    let lifetime = state
        .lock()
        .unwrap()
        .navigation
        .root
        .as_ref()
        .unwrap()
        .lifetime
        .clone();
    let worker = RootWorker::start_with(
        path.clone(),
        lifetime,
        Duration::from_millis(20),
        move |work| {
            apply(&host, id, work, 4, |status| {
                let _ = events.send(status);
            })
        },
    )
    .unwrap();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "unavailable" && snapshot.status.degraded
    });
    fs::create_dir(&path).unwrap();
    worker.refresh();
    until(&receiver, &state, |snapshot| {
        snapshot.status.phase == "ready" && !snapshot.status.degraded
    });
    worker.retire();
    drop(state);
    reap(dir);
}
