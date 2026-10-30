use super::*;
fn read_document(
    path: &Path,
    parent: Option<&Path>,
    id: u32,
    revision: u32,
) -> Result<GrantedDocument, AppError> {
    super::read_document(path, parent, id, revision, &AtomicBool::new(false))
}
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
#[test]
fn cancel_tokens_supersede_reads_and_close_drops_authority() {
    let fixture = Fixture::new();
    let path = fixture.file("source.md", b"unchanged");
    let mut session = Session::default();
    let first = session.begin(1).unwrap();
    let second = session.begin(2).unwrap();
    assert!(first.load(Ordering::Relaxed));
    assert_eq!(
        super::read_document(&path, None, 1, 1, &first)
            .err()
            .unwrap()
            .code,
        "stale"
    );
    assert!(!second.load(Ordering::Relaxed));
    drop(session);
    assert!(second.load(Ordering::Relaxed));
    assert_eq!(fs::read(path).unwrap(), b"unchanged");
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "mdviewerrsx-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("unique fixture directory");
        Self(path)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).expect("fixture source");
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("reap run-owned fixture");
        assert!(!self.0.exists());
    }
}
#[test]
fn aliases_and_literal_formats() {
    for name in ["a.MD", "a.Markdown", "a.mdown", "a.mkd", "a.MKDOWN"] {
        assert_eq!(classify(Path::new(name)).unwrap(), Format::Markdown);
    }
    for name in ["a.TXT", "a.log"] {
        assert_eq!(classify(Path::new(name)).unwrap(), Format::Text);
    }
    for name in ["a.mdx", "a.js", "no-extension"] {
        assert_eq!(classify(Path::new(name)).unwrap_err().code, "unsupported");
    }
}
#[test]
fn strict_reads_and_reload_never_write_sources() {
    let fixture = Fixture::new();
    let bytes = b"\xef\xbb\xbf# Reader\r\n\r\n- [x] Read only\r\n";
    let path = fixture.file("source.md", bytes);
    let first = read_document(&path, None, 1, 1).unwrap();
    let again = read_document(&first.path, Some(&first.parent), 1, 2).unwrap();
    assert_eq!(first.snapshot.source.as_bytes(), bytes);
    assert_eq!(again.snapshot.revision, 2);
    assert_eq!(again.snapshot.location, first.snapshot.location);
    assert_eq!(fs::read(path).unwrap(), bytes);
    let text = fixture.file("plain.log", b"<script>literal</script>\n# plain");
    assert_eq!(
        read_document(&text, None, 2, 3).unwrap().snapshot.format,
        Format::Text
    );
    let empty = fixture.file("empty.md", b"");
    assert!(read_document(&empty, None, 3, 4)
        .unwrap()
        .snapshot
        .source
        .is_empty());
}
#[test]
fn explicit_encoding_type_and_missing_failures() {
    let fixture = Fixture::new();
    let bad = fixture.file("bad.md", &[0xff, 0xfe, 0]);
    let error = read_document(&bad, None, 1, 1).err().unwrap();
    assert_eq!(error.code, "invalidUtf8");
    assert!(error.attempted.unwrap().ends_with("bad.md"));
    assert_eq!(fs::read(bad).unwrap(), [0xff, 0xfe, 0]);
    assert_eq!(
        read_document(&fixture.0.join("missing.md"), None, 1, 1)
            .err()
            .unwrap()
            .code,
        "notFound"
    );
    let directory = fixture.0.join("directory.md");
    fs::create_dir(&directory).unwrap();
    assert_eq!(
        read_document(&directory, None, 1, 1).err().unwrap().code,
        "unsupported"
    );
}
#[test]
fn pending_failure_cancellation_and_supersession_keep_last_good_identity() {
    let fixture = Fixture::new();
    let path = fixture.file("good.md", b"# Last good");
    let mut session = Session::default();
    session.begin(1).unwrap();
    session
        .stage(1, read_document(&path, None, 1, 1).unwrap())
        .unwrap();
    session.commit(1).unwrap();
    session.begin(2).unwrap();
    let candidate = read_document(&path, None, 2, 2).unwrap();
    session.begin(3).unwrap();
    assert_eq!(session.stage(2, candidate).unwrap_err().code, "stale");
    session.cancel(3);
    assert_eq!(session.commit(3).unwrap_err().code, "stale");
    assert!(session.active(1, 1).is_ok());
    assert!(session.active(2, 2).is_err());
    session.begin(4).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(read_document(&path, Some(&fixture.0), 1, 4).is_err());
    assert!(session.active(1, 1).is_ok());
    assert!(session.begin(4).is_err());
}
#[cfg(unix)]
#[test]
fn canonical_component_checks_reject_symlink_escape_and_prefix_lookalikes() {
    let fixture = Fixture::new();
    let root = fixture.0.join("root");
    let lookalike = fixture.0.join("root-extra");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&lookalike).unwrap();
    let path = root.join("source.md");
    fs::write(&path, "original").unwrap();
    let granted = read_document(&path, None, 1, 1).unwrap();
    let outside = lookalike.join("outside.md");
    fs::write(&outside, "outside").unwrap();
    assert_eq!(
        read_document(&outside, Some(&granted.parent), 1, 2)
            .err()
            .unwrap()
            .code,
        "denied"
    );
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert_eq!(
        read_document(&path, Some(&granted.parent), 1, 2)
            .err()
            .unwrap()
            .code,
        "denied"
    );
    assert_eq!(fs::read(outside).unwrap(), b"outside");
}

#[cfg(windows)]
#[test]
fn windows_canonical_grant_reloads_without_changing_source_bytes() {
    use std::path::{Component, Prefix};
    let fixture = Fixture::new();
    let bytes = b"\xef\xbb\xbf# Windows reader\r\n";
    let path = fixture.file("source.md", bytes);
    let mut session = Session::default();
    session.begin(1).unwrap();
    let selected = read_document(&path, None, 1, 1).unwrap();
    assert!(matches!(
        selected.path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))
    ));
    session.stage(1, selected).unwrap();
    session.commit(1).unwrap();
    let granted = session.active(1, 1).unwrap();
    let reloaded = read_document(&granted.path, Some(&granted.parent), 1, 2).unwrap();
    assert_eq!(reloaded.snapshot.source.as_bytes(), bytes);
    assert_eq!(reloaded.snapshot.revision, 2);
    assert_eq!(reloaded.path, granted.path);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn windows_validator_accepts_drive_and_unc_canonical_forms() {
    for path in [
        String::from(r"C:\docs\reading.md"),
        [r"\\", r"?\C:\docs\reading.md"].concat(),
        [r"\\", r"fixture-host\fixture-share\reading.md"].concat(),
        [r"\\", r"?\UNC\fixture-host\fixture-share\reading.md"].concat(),
    ] {
        validate_windows_path(Path::new(&path)).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn windows_validator_rejects_devices_and_streams_without_opening_them() {
    for path in [
        [r"\\", r".\PhysicalDrive0"].concat(),
        [r"\\", r"?\GLOBALROOT\Device\HarddiskVolume1\reading.md"].concat(),
        String::from("//./COM1"),
        String::from(r"C:\docs\reading.md:payload"),
        [r"\\", r"?\C:\docs\reading.md:payload"].concat(),
        [r"\\", r"fixture-host\fixture-share\reading.md:payload"].concat(),
        [
            r"\\",
            r"?\UNC\fixture-host\fixture-share\reading.md:payload",
        ]
        .concat(),
        [r"\\", r"fixture-host\fixture-share:payload\reading.md"].concat(),
    ] {
        assert_eq!(
            validate_windows_path(Path::new(&path)).unwrap_err().code,
            "denied"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_reads_still_reject_streams_and_component_prefix_escape() {
    let fixture = Fixture::new();
    let root = fixture.0.join("root");
    let lookalike = fixture.0.join("root-extra");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&lookalike).unwrap();
    let path = fixture.file("root/source.md", b"unchanged");
    let selected = read_document(&path, None, 1, 1).unwrap();
    let outside = fixture.file("root-extra/outside.md", b"outside");
    assert_eq!(
        read_document(&outside, Some(&selected.parent), 1, 2)
            .err()
            .unwrap()
            .code,
        "denied"
    );
    for base in [&path, &selected.path] {
        let mut stream = base.as_os_str().to_os_string();
        stream.push(":payload");
        let error = read_document(Path::new(&stream), None, 1, 2).err().unwrap();
        assert_eq!(error.code, "denied");
        assert_eq!(
            error.message,
            "Device paths and alternate data streams are not supported."
        );
    }
    assert_eq!(fs::read(path).unwrap(), b"unchanged");
    assert_eq!(fs::read(outside).unwrap(), b"outside");
}
