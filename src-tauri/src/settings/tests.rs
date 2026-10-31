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
    assert!(store
        .update(1, patch(json!({"pageZoom":200})), |_| panic!(
            "no failure event"
        ))
        .is_err());
    assert_eq!(store.get().unwrap(), saved);
    assert_eq!(SettingsStore::load(Some(backup)).get().unwrap(), saved);
    assert_eq!(fs::read_dir(&config).unwrap().count(), 1);
    assert!(config.join("settings-v1.json").is_dir());
    assert!(SettingsStore::load(None)
        .update(0, Patch::default(), |_| {})
        .is_err());
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
fn native_validation_and_dtos_match_frontend_wire_without_path_parameters() {
    let fixture = root();
    let store = SettingsStore::load(Some(fixture.path().into()));
    for zoom in [0, 49, 55, 301] {
        assert!(store
            .update(0, patch(json!({"pageZoom":zoom})), |_| {})
            .is_err());
    }
    for invalid in [
        json!({"mode":"auto"}),
        json!({"path":"source.md"}),
        json!({"pageZoom":1.5}),
        json!({"darkPalette":"untrusted"}),
        json!({"statusVisible":"yes"}),
    ] {
        assert!(serde_json::from_value::<Patch>(invalid).is_err());
    }
    assert_eq!(
        serde_json::to_value(store.get().unwrap()).unwrap(),
        json!({
            "version":1,"revision":0,"settings":{"mode":"system","lightPalette":"githubLight","darkPalette":"githubDark","pageZoom":100,"fitDiagrams":true,"sidebarDefault":true,"statusVisible":true},"notice":null
        })
    );
    let result = store
        .update(0, patch(json!({"pageZoom":50})), |_| {})
        .unwrap();
    let wire = serde_json::to_value(result).unwrap();
    assert_eq!(wire["status"], "committed");
    assert_eq!(wire["record"]["revision"], 1);
}
