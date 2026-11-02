use super::*;
use std::time::Duration;

fn hosts(list: &[&str]) -> Vec<String> {
    list.iter().map(|host| (*host).to_owned()).collect()
}

#[test]
fn host_entries_normalize_to_one_canonical_identity() {
    assert_eq!(canonical_host("github.com").unwrap(), "github.com");
    assert_eq!(canonical_host("  GitHub.COM  ").unwrap(), "github.com");
    assert_eq!(
        canonical_host("bücher.example").unwrap(),
        "xn--bcher-kva.example"
    );
    // A single DNS label is an explicit choice and is permitted.
    assert_eq!(canonical_host("localhost").unwrap(), "localhost");
    assert!(canonical_host("").is_err());
    assert!(canonical_host("   ").is_err());
    assert!(canonical_host("github.com.").is_err());
    assert!(canonical_host(".github.com").is_err());
    assert!(canonical_host("git..hub.com").is_err());
    assert!(canonical_host("https://github.com").is_err());
    assert!(canonical_host("github.com:443").is_err());
    assert!(canonical_host("github.com/path").is_err());
    assert!(canonical_host("*.github.com").is_err());
    assert!(canonical_host("user@github.com").is_err());
    assert!(canonical_host("github%2ecom").is_err());
    assert!(canonical_host("git hub.com").is_err());
    assert!(canonical_host("github.com\\evil").is_err());
    assert!(canonical_host("github\u{3002}com").is_err());
    assert!(canonical_host("github\u{ff0e}com").is_err());
    assert!(canonical_host("github\u{ff61}com").is_err());
    // Numeric addresses and numeric address disguises are never domains.
    assert!(canonical_host("127.0.0.1").is_err());
    assert!(canonical_host("0x7f.1").is_err());
    assert!(canonical_host("[::1]").is_err());
    assert!(canonical_host("under_score.example").is_err());
    assert!(canonical_host(&"a".repeat(64)).is_err());
}

#[test]
fn host_lists_canonicalize_deduplicate_and_sort() {
    let list = hosts(&[
        "Raw.githubusercontent.com",
        "github.com",
        "raw.githubusercontent.com",
    ]);
    let canonical = canonical_host_list(&list).unwrap();
    assert_eq!(
        canonical,
        hosts(&["github.com", "raw.githubusercontent.com"])
    );
    // A deliberately empty list stays empty and authorizes nothing.
    assert!(canonical_host_list(&[]).unwrap().is_empty());
    assert!(canonical_host_list(&hosts(&["https://github.com"])).is_err());
}

#[test]
fn permission_is_an_exact_host_identity() {
    let policy = Policy::new(&hosts(&["github.com"]));
    assert!(policy.authorize("github.com").is_some());
    for denied in [
        "sub.github.com",
        "github.com.example",
        "github.co",
        "github.com.",
        "github.comm",
        "notgithub.com",
        "GITHUB.COM.",
        "xn--github-2of.com",
    ] {
        assert!(
            policy.authorize(denied).is_none(),
            "{denied} must not be permitted by github.com"
        );
    }
    assert_eq!(policy.guard().hosts(), hosts(&["github.com"]));
}

#[test]
fn removal_revokes_permanently_and_reinclusion_creates_a_new_lease() {
    let policy = Policy::new(&hosts(&["github.com", "raw.githubusercontent.com"]));
    let first = policy.authorize("github.com").unwrap();
    let mut committed = policy.guard();
    committed.replace_hosts(&hosts(&["raw.githubusercontent.com"]));
    assert!(!first.live());
    // The committed guard is released before the policy is consulted again:
    // the committed guard is not re-entrant.
    drop(committed);
    assert!(policy.authorize("github.com").is_none());
    let second = Policy::new(&hosts(&["github.com"]))
        .authorize("github.com")
        .unwrap();
    // A re-added host receives a different lease identity, so an old result
    // can never be reused as newly authorized work.
    assert!(!Arc::ptr_eq(&first, &second));
}

#[test]
fn a_removal_between_authorization_and_registration_cancels_the_job() {
    let policy = Policy::new(&hosts(&["github.com"]));
    let lease = policy.authorize("github.com").unwrap();
    let signal = JobSignal::new();
    // The host is removed after the authorization but before the pending
    // work is registered. The job must still be cancelled.
    {
        let mut committed = policy.guard();
        committed.replace_hosts(&[]);
    }
    lease.register(&signal);
    assert!(signal.cancelled());
    assert!(!lease.live());
}

#[test]
fn a_revoked_lease_stops_the_request_before_it_is_issued() {
    tauri::async_runtime::block_on(async {
        let policy = Policy::new(&hosts(&["github.com"]));
        let lease = policy.authorize("github.com").unwrap();
        let target = parse_image_url("https://github.com/a/b.png").unwrap();
        let signal = JobSignal::new();
        {
            let mut committed = policy.guard();
            committed.replace_hosts(&[]);
        }
        let outcome = fetch(&policy, &target, lease, signal).await;
        let error = match outcome {
            Ok(_) => panic!("a revoked lease must stop the request"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "blockedHost");
    });
}

#[test]
fn removing_a_host_cancels_its_pending_work() {
    let policy = Policy::new(&hosts(&["github.com"]));
    let lease = policy.authorize("github.com").unwrap();
    let signal = JobSignal::new();
    lease.register(&signal);
    assert!(!signal.cancelled());
    let mut committed = policy.guard();
    committed.replace_hosts(&[]);
    assert!(signal.cancelled());
    assert!(!lease.live());
}

#[test]
fn image_targets_follow_the_scheme_credential_and_port_contract() {
    let target = parse_image_url("https://raw.githubusercontent.com/a/b.png?x=1#frag").unwrap();
    assert_eq!(target.host, "raw.githubusercontent.com");
    assert_eq!(
        target.url.as_str(),
        "https://raw.githubusercontent.com/a/b.png?x=1"
    );
    assert_eq!(
        parse_image_url("https://example.com:443/i.png")
            .unwrap()
            .host,
        "example.com"
    );
    for denied in [
        "http://example.com/i.png",
        "//example.com/i.png",
        "https://user@example.com/i.png",
        "https://user:pass@example.com/i.png",
        "https://@example.com/i.png",
        "https://example.com:8443/i.png",
        "https://example.com:/i.png",
        "https://example.com:0443/i.png",
        "https://example.com%2e/i.png",
        " https://example.com/i.png",
        "https://example.com\\i.png",
        "https://127.0.0.1/i.png",
        "https://[::1]/i.png",
        "example.com/i.png",
    ] {
        assert!(
            parse_image_url(denied).is_err(),
            "{denied} must not be accepted"
        );
    }
}

#[test]
fn redirect_destinations_are_validated_before_they_are_requested() {
    let base = Url::parse("https://github.com/a/b.png").unwrap();
    // A relative same-host redirect keeps the host.
    let relative = resolve_redirect(&base, "../c.png").unwrap();
    assert_eq!(validate_parsed(&relative).unwrap(), "github.com");
    // A cross-host redirect is resolved but is only admitted when the policy
    // permits its own host.
    let policy = Policy::new(&hosts(&["github.com"]));
    let escaped = resolve_redirect(&base, "https://raw.githubusercontent.com/x.png").unwrap();
    let escaped_host = validate_parsed(&escaped).unwrap();
    assert!(policy.authorize(&escaped_host).is_none());
    // A protocol-relative redirect is validated against the raw authority.
    let protocol_relative = resolve_redirect(&base, "//raw.githubusercontent.com/x.png").unwrap();
    assert_eq!(
        validate_parsed(&protocol_relative).unwrap(),
        "raw.githubusercontent.com"
    );
    for denied in [
        "http://raw.githubusercontent.com/x.png",
        "https://user@raw.githubusercontent.com/x.png",
        "https://raw.githubusercontent.com:8443/x.png",
        "https://raw.githubusercontent.com%2e/x.png",
        "https://[::1]/x.png",
        "",
    ] {
        assert!(
            resolve_redirect(&base, denied).is_err(),
            "{denied} must not be admitted as a redirect"
        );
    }
}

#[test]
fn the_redirect_chain_enforces_the_hop_bound_and_repeats() {
    let start = Url::parse("https://github.com/a").unwrap();
    let mut chain = RedirectChain::new(&start);
    for index in 1..=MAX_REDIRECTS {
        let next = Url::parse(&format!("https://github.com/{index}")).unwrap();
        chain.admit(&next).unwrap();
    }
    let beyond = Url::parse("https://github.com/too-far").unwrap();
    assert_eq!(
        chain.admit(&beyond).unwrap_err().kind,
        RemoteErrorKind::RedirectLimit
    );
    let mut repeated = RedirectChain::new(&start);
    assert!(repeated.admit(&start).is_err());
}

#[test]
fn only_one_well_formed_image_content_type_is_accepted() {
    let mut headers = reqwest::header::HeaderMap::new();
    assert!(image_mime(&headers).is_err());
    headers.insert(reqwest::header::CONTENT_TYPE, "image/png".parse().unwrap());
    assert_eq!(image_mime(&headers).unwrap(), "image/png");
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "image/png; charset=binary".parse().unwrap(),
    );
    assert_eq!(image_mime(&headers).unwrap(), "image/png");
    headers.insert(reqwest::header::CONTENT_TYPE, "text/html".parse().unwrap());
    assert!(image_mime(&headers).is_err());
    let mut ambiguous = reqwest::header::HeaderMap::new();
    ambiguous.append(reqwest::header::CONTENT_TYPE, "image/png".parse().unwrap());
    ambiguous.append(reqwest::header::CONTENT_TYPE, "image/gif".parse().unwrap());
    assert!(image_mime(&ambiguous).is_err());
}

#[test]
fn compressed_bodies_are_refused() {
    let mut headers = reqwest::header::HeaderMap::new();
    assert!(check_encoding(&headers).is_ok());
    headers.insert(
        reqwest::header::CONTENT_ENCODING,
        "identity".parse().unwrap(),
    );
    assert!(check_encoding(&headers).is_ok());
    headers.insert(reqwest::header::CONTENT_ENCODING, "gzip".parse().unwrap());
    assert!(check_encoding(&headers).is_err());
    headers.insert(reqwest::header::CONTENT_ENCODING, "br".parse().unwrap());
    assert!(check_encoding(&headers).is_err());
}

#[test]
fn the_budget_accounting_is_bounded() {
    assert!(body_limit(MAX_BODY_BYTES).is_ok());
    assert!(body_limit(MAX_BODY_BYTES + 1).is_err());
    assert_eq!(operations().available_permits(), MAX_ACTIVE_OPERATIONS);
    assert_eq!(retained().available_permits(), MAX_RETAINED_BYTES);
    // The retained-byte budget cannot be exceeded by a single acquisition.
    assert!(
        retained()
            .clone()
            .try_acquire_many_owned(u32::try_from(MAX_RETAINED_BYTES + 1).unwrap())
            .is_err()
    );
}

#[test]
fn image_envelopes_must_match_the_declared_family() {
    assert!(envelope_matches(
        "image/png",
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]
    ));
    assert!(!envelope_matches("image/png", b"GIF89a....."));
    assert!(envelope_matches("image/jpeg", &[0xff, 0xd8, 0xff, 0xe0]));
    assert!(envelope_matches("image/gif", b"GIF89a....."));
    assert!(!envelope_matches("image/gif", b"GIF88a....."));
    assert!(envelope_matches("image/webp", b"RIFF\0\0\0\0WEBP"));
    assert!(!envelope_matches("image/webp", b"RIFF\0\0\0\0WAVE"));
    assert!(envelope_matches("image/avif", b"\0\0\0\x20ftypavif"));
    assert!(!envelope_matches("image/avif", b"\0\0\0\x20ftypisom"));
    assert!(envelope_matches(
        "image/svg+xml",
        br#"<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#
    ));
    assert!(envelope_matches(
        "image/svg+xml",
        "\u{feff}<svg xmlns=\"http://www.w3.org/2000/svg\"/>".as_bytes()
    ));
    assert!(!envelope_matches("image/svg+xml", b"<html><body/></html>"));
    assert!(!envelope_matches(
        "image/svg+xml",
        b"<!DOCTYPE svg><svg xmlns=\"http://www.w3.org/2000/svg\"/>"
    ));
    assert!(!envelope_matches(
        "image/svg+xml",
        b"<svg xmlns=\"http://example.invalid/other\"/>"
    ));
}

#[test]
fn the_whole_attempt_deadline_and_cancellation_are_enforced() {
    tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
        let outcome = bounded(deadline, async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<(), RemoteError>(())
        })
        .await;
        assert_eq!(outcome.unwrap_err().kind, RemoteErrorKind::Timeout);
        let cancelled = JobSignal::new();
        cancelled.cancel();
        assert!(cancelled.cancelled());
    });
}

#[test]
#[ignore = "requires outbound HTTPS to a permitted host"]
fn a_permitted_host_image_loads_over_real_https() {
    tauri::async_runtime::block_on(async {
        let policy = Policy::new(&hosts(&[
            "github.com",
            "raw.githubusercontent.com",
            "camo.githubusercontent.com",
            "user-images.githubusercontent.com",
        ]));
        let target = parse_image_url(
            "https://raw.githubusercontent.com/Chrysent-AI/taurimd/main/src-tauri/icons/icon.png",
        )
        .unwrap();
        let lease = policy.authorize(&target.host).unwrap();
        let signal = JobSignal::new();
        let fetched = fetch(&policy, &target, lease, signal).await.unwrap();
        assert_eq!(fetched.mime, "image/png");
        assert!(fetched.bytes.len() > 100);
        assert!(
            fetched
                .hosts
                .contains(&"raw.githubusercontent.com".to_owned())
        );
    });
}

#[test]
#[ignore = "requires outbound HTTPS to a permitted host"]
fn a_permitted_chain_follows_an_authorized_redirect() {
    tauri::async_runtime::block_on(async {
        let policy = Policy::new(&hosts(&["github.com", "raw.githubusercontent.com"]));
        let target = parse_image_url(
            "https://github.com/Chrysent-AI/taurimd/raw/main/src-tauri/icons/icon.png",
        )
        .unwrap();
        let lease = policy.authorize(&target.host).unwrap();
        let signal = JobSignal::new();
        let fetched = fetch(&policy, &target, lease, signal).await.unwrap();
        assert_eq!(fetched.mime, "image/png");
        assert!(
            fetched
                .hosts
                .contains(&"raw.githubusercontent.com".to_owned())
        );
    });
}

#[test]
#[ignore = "requires outbound HTTPS to a permitted host"]
fn a_redirect_escape_to_an_unlisted_host_is_refused() {
    tauri::async_runtime::block_on(async {
        // Only the starting host is permitted, so the real redirect to another
        // host must be refused before that destination is requested.
        let policy = Policy::new(&hosts(&["github.com"]));
        let target = parse_image_url(
            "https://github.com/Chrysent-AI/taurimd/raw/main/src-tauri/icons/icon.png",
        )
        .unwrap();
        let lease = policy.authorize(&target.host).unwrap();
        let signal = JobSignal::new();
        let error = match fetch(&policy, &target, lease, signal).await {
            Ok(_) => panic!("a redirect to an unlisted host must not succeed"),
            Err(error) => error,
        };
        assert_eq!(error.kind, RemoteErrorKind::RedirectBlocked);
        assert_eq!(error.host.as_deref(), Some("raw.githubusercontent.com"));
    });
}
