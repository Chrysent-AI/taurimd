use super::*;
use crate::documents::read_document;
use tauri::http::header::HeaderValue;

fn serve(state: &Mutex<Session>, caller: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    super::serve(state, caller, request, std::convert::identity)
}
struct TestDir(Option<tempfile::TempDir>);
impl TestDir {
    fn new() -> Self {
        Self(Some(tempfile::tempdir().unwrap()))
    }
    fn path(&self) -> &std::path::Path {
        self.0.as_ref().unwrap().path()
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let root = self.0.take().unwrap();
        let path = root.path().to_owned();
        root.close().expect("reap owned media fixture");
        assert!(!path.exists());
    }
}
fn fixture() -> (TestDir, Mutex<Session>, String) {
    let root = TestDir::new();
    std::fs::write(root.path().join("read.md"), "# Read only").unwrap();
    std::fs::write(root.path().join("sound.wav"), b"0123456789").unwrap();
    let mut session = Session::default();
    let cancel = session.begin(1).unwrap();
    let document = read_document(&root.path().join("read.md"), None, 1, 1, &cancel).unwrap();
    session.stage(1, document).unwrap();
    session.commit(1).unwrap();
    let grant = resolve(scope(&session, "reader", 1, 1).unwrap(), "sound.wav").unwrap();
    let resolved = insert(&mut session, grant).unwrap();
    (root, Mutex::new(session), resolved.id)
}
fn request(id: &str, method: &str, range: Option<&str>) -> Request<Vec<u8>> {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("reader-media://localhost/{id}"));
    if let Some(range) = range {
        request = request.header("Range", range);
    }
    request.body(Vec::new()).unwrap()
}
#[test]
fn registered_handler_helper_serves_exact_full_head_and_single_ranges_without_source_writes() {
    let (root, session, id) = fixture();
    let cases = [
        (None, 200, "0123456789", None),
        (Some("bytes=2-4"), 206, "234", Some("bytes 2-4/10")),
        (Some("bytes=7-"), 206, "789", Some("bytes 7-9/10")),
        (Some("bytes=-3"), 206, "789", Some("bytes 7-9/10")),
        (Some("bytes=7-99"), 206, "789", Some("bytes 7-9/10")),
        (Some("bytes=-99"), 206, "0123456789", Some("bytes 0-9/10")),
    ];
    for (range, status, bytes, content_range) in cases {
        let result = serve(&session, "reader", request(&id, "GET", range));
        assert_eq!(result.status().as_u16(), status);
        assert_eq!(result.body(), bytes.as_bytes());
        assert_eq!(result.headers()["Content-Length"], bytes.len().to_string());
        assert_eq!(
            result
                .headers()
                .get("Content-Range")
                .map(|v| v.to_str().unwrap()),
            content_range
        );
        assert_eq!(result.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(result.headers()["Cache-Control"], "no-store");
        assert_eq!(result.headers()["Accept-Ranges"], "bytes");
        assert_eq!(result.headers()["Content-Type"], "audio/wav");
        assert_eq!(
            result.headers()["Content-Security-Policy"],
            "default-src 'none'; sandbox"
        );
    }
    let head = serve(
        &session,
        "reader",
        request(&id, "HEAD", Some("not-a-range")),
    );
    assert_eq!(head.status(), 200);
    assert!(head.body().is_empty());
    assert_eq!(head.headers()["Content-Length"], "10");
    assert!(!head.headers().contains_key("Content-Range"));
    let mut conditional = request(&id, "GET", Some("bytes=0-1"));
    conditional
        .headers_mut()
        .insert("If-Range", HeaderValue::from_static("unproven"));
    assert_eq!(serve(&session, "reader", conditional).status(), 200);
    assert_eq!(
        std::fs::read(root.path().join("sound.wav")).unwrap(),
        b"0123456789"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("read.md")).unwrap(),
        "# Read only"
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
}
#[test]
fn method_actor_route_and_range_error_matrix_is_fail_closed() {
    let (_root, session, id) = fixture();
    for caller in ["", "other"] {
        assert_eq!(
            serve(&session, caller, request(&id, "GET", None)).status(),
            403
        );
    }
    let mut forged = request(&id, "GET", None);
    forged
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("tauri://localhost"));
    forged
        .headers_mut()
        .insert("Referer", HeaderValue::from_static("tauri://localhost/"));
    assert_eq!(serve(&session, "other", forged).status(), 403);
    for uri in [
        format!("reader-media://wrong/{id}"),
        format!("http://reader-media.localhost/{id}"),
        format!("reader-media://localhost:80/{id}"),
    ] {
        let invalid = Request::builder().uri(uri).body(Vec::new()).unwrap();
        assert_eq!(serve(&session, "reader", invalid).status(), 404);
    }
    for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
        let result = serve(&session, "reader", request(&id, method, None));
        assert_eq!(result.status(), 405);
        assert_eq!(result.headers()["Allow"], "GET, HEAD");
    }
    for route in [
        format!("{id}/extra"),
        format!("{id}?path=sound.wav"),
        "sound.wav".into(),
        "f".repeat(32),
        "A".repeat(32),
    ] {
        assert_eq!(
            serve(&session, "reader", request(&route, "GET", None)).status(),
            404
        );
    }
    for range in [
        "bytes=",
        "bytes=-",
        "bytes=0-1,3-4",
        "items=0-1",
        "bytes=+1-2",
        "bytes=0--1",
        "bytes= 0-1",
        "bytes=18446744073709551616-",
        "bytes=0-18446744073709551616",
    ] {
        assert_eq!(
            serve(&session, "reader", request(&id, "GET", Some(range))).status(),
            400,
            "{range}"
        );
    }
    for range in ["bytes=10-", "bytes=3-2", "bytes=-0"] {
        let result = serve(&session, "reader", request(&id, "GET", Some(range)));
        assert_eq!(result.status(), 416, "{range}");
        assert_eq!(result.headers()["Content-Range"], "bytes */10");
    }
    let mut repeated = request(&id, "GET", Some("bytes=0-1"));
    repeated
        .headers_mut()
        .append("Range", HeaderValue::from_static("bytes=2-3"));
    assert_eq!(serve(&session, "reader", repeated).status(), 400);
}
#[test]
fn active_media_survives_pending_failure_cancel_but_commit_and_drop_revoke_late_work() {
    let (root, session, id) = fixture();
    let old_scope = scope(&session.lock().unwrap(), "reader", 1, 1).unwrap();
    let late = resolve(old_scope.clone(), "sound.wav").unwrap();
    let response_before_revoke = representation(&request(&id, "GET", None), &late).unwrap();
    {
        let mut session = session.lock().unwrap();
        let cancel = session.begin(2).unwrap();
        assert!(read_document(&root.path().join("missing.md"), None, 2, 2, &cancel).is_err());
        session.cancel(2);
        assert!(scope(&session, "", 1, 1).is_err());
        assert!(scope(&session, "reader", 999, 1).is_err());
    }
    assert_eq!(
        serve(&session, "reader", request(&id, "GET", None)).status(),
        200
    );
    {
        let mut session = session.lock().unwrap();
        let cancel = session.begin(3).unwrap();
        let document = read_document(&root.path().join("read.md"), None, 1, 3, &cancel).unwrap();
        session.stage(3, document).unwrap();
    }
    assert_eq!(
        serve(&session, "reader", request(&id, "HEAD", None)).status(),
        200
    );
    {
        let mut session = session.lock().unwrap();
        session.commit(3).unwrap();
        assert_eq!(publish(&late, Ok(response_before_revoke)).status(), 410);
        assert!(insert(&mut session, late).is_err());
        assert!(session.media.is_empty());
    }
    assert!(old_scope.live().is_err());
    assert_eq!(
        serve(&session, "reader", request(&id, "GET", None)).status(),
        404
    );
    let new_scope = scope(&session.lock().unwrap(), "reader", 1, 3).unwrap();
    drop(session);
    assert!(new_scope.live().is_err());
}
#[test]
fn checked_reads_never_report_short_read_as_success_and_empty_ranges_are_unsatisfiable() {
    assert!(read_body(&mut std::io::Cursor::new(b"123"), 1, 3).is_err());
    assert!(read_body(&mut std::io::Cursor::new(b"123"), 0, u64::MAX).is_err());
    assert_eq!(
        read_body(&mut std::io::Cursor::new(b"123"), 1, 2).unwrap(),
        b"23"
    );
    assert_eq!(
        selected_range("bytes=0-", 0),
        Err(RangeError::Unsatisfiable)
    );
    assert_eq!(
        selected_range("bytes=-1", 0),
        Err(RangeError::Unsatisfiable)
    );
    let (root, session, id) = fixture();
    std::fs::write(root.path().join("sound.wav"), []).unwrap();
    assert_eq!(
        serve(&session, "reader", request(&id, "GET", None))
            .body()
            .len(),
        0
    );
    assert_eq!(
        serve(&session, "reader", request(&id, "GET", Some("bytes=0-"))).status(),
        416
    );
    std::fs::remove_file(root.path().join("sound.wav")).unwrap();
    assert_eq!(
        serve(&session, "reader", request(&id, "GET", None)).status(),
        404
    );
}
#[test]
fn scoped_references_decode_once_and_reject_escape_prefixes_schemes_and_non_media() {
    let (root, session, _) = fixture();
    std::fs::write(root.path().join("percent%2e.wav"), b"bytes").unwrap();
    let granted = scope(&session.lock().unwrap(), "reader", 1, 1).unwrap();
    assert!(resolve(granted.clone(), "percent%252e.wav?ignored#fragment").is_ok());
    for reference in [
        "https://invalid.example/a.wav",
        "//invalid.example/a.wav",
        "file:///sound.wav",
        "data:audio/wav,x",
        "blob:invalid",
        "../escape.wav",
        "%2e%2e/escape.wav",
        "sound.wav%00",
        "\\server\\share",
        "read.md",
        ".",
    ] {
        assert!(resolve(granted.clone(), reference).is_err(), "{reference}");
    }
    #[cfg(unix)]
    {
        let outside = TestDir::new();
        std::fs::write(outside.path().join("outside.wav"), b"no").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.wav"),
            root.path().join("escape.wav"),
        )
        .unwrap();
        assert!(resolve(granted.clone(), "escape.wav").is_err());
        assert!(
            contained_file(&outside.path().join("outside.wav"), Some(&granted.parent)).is_err()
        );
    }
    let narrow = root.path().join("scope");
    let lookalike = root.path().join("scope-extra");
    std::fs::create_dir(&narrow).unwrap();
    std::fs::create_dir(&lookalike).unwrap();
    std::fs::write(lookalike.join("outside.wav"), b"outside").unwrap();
    assert_eq!(
        contained_file(
            &lookalike.join("outside.wav"),
            Some(&std::fs::canonicalize(&narrow).unwrap())
        )
        .unwrap_err()
        .code,
        "denied"
    );
    assert!(mime(std::path::Path::new("script.js")).is_none());
    assert_eq!(
        mime(std::path::Path::new("picture.SVG")),
        Some("image/svg+xml")
    );
}
#[cfg(windows)]
#[test]
fn media_url_conversion_retains_windows_stream_device_drive_and_unc_denials() {
    let (_root, session, _) = fixture();
    let grant = scope(&session.lock().unwrap(), "reader", 1, 1).unwrap();
    for reference in [
        "sound.wav%3Apayload",
        "C:/sound.wav",
        "//remote.invalid/share/sound.wav",
        "//./COM1",
        "%5c%5c.%5cCOM1",
    ] {
        assert!(resolve(grant.clone(), reference).is_err(), "{reference}");
    }
}
#[test]
fn native_link_policy_reparses_before_mocked_only_os_side_effect() {
    let (_root, session, _) = fixture();
    let granted = session.lock().unwrap().active(1, 1).unwrap();
    for href in [
        "https://example.invalid/path?q=value#fragment",
        "http://example.invalid/",
        "mailto:reader@example.invalid",
        "tel:+123456",
    ] {
        let links::Destination::External(url) = links::destination(&granted.parent, href).unwrap()
        else {
            panic!("external expected");
        };
        let mut called = false;
        links::open_external(url, |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(called);
    }
    for href in [
        "javascript:evil()",
        "file:///read.md",
        "data:text/html,evil",
        "ftp://example.invalid",
        "https://user:password@example.invalid",
        "mailto:",
        "tel:nobody",
        "mailto:reader@example.invalid?subject=%0d%0aInjected",
        "https:///example.invalid",
        "https://example.invalid/%7f",
        "tel:",
        " https://example.invalid",
        "https://example.invalid/\n",
    ] {
        assert!(links::destination(&granted.parent, href).is_err(), "{href}");
    }
    assert!(matches!(
        links::destination(&granted.parent, "#heading").unwrap(),
        links::Destination::Fragment(_)
    ));
    assert!(matches!(
        links::destination(&granted.parent, "read.md#heading").unwrap(),
        links::Destination::Document(_, _)
    ));
}
