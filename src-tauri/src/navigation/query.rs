use super::{Entry, Scope};
use crate::documents::{AppError, Session};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub scope: u32,
    pub revision: u32,
    pub query_id: u32,
    pub text: String,
    pub directory: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub entry: Entry,
    pub positions: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub scope: u32,
    pub revision: u32,
    pub query_id: u32,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<u32>,
    pub status: &'static str,
    pub location: String,
    pub results: Vec<Match>,
    pub total: usize,
    pub message: String,
}
pub struct Answer {
    pub reply: Reply,
    pub missing: Option<PathBuf>,
}
fn directory(scope: &Scope, path: &Path) -> bool {
    path == scope.path
        || scope
            .records
            .iter()
            .any(|record| record.lexical == path && record.entry.kind == "directory")
}
fn location(scope: &Scope, path: &Path) -> String {
    path.strip_prefix(&scope.path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}
#[cfg(any(windows, test))]
fn same_windows_volume(candidate: std::path::Prefix<'_>, root: std::path::Prefix<'_>) -> bool {
    use std::path::Prefix;
    match (candidate, root) {
        (Prefix::Disk(a) | Prefix::VerbatimDisk(a), Prefix::Disk(b) | Prefix::VerbatimDisk(b)) => {
            a.eq_ignore_ascii_case(&b)
        }
        (
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share),
            Prefix::UNC(root_server, root_share) | Prefix::VerbatimUNC(root_server, root_share),
        ) => server == root_server && share == root_share,
        _ => false,
    }
}
#[cfg(windows)]
fn absolute_prefix(
    root: &Path,
    components: &mut std::path::Components<'_>,
) -> Result<PathBuf, &'static str> {
    let Some(Component::Prefix(candidate)) = components.next() else {
        return Err("authorizationRequired");
    };
    let Some(Component::Prefix(root_prefix)) = root.components().next() else {
        return Err("authorizationRequired");
    };
    if !same_windows_volume(candidate.kind(), root_prefix.kind()) {
        return Err("authorizationRequired");
    }
    // Seed only the authorized namespace/root. Pushing an entire verbatim path
    // would erase unchecked '..' before the ancestor checks in the loop below.
    let mut start = PathBuf::from(root_prefix.as_os_str());
    start.push(std::path::MAIN_SEPARATOR_STR);
    Ok(start)
}
// Never erase a potentially linked component followed by '..'. Only cached
// native directory records may be collapsed; activation revalidates ancestors.
fn path(
    scope: &Scope,
    text: &str,
    home: Option<&Path>,
    base: &Path,
) -> Result<(PathBuf, String), &'static str> {
    let input =
        if text == "~" || text.starts_with("~/") || (cfg!(windows) && text.starts_with("~\\")) {
            let home = home.ok_or("authorizationRequired")?;
            let tail = text.get(2..).unwrap_or_default();
            #[cfg(windows)]
            {
                // join would normalize unchecked parents on verbatim homes.
                let mut expanded = home.as_os_str().to_owned();
                expanded.push(std::path::MAIN_SEPARATOR_STR);
                expanded.push(tail.replace('/', std::path::MAIN_SEPARATOR_STR));
                PathBuf::from(expanded)
            }
            #[cfg(not(windows))]
            {
                home.join(tail)
            }
        } else {
            PathBuf::from(text)
        };
    #[cfg(windows)]
    crate::documents::validate_windows_path(&input).map_err(|_| "authorizationRequired")?;
    let trailing = text.ends_with('/')
        || (cfg!(windows) && text.ends_with('\\'))
        || text == "."
        || text == ".."
        || text == "~"
        || (input.is_absolute() && input.file_name().is_none());
    let (parent, fragment) = if trailing {
        (input.as_path(), String::new())
    } else {
        (
            input.parent().unwrap_or(Path::new("")),
            input
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )
    };
    let mut components = parent.components();
    let mut current = if input.is_absolute() {
        #[cfg(windows)]
        {
            absolute_prefix(&scope.path, &mut components)?
        }
        #[cfg(not(windows))]
        {
            PathBuf::new()
        }
    } else {
        base.to_owned()
    };
    for component in &mut components {
        #[cfg(windows)]
        if let Component::Normal(part) = component {
            // Do not let push reinterpret a verbatim literal as separators or '..'.
            let mut reparsed = Path::new(part).components();
            if reparsed.next() != Some(component) || reparsed.next().is_some() {
                return Err("authorizationRequired");
            }
        }
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !current.starts_with(&scope.path) {
                    return Err("authorizationRequired");
                }
                if !directory(scope, &current)
                    || super::candidate(&scope.path, &current, true).is_err()
                {
                    return Err("unavailable");
                }
                current.pop();
            }
            other => current.push(other.as_os_str()),
        }
    }
    if !current.starts_with(&scope.path) {
        return Err("authorizationRequired");
    }
    Ok((current, fragment))
}
// Positions count Unicode scalars in `relative`, never UTF-8 byte offsets.
fn fuzzy(text: &str, query: &str) -> Option<(i64, Vec<usize>)> {
    let folded: Vec<_> = text
        .chars()
        .enumerate()
        .flat_map(|(index, ch)| ch.to_lowercase().map(move |lower| (lower, index)))
        .collect();
    let mut cursor = 0;
    let mut positions = Vec::new();
    let mut score = 0;
    let chars: Vec<_> = text.chars().collect();
    let name = chars
        .iter()
        .rposition(|ch| *ch == '/' || *ch == '\\')
        .map_or(0, |index| index + 1);
    for wanted in query.chars().flat_map(char::to_lowercase) {
        let offset = folded[cursor..].iter().position(|(ch, _)| *ch == wanted)? + cursor;
        let index = folded[offset].1;
        if positions
            .last()
            .is_some_and(|previous| *previous + 1 == index)
        {
            score += 12;
        }
        if index >= name {
            score += 8;
        }
        if index == 0
            || chars
                .get(index.wrapping_sub(1))
                .is_some_and(|ch| matches!(ch, '/' | '\\' | '-' | '_' | ' ' | '.'))
        {
            score += 10;
        }
        score -= i64::try_from(index).unwrap_or(i64::MAX);
        if positions.last() != Some(&index) {
            positions.push(index);
        }
        cursor = offset + 1;
    }
    Some((score, positions))
}
pub fn query(scope: &Scope, request: Query, home: Option<&Path>) -> Result<Answer, AppError> {
    scope.live()?;
    if request.scope != scope.id || request.revision != scope.revision {
        return Err(Session::stale());
    }
    scope
        .filters
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut reply = Reply {
        scope: scope.id,
        revision: scope.revision,
        query_id: request.query_id,
        text: request.text.clone(),
        directory: request.directory,
        status: "ready",
        location: String::new(),
        results: Vec::new(),
        total: 0,
        message: String::new(),
    };
    if !scope.published {
        reply.status = "indexing";
        return Ok(Answer {
            reply,
            missing: None,
        });
    }
    let selected = request
        .directory
        .map(|id| {
            scope
                .records
                .iter()
                .find(|record| record.entry.id == id && record.entry.kind == "directory")
                .ok_or_else(Session::stale)
        })
        .transpose()?;
    let prefix = selected.map(|record| format!("{}/", record.entry.relative));
    let text = if let Some(prefix) = &prefix {
        request
            .text
            .strip_prefix(prefix)
            .ok_or_else(Session::stale)?
    } else {
        &request.text
    };
    let is_path = selected.is_some()
        || request.text.contains('/')
        || (cfg!(windows) && request.text.contains('\\'))
        || matches!(request.text.as_str(), "." | ".." | "~");
    let (parent, needle) = if is_path {
        match path(
            scope,
            text,
            home,
            selected.map_or(&scope.path, |record| &record.lexical),
        ) {
            Ok(value) => (Some(value.0), value.1),
            Err(status) => {
                reply.status = status;
                return Ok(Answer {
                    reply,
                    missing: None,
                });
            }
        }
    } else {
        (None, request.text)
    };
    if let Some(parent) = &parent {
        reply.location = location(scope, parent);
        if !directory(scope, parent) {
            reply.status = "missing";
            return Ok(Answer {
                reply,
                missing: Some(parent.clone()),
            });
        }
        if super::candidate(&scope.path, parent, true).is_err() {
            reply.status = "unavailable";
            return Ok(Answer {
                reply,
                missing: None,
            });
        }
    }
    let mut matches: Vec<_> = scope
        .records
        .iter()
        .filter(|record| {
            parent
                .as_ref()
                .is_none_or(|parent| record.lexical.parent() == Some(parent))
        })
        .filter_map(|record| {
            let display = if parent.is_some() {
                &record.entry.name
            } else {
                &record.entry.relative
            };
            let (score, mut positions) = fuzzy(display, &needle)?;
            if parent.is_some() {
                let prefix =
                    record.entry.relative.chars().count() - record.entry.name.chars().count();
                for position in &mut positions {
                    *position += prefix;
                }
            }
            Some((record, score, positions))
        })
        .collect();
    matches.sort_by(|(a, sa, _), (b, sb, _)| {
        (a.entry.kind != "directory")
            .cmp(&(b.entry.kind != "directory"))
            .then_with(|| sb.cmp(sa))
            .then_with(|| a.lexical.cmp(&b.lexical))
    });
    reply.total = matches.len();
    reply.results = matches
        .into_iter()
        .take(100)
        .map(|(record, _, positions)| Match {
            entry: record.entry.clone(),
            positions,
        })
        .collect();
    Ok(Answer {
        reply,
        missing: None,
    })
}
pub fn validate_directory(scope: &Scope, path: &Path) -> Result<(), AppError> {
    super::candidate(&scope.path, path, true).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permitted_windows_volume_identity_is_independent_of_prefix_representation() {
        use std::{ffi::OsStr, path::Prefix};
        assert!(same_windows_volume(
            Prefix::Disk(b'c'),
            Prefix::VerbatimDisk(b'C')
        ));
        assert!(same_windows_volume(
            Prefix::VerbatimDisk(b'C'),
            Prefix::Disk(b'C')
        ));
        assert!(!same_windows_volume(
            Prefix::Disk(b'D'),
            Prefix::VerbatimDisk(b'C')
        ));
        let server = OsStr::new("server");
        let share = OsStr::new("share");
        let ordinary = Prefix::UNC(server, share);
        let verbatim = Prefix::VerbatimUNC(server, share);
        assert!(same_windows_volume(ordinary, verbatim));
        assert!(same_windows_volume(verbatim, ordinary));
        assert!(!same_windows_volume(
            Prefix::UNC(OsStr::new("other"), share),
            verbatim
        ));
        assert!(!same_windows_volume(
            Prefix::UNC(server, OsStr::new("other")),
            verbatim
        ));
        assert!(!same_windows_volume(ordinary, Prefix::VerbatimDisk(b'C')));
        assert!(!same_windows_volume(
            Prefix::DeviceNS(OsStr::new("C:")),
            Prefix::VerbatimDisk(b'C')
        ));
        assert!(!same_windows_volume(
            Prefix::Verbatim(OsStr::new("C:")),
            Prefix::VerbatimDisk(b'C')
        ));
    }
    #[cfg(windows)]
    #[test]
    fn windows_absolute_prefix_preparation_keeps_components_and_rejects_outside_namespaces() {
        // Reserved labels construct syntactic fixtures; no network share is contacted.
        fn unc_fixture(verbatim: bool, server: &str, share: &str, tail: &str) -> String {
            let mut value = String::from(r"\\");
            if verbatim {
                value.push_str(r"?\UNC\");
            }
            for component in [server, share] {
                value.push_str(component);
                value.push('\\');
            }
            value.push_str(tail);
            value
        }
        const SERVER: &str = "fixture.invalid";
        const SHARE: &str = "documents";
        let canonical_unc = unc_fixture(true, SERVER, SHARE, "docs");
        let cases: [(String, String, String); 6] = [
            (
                r"\\?\C:\docs\project".into(),
                r"C:\docs\project\sub\".into(),
                r"\\?\C:\docs\project\sub".into(),
            ),
            (
                r"\\?\C:\docs\project".into(),
                r"\\?\C:\docs\project\sub\".into(),
                r"\\?\C:\docs\project\sub".into(),
            ),
            (
                r"C:\docs\project".into(),
                r"\\?\C:\docs\project\sub\".into(),
                r"C:\docs\project\sub".into(),
            ),
            (
                canonical_unc.clone(),
                unc_fixture(false, SERVER, SHARE, r"docs\sub\"),
                unc_fixture(true, SERVER, SHARE, r"docs\sub"),
            ),
            (
                canonical_unc.clone(),
                unc_fixture(true, SERVER, SHARE, r"docs\sub\"),
                unc_fixture(true, SERVER, SHARE, r"docs\sub"),
            ),
            (
                unc_fixture(false, SERVER, SHARE, "docs"),
                unc_fixture(true, SERVER, SHARE, r"docs\sub\"),
                unc_fixture(false, SERVER, SHARE, r"docs\sub"),
            ),
        ];
        for (root, input, expected) in cases {
            let mut nav = crate::navigation::Navigation::default();
            let scope = nav.start(PathBuf::from(&root), true, false).unwrap();
            let (prepared, fragment) = path(&scope, &input, None, &scope.path).unwrap();
            assert_eq!(prepared, PathBuf::from(expected));
            assert!(fragment.is_empty());
            assert_eq!(scope.path, PathBuf::from(root));
        }
        // Pure native Windows component preparation: no UNC server is contacted.
        let outside: [(String, Vec<String>); 2] = [
            (
                r"\\?\C:\docs\project".into(),
                vec![
                    r"D:\docs\project\sub\".into(),
                    r"C:docs\project\sub\".into(),
                    r"C:\docs\project-other\sub\".into(),
                    r"\\.\C:\docs\project\sub\".into(),
                    r"\\?\GLOBALROOT\Device\HarddiskVolume1\".into(),
                    r"C:\docs\project\sub:stream\".into(),
                    r"\\?\C:\docs\project\unchecked/../sub\".into(),
                ],
            ),
            (
                canonical_unc.clone(),
                vec![
                    unc_fixture(false, "other.invalid", SHARE, r"docs\sub\"),
                    unc_fixture(false, SERVER, "other-documents", r"docs\sub\"),
                    unc_fixture(false, SERVER, SHARE, r"elsewhere\"),
                    unc_fixture(false, SERVER, "documents:stream", r"docs\"),
                ],
            ),
        ];
        for (root, inputs) in outside {
            let mut nav = crate::navigation::Navigation::default();
            let scope = nav.start(PathBuf::from(root), true, false).unwrap();
            for input in inputs {
                assert_eq!(
                    path(&scope, &input, None, &scope.path).unwrap_err(),
                    "authorizationRequired",
                    "{input}"
                );
            }
        }
        let mut nav = crate::navigation::Navigation::default();
        let scope = nav
            .start(PathBuf::from(r"\\?\C:\docs\project"), true, false)
            .unwrap();
        for input in [
            r"C:\docs\project\unchecked\..\sub\",
            r"\\?\C:\docs\project\unchecked\..\sub\",
        ] {
            assert_eq!(
                path(&scope, input, None, &scope.path).unwrap_err(),
                "unavailable"
            );
        }
        for root in [r"\\?\C:\docs\project".to_owned(), canonical_unc] {
            let mut nav = crate::navigation::Navigation::default();
            let scope = nav.start(PathBuf::from(root), true, false).unwrap();
            assert_eq!(
                path(
                    &scope,
                    "~/unchecked/../sub/",
                    Some(&scope.path),
                    &scope.path
                )
                .unwrap_err(),
                "unavailable"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_ordinary_absolute_and_home_queries_reuse_canonical_cached_members() {
        use std::{ffi::OsString, fs, path::Prefix};
        fn ordinary(path: &Path) -> PathBuf {
            let mut components = path.components();
            let Some(Component::Prefix(prefix)) = components.next() else {
                panic!("Windows fixture needs a volume");
            };
            let mut head = match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    OsString::from(format!("{}:", char::from(drive)))
                }
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    let mut head = OsString::from(r"\\");
                    head.push(server);
                    head.push(r"\");
                    head.push(share);
                    head
                }
                _ => panic!("unsupported fixture prefix"),
            };
            head.push(r"\");
            let mut result = PathBuf::from(head);
            for part in components {
                if !matches!(part, Component::RootDir) {
                    result.push(part.as_os_str());
                }
            }
            result
        }
        let temp = tempfile::tempdir().unwrap();
        let home = super::super::root_path(temp.path()).unwrap();
        fs::create_dir_all(home.join("authorized/sub")).unwrap();
        fs::write(home.join("authorized/sub/a.md"), "# Cached").unwrap();
        let canonical = super::super::root_path(&home.join("authorized")).unwrap();
        let mut nav = crate::navigation::Navigation::default();
        let draft = nav.start(canonical.clone(), true, false).unwrap();
        nav.publish(super::super::scan(draft, true).unwrap())
            .unwrap();
        let scope = nav.root.as_ref().unwrap();
        for provider in [ordinary(&home), home.clone()] {
            for text in [
                format!("{}\\sub\\a", ordinary(&canonical).display()),
                format!("{}\\sub\\a", canonical.display()),
                "~/authorized/sub/a".into(),
            ] {
                let reply = query(
                    scope,
                    Query {
                        scope: scope.id,
                        revision: scope.revision,
                        query_id: 1,
                        text,
                        directory: None,
                    },
                    Some(&provider),
                )
                .unwrap()
                .reply;
                assert_eq!(reply.status, "ready");
                assert_eq!(reply.total, 1);
                assert_eq!(reply.results[0].entry.name, "a.md");
            }
        }
        assert_eq!(scope.path, canonical);
        drop(nav);
        let owned = temp.path().to_owned();
        temp.close().unwrap();
        assert!(!owned.exists());
    }
    #[test]
    fn cached_queries_paths_cap_and_same_scanner_completion_share_native_bindings() {
        use crate::navigation::Navigation;
        use std::{fs, sync::atomic::Ordering};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let root = home.join("root");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        for name in ["a.md", "sub/a.md", "sub/😀İ.md", ".hidden.md", "bad.mdx"] {
            fs::write(root.join(name), [0xff]).unwrap();
        }
        for number in 0..110 {
            fs::write(root.join(format!("file-{number:03}.log")), [0xff]).unwrap();
        }
        let mut nav = Navigation::default();
        let scope = nav.start(root.clone(), true, false).unwrap();
        nav.publish(super::super::scan(scope, true).unwrap())
            .unwrap();
        let scope = nav.root.clone().unwrap();
        let request = |text: &str| Query {
            scope: scope.id,
            revision: scope.revision,
            query_id: 7,
            text: text.into(),
            directory: None,
        };
        let empty = query(&scope, request(""), Some(&home)).unwrap().reply;
        assert_eq!(empty.results.len(), 100);
        assert_eq!(empty.total, 114);
        assert_eq!(empty.results[0].entry.kind, "directory");
        let cached = query(&scope, request("sub/a"), Some(&home)).unwrap();
        let sub_a = Path::new("sub").join("a.md");
        assert_eq!(
            cached.reply.results[0].entry.relative,
            sub_a.to_string_lossy()
        );
        let selected = &cached.reply.results[0].entry;
        let siblings = nav.root_siblings(&root.join("sub/a.md")).unwrap();
        assert_eq!(siblings.active, Some(selected.id));
        for text in [
            "sub/../a",
            "~/root/sub/a",
            &format!("{}/sub/a", root.display()),
        ] {
            assert!(query(&scope, request(text), Some(&home))
                .unwrap()
                .reply
                .results
                .iter()
                .any(|row| row.entry.relative.ends_with("a.md")));
        }
        for text in [
            "../",
            "~/outside/",
            &format!("{}-lookalike/", root.display()),
        ] {
            let denied = query(&scope, request(text), Some(&home)).unwrap();
            assert_eq!(denied.reply.status, "authorizationRequired");
            assert!(denied.reply.results.is_empty());
            assert!(denied.missing.is_none());
        }
        assert!(scope.filters.load(Ordering::Relaxed) >= 8);
        fs::create_dir(root.join("new")).unwrap();
        fs::write(root.join("new/new.md"), "new").unwrap();
        let missing = query(&scope, request("new/"), Some(&home)).unwrap();
        assert_eq!(missing.reply.status, "missing");
        let target = missing.missing.unwrap();
        validate_directory(&scope, &target).unwrap();
        let draft = nav.start(root.clone(), true, true).unwrap();
        nav.publish(super::super::scan_directory(draft, target).unwrap())
            .unwrap();
        let next = nav.root.as_ref().unwrap();
        let new_file = Path::new("new").join("new.md");
        assert!(next
            .records
            .iter()
            .any(|row| row.entry.relative == new_file.to_string_lossy()));
        assert!(next
            .records
            .iter()
            .any(|row| row.entry.relative == sub_a.to_string_lossy()));
        assert!(query(next, request("a"), Some(&home)).is_err());
        assert!(scope.live().is_err());
        assert_eq!(fs::read(root.join("a.md")).unwrap(), [0xff]);
        assert!(serde_json::from_value::<Query>(serde_json::json!({ "scope":1, "revision":2, "queryId":3, "text":"x", "path":"arbitrary" })).is_err());
        let wire = serde_json::to_value(empty).unwrap();
        assert_eq!(wire["queryId"], 7);
        assert!(wire["results"][0]["positions"].is_array());
        drop(nav);
        let path = temp.path().to_owned();
        temp.close().unwrap();
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn selected_directory_uses_native_identity_when_display_paths_collide() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let native = root.join("native-directory");
        let lookalike = root.join("a�");
        fs::create_dir(&native).unwrap();
        fs::create_dir(&lookalike).unwrap();
        fs::write(native.join("native.md"), "# Native").unwrap();
        fs::write(lookalike.join("other.md"), "# Other").unwrap();
        let mut nav = crate::navigation::Navigation::default();
        let mut draft = super::super::scan(nav.start(root, true, false).unwrap(), true).unwrap();
        // Exercise display/native separation even on filesystems rejecting raw
        // non-UTF-8 names: a colliding display projection is not path authority.
        let projected = std::sync::Arc::make_mut(&mut draft.records)
            .iter_mut()
            .find(|record| record.lexical == native)
            .unwrap();
        projected.entry.relative = "a�".into();
        projected.entry.name = "a�".into();
        nav.publish(draft).unwrap();
        let scope = nav.root.as_ref().unwrap();
        let selected = scope
            .records
            .iter()
            .find(|record| record.lexical == native)
            .unwrap();
        let answer = query(
            scope,
            Query {
                scope: scope.id,
                revision: scope.revision,
                query_id: 1,
                text: format!("{}/", selected.entry.relative),
                directory: Some(selected.entry.id),
            },
            None,
        )
        .unwrap();
        assert_eq!(answer.reply.total, 1);
        assert_eq!(answer.reply.results[0].entry.name, "native.md");
        let record = scope
            .entry(super::super::Binding {
                scope: scope.id,
                revision: scope.revision,
                entry: answer.reply.results[0].entry.id,
            })
            .unwrap();
        assert_eq!(
            scope
                .read(&record, 1, 1, &std::sync::atomic::AtomicBool::new(false))
                .unwrap()
                .snapshot
                .source,
            "# Native"
        );
        drop(nav);
        let path = temp.path().to_owned();
        temp.close().unwrap();
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn unchecked_or_retargeted_directory_links_are_not_normalized_through_parent_segments() {
        use std::{fs, os::unix::fs::symlink};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        let mut nav = crate::navigation::Navigation::default();
        let scope = nav.start(root.clone(), true, false).unwrap();
        nav.publish(super::super::scan(scope, true).unwrap())
            .unwrap();
        let scope = nav.root.as_ref().unwrap();
        fs::remove_dir(root.join("sub")).unwrap();
        symlink(root.parent().unwrap(), root.join("sub")).unwrap();
        let answer = query(
            scope,
            Query {
                scope: scope.id,
                revision: scope.revision,
                query_id: 1,
                text: "sub/../".into(),
                directory: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(answer.reply.status, "unavailable");
        assert!(answer.reply.results.is_empty());
        assert!(validate_directory(scope, &root.join("sub")).is_err());
        drop(nav);
        let path = temp.path().to_owned();
        temp.close().unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn scalar_coordinates_survive_case_expansion_and_non_bmp() {
        assert_eq!(fuzzy("x/😀İ.md", "😀i\u{307}").unwrap().1, vec![2, 3]);
        assert!(fuzzy("abc", "z").is_none());
    }
}
