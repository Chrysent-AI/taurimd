use crate::{
    documents::{contained_file, AppError, Session},
    links,
};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::http::{Request, Response, StatusCode};

#[derive(Clone)]
pub struct Scope {
    pub parent: PathBuf,
    lifetime: Arc<AtomicBool>,
}
impl Scope {
    pub fn live(&self) -> Result<(), AppError> {
        if self.lifetime.load(Ordering::Acquire) {
            Err(Session::stale())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone)]
pub struct Grant {
    scope: Scope,
    path: PathBuf,
    mime: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub id: String,
    pub mime: &'static str,
}
pub fn scope(session: &Session, label: &str, id: u32, revision: u32) -> Result<Scope, AppError> {
    session.caller(label)?;
    let parent = session.active_ref(id, revision)?.parent.clone();
    let scope = Scope {
        parent,
        lifetime: session.media_lifetime.clone(),
    };
    scope.live()?;
    Ok(scope)
}
pub fn resolve(scope: Scope, reference: &str) -> Result<Grant, AppError> {
    scope.live()?;
    let (path, _) = links::local_reference(&scope.parent, reference)?;
    let mime = mime(&path).ok_or_else(|| {
        AppError::new(
            "unsupported",
            "This local image/audio/video format is not supported.",
        )
    })?;
    let file = File::open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::new("unsupported", "Not a regular media file."));
    }
    scope.live()?;
    Ok(Grant { scope, path, mime })
}
pub fn insert(session: &mut Session, grant: Grant) -> Result<Resolved, AppError> {
    grant.scope.live()?;
    if !Arc::ptr_eq(&session.media_lifetime, &grant.scope.lifetime) {
        return Err(Session::stale());
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let number = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
        .map_err(|_| AppError::new("resourceFailure", "Media identifiers exhausted."))?;
    let id = format!("{number:032x}");
    let result = Resolved {
        id: id.clone(),
        mime: grant.mime,
    };
    session.media.insert(id, grant);
    Ok(result)
}
fn mime(path: &std::path::Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            "wav" => "audio/wav",
            "mp3" => "audio/mpeg",
            "ogg" | "oga" => "audio/ogg",
            "m4a" => "audio/mp4",
            "mp4" | "m4v" => "video/mp4",
            "webm" => "video/webm",
            "ogv" => "video/ogg",
            _ => return None,
        },
    )
}
fn response(
    status: StatusCode,
    mime: &str,
    length: u64,
    body: Vec<u8>,
    range: Option<String>,
) -> Response<Vec<u8>> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    // Values here are fixed policy strings or checked integer formatting.
    headers.insert("Content-Type", mime.parse().expect("fixed MIME"));
    headers.insert("Content-Length", length.into());
    headers.insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    headers.insert("Cache-Control", "no-store".parse().unwrap());
    headers.insert("Accept-Ranges", "bytes".parse().unwrap());
    headers.insert(
        "Content-Security-Policy",
        "default-src 'none'; sandbox".parse().unwrap(),
    );
    if let Some(range) = range {
        headers.insert("Content-Range", range.parse().unwrap());
    }
    if status == StatusCode::METHOD_NOT_ALLOWED {
        headers.insert("Allow", "GET, HEAD".parse().unwrap());
    }
    response
}
fn error(status: StatusCode) -> Response<Vec<u8>> {
    response(status, "text/plain", 0, Vec::new(), None)
}
#[derive(Debug, PartialEq)]
enum RangeError {
    Malformed,
    Unsatisfiable,
}
fn selected_range(value: &str, length: u64) -> Result<(u64, u64), RangeError> {
    let value = value.strip_prefix("bytes=").ok_or(RangeError::Malformed)?;
    let (start, end) = value.split_once('-').ok_or(RangeError::Malformed)?;
    let number = |text: &str| -> Result<u64, RangeError> {
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RangeError::Malformed);
        }
        text.parse().map_err(|_| RangeError::Malformed)
    };
    let (start, end) = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 || length == 0 {
            return Err(RangeError::Unsatisfiable);
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            length.saturating_sub(1)
        } else {
            number(end)?
        };
        if length == 0 || start >= length || end < start {
            return Err(RangeError::Unsatisfiable);
        }
        (start, end.min(length - 1))
    };
    Ok((start, end))
}
fn read_body(
    reader: &mut (impl Read + Seek),
    start: u64,
    length: u64,
) -> Result<Vec<u8>, AppError> {
    let count = usize::try_from(length)
        .map_err(|_| AppError::new("resourceFailure", "Media is too large for memory."))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(count)
        .map_err(|_| AppError::new("resourceFailure", "Not enough memory for media."))?;
    bytes.resize(count, 0);
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn representation(
    request: &Request<Vec<u8>>,
    grant: &Grant,
) -> Result<Response<Vec<u8>>, AppError> {
    grant.scope.live()?;
    let path = contained_file(&grant.path, Some(&grant.scope.parent))?;
    if mime(&path) != Some(grant.mime) {
        return Err(AppError::new("denied", "Media type changed."));
    }
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::new("unsupported", "Not a regular media file."));
    }
    let length = metadata.len();
    if request.method() == "HEAD" {
        return Ok(response(
            StatusCode::OK,
            grant.mime,
            length,
            Vec::new(),
            None,
        ));
    }
    let mut start = 0;
    let mut count = length;
    let mut status = StatusCode::OK;
    let mut content_range = None;
    if !request.headers().contains_key("If-Range") {
        let values = request
            .headers()
            .get_all("Range")
            .iter()
            .collect::<Vec<_>>();
        if values.len() > 1 {
            return Ok(error(StatusCode::BAD_REQUEST));
        }
        if let Some(value) = values.first() {
            let Ok(range) = value.to_str() else {
                return Ok(error(StatusCode::BAD_REQUEST));
            };
            match selected_range(range, length) {
                Ok((first, last)) => {
                    start = first;
                    count = last
                        .checked_sub(first)
                        .and_then(|n| n.checked_add(1))
                        .ok_or_else(|| AppError::new("resourceFailure", "Media range overflow."))?;
                    content_range = Some(format!("bytes {first}-{last}/{length}"));
                    status = StatusCode::PARTIAL_CONTENT;
                }
                Err(RangeError::Malformed) => return Ok(error(StatusCode::BAD_REQUEST)),
                Err(RangeError::Unsatisfiable) => {
                    return Ok(response(
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        grant.mime,
                        0,
                        Vec::new(),
                        Some(format!("bytes */{length}")),
                    ))
                }
            }
        }
    }
    let bytes = read_body(&mut file, start, count)?;
    Ok(response(status, grant.mime, count, bytes, content_range))
}
// This helper is called by the registered handler. File work takes no session
// lock. The final synchronous responder handoff serializes with commit/revocation.
pub fn serve<T>(
    state: &Mutex<Session>,
    caller: &str,
    request: Request<Vec<u8>>,
    respond: impl FnOnce(Response<Vec<u8>>) -> T,
) -> T {
    if state
        .lock()
        .map_or(true, |session| session.caller(caller).is_err())
    {
        return respond(error(StatusCode::FORBIDDEN));
    }
    if request.method() != "GET" && request.method() != "HEAD" {
        return respond(error(StatusCode::METHOD_NOT_ALLOWED));
    }
    let uri = request.uri();
    let path = uri.path();
    let Some(id) = path.strip_prefix('/') else {
        return respond(error(StatusCode::NOT_FOUND));
    };
    if uri.scheme_str() != Some("reader-media")
        || uri.authority().map(|a| a.as_str()) != Some("localhost")
        || uri.query().is_some()
        || id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return respond(error(StatusCode::NOT_FOUND));
    }
    let grant = state
        .lock()
        .ok()
        .and_then(|session| session.media.get(id).cloned());
    let Some(grant) = grant else {
        return respond(error(StatusCode::NOT_FOUND));
    };
    let result = representation(&request, &grant);
    let publication = state.lock();
    let response = if publication.is_ok() {
        publish(&grant, result)
    } else {
        error(StatusCode::INTERNAL_SERVER_ERROR)
    };
    // No filesystem work or frontend notification occurs under this guard.
    let delivered = respond(response);
    drop(publication);
    delivered
}
fn publish(grant: &Grant, result: Result<Response<Vec<u8>>, AppError>) -> Response<Vec<u8>> {
    // Revocation cannot retract bytes already buffered by a webview. It denies
    // late work here and all subsequent requests; pending-read cancel is separate.
    if grant.scope.live().is_err() {
        return error(StatusCode::GONE);
    }
    match result {
        Ok(response) => response,
        Err(error_value) => error(match error_value.code {
            "stale" => StatusCode::GONE,
            "notFound" => StatusCode::NOT_FOUND,
            "denied" => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }),
    }
}

#[cfg(test)]
mod tests;
