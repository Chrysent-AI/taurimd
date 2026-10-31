use crate::documents::{contained_file, AppError};
use std::path::{Path, PathBuf};
use tauri::Url;

// URL conversion performs the only percent decoding. A reference never grants a root.
pub fn local_reference(
    parent: &Path,
    reference: &str,
) -> Result<(PathBuf, Option<String>), AppError> {
    if reference.is_empty()
        || reference.trim() != reference
        || reference.chars().any(char::is_control)
        || reference.contains('\\')
        || reference.starts_with('/')
        || Url::parse(reference).is_ok()
    {
        return Err(AppError::new(
            "denied",
            "Use a relative local reference within this document's directory.",
        ));
    }
    let base = Url::from_directory_path(parent)
        .map_err(|_| AppError::new("denied", "The document directory is unavailable."))?;
    let mut url = base
        .join(reference)
        .map_err(|_| AppError::new("denied", "Invalid local reference."))?;
    if url.scheme() != "file" || url.host_str().is_some_and(|host| !host.is_empty()) {
        return Err(AppError::new(
            "denied",
            "Remote file references are not allowed.",
        ));
    }
    let fragment = url.fragment().map(str::to_owned);
    url.set_fragment(None);
    url.set_query(None);
    let path = url
        .to_file_path()
        .map_err(|_| AppError::new("denied", "Invalid local file reference."))?;
    Ok((contained_file(&path, Some(parent))?, fragment))
}

pub enum Destination {
    External(Url),
    Fragment(String),
    Document(PathBuf, Option<String>),
}
pub fn destination(parent: &Path, href: &str) -> Result<Destination, AppError> {
    let encoded_control = href.as_bytes().windows(3).any(|part| {
        part[0] == b'%'
            && std::str::from_utf8(&part[1..])
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
                .is_some_and(|value| value < 32 || value == 127)
    });
    if href.chars().any(char::is_control)
        || encoded_control
        || href.contains('\\')
        || href.trim() != href
        || href.is_empty()
    {
        return Err(AppError::new("denied", "Invalid link."));
    }
    if let Some(fragment) = href.strip_prefix('#') {
        return Ok(Destination::Fragment(fragment.into()));
    }
    if let Ok(url) = Url::parse(href) {
        let valid = match url.scheme() {
            "http" | "https" => {
                url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && href
                        .split_once("://")
                        .is_some_and(|(_, rest)| !rest.starts_with('/'))
                    && href
                        .to_ascii_lowercase()
                        .starts_with(&format!("{}://", url.scheme()))
            }
            "mailto" => !url.path().is_empty() && !href.contains(['<', '>', ' ']),
            "tel" => {
                let number = url.path().split(';').next().unwrap_or_default();
                number.bytes().any(|byte| byte.is_ascii_digit())
                    && number
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || b"+()-.*#".contains(&byte))
                    && url
                        .path()
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"+()-.;=*#".contains(&byte))
                    && url.query().is_none()
                    && url.fragment().is_none()
            }
            _ => false,
        };
        if valid {
            return Ok(Destination::External(url));
        }
        return Err(AppError::new(
            "denied",
            "Only HTTP, HTTPS, mail and telephone links may use the default application.",
        ));
    }
    let (path, fragment) = local_reference(parent, href)?;
    crate::documents::classify(&path)?;
    Ok(Destination::Document(path, fragment))
}

pub fn caller(label: &str) -> Result<(), AppError> {
    if label == "reader" {
        Ok(())
    } else {
        Err(AppError::new(
            "denied",
            "This webview has no document grant.",
        ))
    }
}
// The side-effect seam is injectable for tests; URL validation always precedes it.
pub fn open_external(
    url: Url,
    open: impl FnOnce(String) -> Result<(), AppError>,
) -> Result<(), AppError> {
    open(url.into())
}
