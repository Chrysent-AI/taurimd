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
            "taurimd-test-{}-{}",
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
    assert!(
        read_document(&empty, None, 3, 4)
            .unwrap()
            .snapshot
            .source
            .is_empty()
    );
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

#[test]
fn verbatim_prefixes_normalize_to_plain_display_forms() {
    // Drive form: exactly the verbatim prefix is stripped.
    assert_eq!(strip_verbatim_prefix(r"\\?\C:\dir\a.md"), r"C:\dir\a.md");
    // UNC form converts to the plain server-share spelling.
    assert_eq!(
        strip_verbatim_prefix(r"\\?\UNC\server\share\dir\a.md"), // gitleaks:allow
        r"\\server\share\dir\a.md"                               // gitleaks:allow
    );
    // Minimal roots: no component is invented or dropped.
    assert_eq!(strip_verbatim_prefix(r"\\?\C:\"), r"C:\");
    assert_eq!(
        strip_verbatim_prefix(r"\\?\UNC\server\share"), // gitleaks:allow
        r"\\server\share"                               // gitleaks:allow
    );
    // Non-verbatim paths pass through untouched, whatever their spelling.
    for passthrough in [r"C:\dir\a.md", r"\\server\share\a.md", "/srv/data/a.md"] {
        // gitleaks:allow
        assert_eq!(strip_verbatim_prefix(passthrough), passthrough);
    }
}

#[test]
fn verbatim_normalization_is_prefix_only_and_preserves_long_paths() {
    // A path past the 260-character limit: stripping moves the prefix and
    // never truncates or rewrites components — the documented strip-always
    // trade-off keeps deep trees intact as plain paths.
    let deep = format!(r"C:\deep\{}end.md", "component-".repeat(40));
    assert!(deep.chars().count() > 260);
    assert_eq!(
        strip_verbatim_prefix(&format!(r"\\?\{deep}")),
        deep.as_str()
    );
    // Canonicalize's verbatim form carries raw component spellings (trailing
    // spaces and dots are legal there); the body must survive byte for byte.
    assert_eq!(
        strip_verbatim_prefix(r"\\?\C:\dir \trailing."),
        r"C:\dir \trailing."
    );
    // An interior UNC-looking name is not re-interpreted: only a real
    // verbatim prefix converts.
    assert_eq!(
        strip_verbatim_prefix(r"\\?\C:\UNC\share\a.md"),
        r"C:\UNC\share\a.md"
    );
}

#[test]
fn normalized_canonical_paths_keep_relative_derivation_working() {
    // Round-trip sanity: after normalization, join/strip_prefix still yield
    // clean scope relatives — the seam every tree row and issue path uses.
    let root = normalize_canonical(PathBuf::from(r"\\?\C:\scope"));
    let entry = root.join("nested").join("a.md");
    let relative = entry.strip_prefix(&root).unwrap();
    let components: Vec<_> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    assert_eq!(components, ["nested", "a.md"]);
    // The text form carries no verbatim prefix anywhere it may display.
    assert!(!entry.to_string_lossy().contains(r"\\?\"));
}

#[test]
fn verbatim_component_rebuild_yields_plain_prefix_forms() {
    // The lone-surrogate input class has no exact text form, so its repair
    // is exercised at the component seam the rebuild runs: prefix respelling
    // plus the shared join (the cfg(windows) test below drives the real
    // WTF-16 path end-to-end). The component tail is built with the native
    // root separator so both platforms parse the same RootDir-led stream a
    // verbatim path yields after its prefix.
    let tail = PathBuf::from(std::path::MAIN_SEPARATOR_STR)
        .join("dir")
        .join("f.md");
    let separator = std::path::MAIN_SEPARATOR_STR;
    // Expected forms are spelled byte-exact rather than assembled with
    // PathBuf::join: joining a bare root replaces the base on Unix, which is
    // not the invariant under test. The invariant is prefix respelling plus
    // native-separator component joining.
    assert_eq!(
        rebuild_from_prefix(Prefix::VerbatimDisk(b'C'), tail.components()).unwrap(),
        PathBuf::from(format!("C:{separator}dir{separator}f.md"))
    );
    assert_eq!(
        rebuild_from_prefix(
            Prefix::VerbatimUNC(
                std::ffi::OsStr::new("server"),
                std::ffi::OsStr::new("share")
            ),
            tail.components(),
        )
        .unwrap(),
        PathBuf::from(format!(r"\\server\\share{separator}dir{separator}f.md")) // gitleaks:allow
    );
    // Unrecognized prefix kinds yield no plain spelling: the rebuild falls
    // back to the caller's byte-preserving passthrough.
    for kind in [
        Prefix::Disk(b'C'),
        Prefix::UNC(
            std::ffi::OsStr::new("server"),
            std::ffi::OsStr::new("share"),
        ),
        Prefix::DeviceNS(std::ffi::OsStr::new("C:")),
        Prefix::Verbatim(std::ffi::OsStr::new("C:")),
    ] {
        assert!(plain_prefix(kind).is_none());
    }
}

#[cfg(windows)]
#[test]
fn windows_non_utf16_verbatim_paths_rebuild_the_plain_form() {
    use std::{
        ffi::OsStr,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    // A verbatim path whose text loss is one lone surrogate (U+D800) in an
    // interior component: to_str() is None, so normalization must reach the
    // component seam and still yield the plain drive-letter form.
    let surrogate_name = std::ffi::OsString::from_wide(&[0xD800, 0x006E, 0x0061, 0x006D, 0x0065]);
    let mut wide: Vec<u16> = OsStr::new(r"\\?\C:\scope\").encode_wide().collect();
    wide.extend(surrogate_name.encode_wide());
    wide.extend(OsStr::new(r"\\a.md").encode_wide());
    let path = PathBuf::from(std::ffi::OsString::from_wide(&wide));
    assert!(path.to_str().is_none());
    let normalized = normalize_canonical(path);
    assert_eq!(
        normalized,
        Path::new(r"C:\scope").join(&surrogate_name).join("a.md")
    );
    // Containment derivation against the plain scope root keeps working.
    assert_eq!(
        normalized
            .strip_prefix(r"C:\scope")
            .unwrap()
            .components()
            .count(),
        2
    );
    // An already-plain non-UTF16 canonical path keeps its bytes.
    let plain_wide: Vec<u16> = OsStr::new(r"C:\scope\")
        .encode_wide()
        .chain(surrogate_name.encode_wide())
        .chain(OsStr::new(r"\a.md").encode_wide())
        .collect();
    let plain = PathBuf::from(std::ffi::OsString::from_wide(&plain_wide));
    assert_eq!(normalize_canonical(plain.clone()), plain);
}

#[cfg(unix)]
#[test]
fn unix_non_utf8_canonical_paths_keep_their_bytes() {
    use std::os::unix::ffi::OsStringExt;
    // No verbatim prefix exists off Windows: the component seam is a
    // byte-preserving passthrough for the no-exact-text-form input class.
    let path = PathBuf::from(std::ffi::OsString::from_vec(
        b"/scope/na\xc3\xafve-\xff.md".to_vec(),
    ));
    assert!(path.to_str().is_none());
    assert_eq!(normalize_canonical(path.clone()), path);
}
