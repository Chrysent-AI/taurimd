use super::*;
use serde_json::json;
use std::sync::{Arc, Barrier};

fn patch(value: Value) -> Patch {
    serde_json::from_value(value).unwrap()
}
struct Fixture {
    guard: Option<tempfile::TempDir>,
    path: PathBuf,
}
impl Fixture {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.guard
            .take()
            .expect("fixture owner")
            .close()
            .expect("fixture cleanup");
        assert!(!self.path.exists());
    }
}
fn root() -> Fixture {
    let guard = tempfile::tempdir().unwrap();
    Fixture {
        path: guard.path().into(),
        guard: Some(guard),
    }
}
fn committed(update: Update) -> Record {
    match update {
        Update::Committed { record } => record,
        _ => panic!("expected commit"),
    }
}
#[test]
fn defaults_corrupt_and_independent_field_fallbacks() {
    let fixture = root();
    let file = fixture.path().join("settings-v1.json");
    let store = SettingsStore::load(Some(fixture.path().into()));
    assert_eq!(store.get().unwrap().settings, SettingsV1::default());
    assert!(store.get().unwrap().notice.is_none());
    for bytes in [b"broken".as_slice(), br#"{"version":2,"settings":{}}"#] {
        fs::write(&file, bytes).unwrap();
        let record = SettingsStore::load(Some(fixture.path().into()))
            .get()
            .unwrap();
        assert!(record.notice.is_some());
        assert_eq!(record.settings, SettingsV1::default());
    }
    fs::write(
        &file,
        serde_json::to_vec(&json!({"version":1,"revision":7,"settings": {
            "mode":"dark", "lightPalette":"unknown", "darkPalette":"nord", "pageZoom":305,
            "fitDiagrams": false, "sidebarDefault":"yes"
        }}))
        .unwrap(),
    )
    .unwrap();
    let record = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(record.revision, 7);
    assert_eq!(record.settings.mode, Mode::Dark);
    assert_eq!(record.settings.dark_palette, Palette::Nord);
    assert_eq!(record.settings.light_palette, Palette::GithubLight);
    assert_eq!(record.settings.page_zoom, 100);
    assert!(!record.settings.fit_diagrams);
    assert!(record.settings.sidebar_default);
    assert!(record.notice.is_some());
}
#[test]
fn status_visibility_legacy_absence_is_not_corruption_but_invalid_presence_is() {
    let fixture = root();
    let file = fixture.path().join("settings-v1.json");
    let mut legacy = serde_json::to_value(Record {
        version: 1,
        revision: 4,
        settings: SettingsV1::default(),
        notice: None,
    })
    .unwrap();
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("statusVisible");
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let old = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert!(old.settings.status_visible);
    assert!(old.notice.is_none());
    for invalid in [json!(null), json!("false"), json!(0)] {
        legacy["settings"]["statusVisible"] = invalid;
        fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let record = SettingsStore::load(Some(fixture.path().into()))
            .get()
            .unwrap();
        assert!(record.settings.status_visible);
        assert!(record.notice.is_some());
    }
    let store = SettingsStore::load(Some(fixture.path().into()));
    let saved = committed(
        store
            .update(4, patch(json!({"statusVisible":false})), |_| {})
            .unwrap(),
    );
    assert!(!saved.settings.status_visible);
    assert!(saved.notice.is_none());
    assert_eq!(
        SettingsStore::load(Some(fixture.path().into()))
            .get()
            .unwrap(),
        saved
    );
}
#[test]
fn file_order_fields_migrate_per_field_and_persist_atomically() {
    let fixture = root();
    let file = fixture.path().join("settings-v1.json");
    let mut legacy = serde_json::to_value(Record {
        version: 1,
        revision: 9,
        settings: SettingsV1::default(),
        notice: None,
    })
    .unwrap();
    // A valid older record without the order fields is not corruption.
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("fileSortKey");
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("fileSortDirection");
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let old = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(old.revision, 9);
    assert_eq!(old.settings.file_sort_key, FileSortKey::Name);
    assert_eq!(old.settings.file_sort_direction, FileSortDirection::Asc);
    assert!(old.notice.is_none());
    // A missing field keeps the other present field and the revision.
    let mut partial = legacy.clone();
    partial["settings"]["fileSortDirection"] = json!("desc");
    fs::write(&file, serde_json::to_vec(&partial).unwrap()).unwrap();
    let partial = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(partial.revision, 9);
    assert_eq!(partial.settings.file_sort_key, FileSortKey::Name);
    assert_eq!(
        partial.settings.file_sort_direction,
        FileSortDirection::Desc
    );
    assert!(partial.notice.is_none());
    // An invalid present value falls back for that field only.
    let mut invalid = legacy.clone();
    invalid["settings"]["fileSortKey"] = json!("mtime");
    invalid["settings"]["fileSortDirection"] = json!("desc");
    fs::write(&file, serde_json::to_vec(&invalid).unwrap()).unwrap();
    let invalid = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(invalid.settings.file_sort_key, FileSortKey::Name);
    assert_eq!(
        invalid.settings.file_sort_direction,
        FileSortDirection::Desc
    );
    assert!(invalid.notice.is_some());
    // A valid two-field patch commits both fields and survives a restart.
    let store = SettingsStore::load(Some(fixture.path().into()));
    let saved = committed(
        store
            .update(
                9,
                patch(json!({"fileSortKey":"modified","fileSortDirection":"desc"})),
                |_| {},
            )
            .unwrap(),
    );
    assert_eq!(saved.revision, 10);
    assert_eq!(saved.settings.file_sort_key, FileSortKey::Modified);
    assert_eq!(saved.settings.file_sort_direction, FileSortDirection::Desc);
    assert_eq!(
        SettingsStore::load(Some(fixture.path().into()))
            .get()
            .unwrap(),
        saved
    );
    assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
    // A stale revision returns the current record without losing the order.
    let Update::Conflict { record } = store
        .update(9, patch(json!({"fileSortKey":"size"})), |_| {
            panic!("no stale event")
        })
        .unwrap()
    else {
        panic!("expected conflict");
    };
    assert_eq!(record, saved);
    assert_eq!(record.settings.file_sort_key, FileSortKey::Modified);
    // A failed save keeps the committed record and reaps its own temporary.
    let config = fixture.path().join("config");
    let failing = SettingsStore::load(Some(config.clone()));
    let committed_record = committed(
        failing
            .update(0, patch(json!({"fileSortKey":"size"})), |_| {})
            .unwrap(),
    );
    assert_eq!(committed_record.settings.file_sort_key, FileSortKey::Size);
    let backup = fixture.path().join("saved-config");
    fs::rename(&config, &backup).unwrap();
    fs::create_dir(&config).unwrap();
    fs::create_dir(config.join("settings-v1.json")).unwrap();
    assert!(
        failing
            .update(1, patch(json!({"fileSortDirection":"asc"})), |_| panic!(
                "no failure event"
            ))
            .is_err()
    );
    assert_eq!(failing.get().unwrap(), committed_record);
    assert_eq!(fs::read_dir(&config).unwrap().count(), 1);
    assert_eq!(
        SettingsStore::load(Some(backup)).get().unwrap(),
        committed_record
    );
}
#[test]
fn atomic_replacement_restart_and_source_write_scope() {
    let fixture = root();
    let config = fixture.path().join("config");
    let source = fixture.path().join("source.md");
    fs::write(&source, b"# Unchanged\r\n").unwrap();
    let store = SettingsStore::load(Some(config.clone()));
    let mut events = vec![];
    let first = committed(store.update(0, patch(json!({"mode":"light","lightPalette":"dracula", "pageZoom":300,"fitDiagrams":false,"sidebarDefault":false,"statusVisible":false})), |record| {
        events.push(record.clone());
        assert_eq!(store.get().unwrap(), *record);
    }).unwrap());
    let file = config.join("settings-v1.json");
    let previous = fs::read(&file).unwrap();
    // Replacing this hardlinked directory entry must not truncate its peer.
    let peer = fixture.path().join("previous.json");
    fs::hard_link(&file, &peer).unwrap();
    let second = committed(
        store
            .update(1, patch(json!({"darkPalette":"githubLight"})), |record| {
                events.push(record.clone());
            })
            .unwrap(),
    );
    assert_eq!(fs::read(peer).unwrap(), previous);
    assert_eq!(second.revision, 2);
    assert_eq!(events, [first, second.clone()]);
    drop(store);
    assert_eq!(
        SettingsStore::load(Some(config.clone())).get().unwrap(),
        second
    );
    assert_eq!(fs::read(source).unwrap(), b"# Unchanged\r\n");
    assert_eq!(fs::read_dir(config).unwrap().count(), 1);
    let text = String::from_utf8(fs::read(file).unwrap()).unwrap();
    assert!(!text.contains("source.md"));
    assert!(!text.contains("config"));
    drop(fixture);
}
#[test]
fn stale_patches_return_current_without_losing_unrelated_fields() {
    let fixture = root();
    let store = SettingsStore::load(Some(fixture.path().into()));
    let first = committed(
        store
            .update(0, patch(json!({"fitDiagrams":false})), |_| {})
            .unwrap(),
    );
    let Update::Conflict { record } = store
        .update(0, patch(json!({"mode":"dark"})), |_| {
            panic!("no stale event")
        })
        .unwrap()
    else {
        panic!("expected conflict");
    };
    assert_eq!(record, first);
    let retry = committed(
        store
            .update(record.revision, patch(json!({"mode":"dark"})), |_| {})
            .unwrap(),
    );
    assert_eq!(retry.settings.mode, Mode::Dark);
    assert!(!retry.settings.fit_diagrams);
}
#[test]
fn save_failure_keeps_committed_revision_and_owned_temp_is_reaped() {
    let fixture = root();
    let config = fixture.path().join("config");
    let store = SettingsStore::load(Some(config.clone()));
    let saved = committed(
        store
            .update(0, patch(json!({"pageZoom":150})), |_| {})
            .unwrap(),
    );
    let backup = fixture.path().join("saved-config");
    fs::rename(&config, &backup).unwrap();
    fs::create_dir(&config).unwrap();
    fs::create_dir(config.join("settings-v1.json")).unwrap();
    assert!(
        store
            .update(1, patch(json!({"pageZoom":200})), |_| panic!(
                "no failure event"
            ))
            .is_err()
    );
    assert_eq!(store.get().unwrap(), saved);
    assert_eq!(SettingsStore::load(Some(backup)).get().unwrap(), saved);
    assert_eq!(fs::read_dir(&config).unwrap().count(), 1);
    assert!(config.join("settings-v1.json").is_dir());
    assert!(
        SettingsStore::load(None)
            .update(0, Patch::default(), |_| {})
            .is_err()
    );
}
#[test]
fn concurrent_writers_are_serialized_and_only_one_expected_revision_commits() {
    let fixture = root();
    let store = Arc::new(SettingsStore::load(Some(fixture.path().into())));
    let barrier = Arc::new(Barrier::new(3));
    let threads: Vec<_> = [false, true]
        .into_iter()
        .map(|fit| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .update(0, patch(json!({"fitDiagrams":fit})), |_| {})
                    .unwrap()
            })
        })
        .collect();
    barrier.wait();
    let committed = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|result| matches!(result, Update::Committed { .. }))
        .count();
    assert_eq!(committed, 1);
    assert_eq!(store.get().unwrap().revision, 1);
}
#[test]
fn remote_image_hosts_seed_once_stay_empty_when_saved_empty_and_fall_back_per_field() {
    let fixture = root();
    let file = fixture.path().join("settings-v1.json");
    let starters = remote_images::starter_host_list();
    assert_eq!(starters.len(), 4);
    assert!(starters.contains(&"github.com".to_owned()));
    assert!(starters.contains(&"raw.githubusercontent.com".to_owned()));
    assert!(starters.contains(&"camo.githubusercontent.com".to_owned()));
    assert!(starters.contains(&"user-images.githubusercontent.com".to_owned()));
    // A valid older record without the field is not corruption.
    let mut legacy = serde_json::to_value(Record {
        version: 1,
        revision: 2,
        settings: SettingsV1::default(),
        notice: None,
    })
    .unwrap();
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("remoteImageHosts");
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let old = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(old.settings.remote_image_hosts, starters);
    assert!(old.notice.is_none());
    // An invalid present value falls back for that field only.
    legacy["settings"]["remoteImageHosts"] = json!(["not a host"]);
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let invalid = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(invalid.settings.remote_image_hosts, starters);
    assert!(invalid.notice.is_some());
    assert_eq!(invalid.settings.mode, Mode::System);
    // A deliberately saved empty list stays empty and authorizes nothing.
    fs::remove_file(&file).unwrap();
    let store = SettingsStore::load(Some(fixture.path().into()));
    assert_eq!(store.get().unwrap().revision, 0);
    let emptied = committed(
        store
            .update(0, patch(json!({"remoteImageHosts": []})), |_| {})
            .unwrap(),
    );
    assert!(emptied.settings.remote_image_hosts.is_empty());
    let reloaded = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert!(reloaded.settings.remote_image_hosts.is_empty());
    assert!(reloaded.notice.is_none());
    assert!(store.policy().authorize("github.com").is_none());
    // An invalid entry rejects the whole patch without partial mutation.
    assert!(
        store
            .update(
                emptied.revision,
                patch(json!({"remoteImageHosts": ["https://github.com"]})),
                |_| {}
            )
            .is_err()
    );
    assert_eq!(store.get().unwrap(), emptied);
    // A valid list is canonicalized, de-duplicated and sorted.
    let canonical = committed(
        store
            .update(
                emptied.revision,
                patch(json!({"remoteImageHosts": ["Raw.GitHub.com", "raw.github.com", "raw.githubusercontent.com", "github.com"]})),
                |_| {},
            )
            .unwrap(),
    );
    assert_eq!(
        canonical.settings.remote_image_hosts,
        vec![
            "github.com".to_owned(),
            "raw.github.com".to_owned(),
            "raw.githubusercontent.com".to_owned()
        ]
    );
}

#[test]
fn native_validation_and_dtos_match_frontend_wire_without_path_parameters() {
    let fixture = root();
    let store = SettingsStore::load(Some(fixture.path().into()));
    for zoom in [0, 49, 55, 301] {
        assert!(
            store
                .update(0, patch(json!({"pageZoom":zoom})), |_| {})
                .is_err()
        );
    }
    for invalid in [
        json!({"mode":"auto"}),
        json!({"path":"source.md"}),
        json!({"pageZoom":1.5}),
        json!({"darkPalette":"untrusted"}),
        json!({"statusVisible":"yes"}),
        json!({"fileSortKey":"mtime"}),
        json!({"fileSortDirection":"sideways"}),
    ] {
        assert!(serde_json::from_value::<Patch>(invalid).is_err());
    }
    assert_eq!(
        serde_json::to_value(store.get().unwrap()).unwrap(),
        json!({
            "version":1,"revision":0,"settings":{"mode":"system","lightPalette":"githubLight","darkPalette":"githubDark","pageZoom":100,"fitDiagrams":true,"sidebarDefault":true,"statusVisible":true,"fileSortKey":"name","fileSortDirection":"asc",
            "remoteImageHosts":["camo.githubusercontent.com","github.com","raw.githubusercontent.com","user-images.githubusercontent.com"],"navigationDepth":4,"tocVisible":true},"notice":null
        })
    );
    let result = store
        .update(0, patch(json!({"pageZoom":50})), |_| {})
        .unwrap();
    let wire = serde_json::to_value(result).unwrap();
    assert_eq!(wire["status"], "committed");
    assert_eq!(wire["record"]["revision"], 1);
}
#[test]
fn explorer_depth_and_toc_visibility_migrate_per_field_and_reject_out_of_range_depth() {
    let fixture = root();
    let file = fixture.path().join("settings-v1.json");
    // A valid older record without the fields is not corruption.
    let mut legacy = serde_json::to_value(Record {
        version: 1,
        revision: 3,
        settings: SettingsV1::default(),
        notice: None,
    })
    .unwrap();
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("navigationDepth");
    legacy["settings"]
        .as_object_mut()
        .unwrap()
        .remove("tocVisible");
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let old = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(old.revision, 3);
    assert_eq!(old.settings.navigation_depth, NAVIGATION_DEPTH_DEFAULT);
    assert!(old.settings.toc_visible);
    assert!(old.notice.is_none());
    // Invalid present values fall back per field only.
    legacy["settings"]["navigationDepth"] = json!(12);
    legacy["settings"]["tocVisible"] = json!("yes");
    fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let invalid = SettingsStore::load(Some(fixture.path().into()))
        .get()
        .unwrap();
    assert_eq!(invalid.settings.navigation_depth, NAVIGATION_DEPTH_DEFAULT);
    assert!(invalid.settings.toc_visible);
    assert!(invalid.notice.is_some());
    // Out-of-range patches are rejected without partial mutation.
    let store = SettingsStore::load(Some(fixture.path().into()));
    for depth in [0_u8, 9, 255] {
        assert!(
            store
                .update(3, patch(json!({"navigationDepth": depth})), |_| {})
                .is_err()
        );
    }
    assert_eq!(store.get().unwrap().revision, 3);
    let saved = committed(
        store
            .update(
                3,
                patch(json!({"navigationDepth": NAVIGATION_DEPTH_MAX, "tocVisible": false})),
                |_| {},
            )
            .unwrap(),
    );
    assert_eq!(saved.revision, 4);
    assert_eq!(saved.settings.navigation_depth, NAVIGATION_DEPTH_MAX);
    assert!(!saved.settings.toc_visible);
    assert_eq!(
        SettingsStore::load(Some(fixture.path().into()))
            .get()
            .unwrap(),
        saved
    );
}
