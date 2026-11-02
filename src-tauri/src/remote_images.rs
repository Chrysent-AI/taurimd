//! Permitted HTTPS image transport.
//!
//! This module owns the whole remote-image boundary: exact host identity, the
//! derived permission leases, the shared client, the active-operation and
//! retained-byte budgets, the manual redirect loop and the image MIME/decoding
//! boundary. It never returns a document URL to the webview and it never
//! authorizes anything beyond exact-host HTTPS image access.

use crate::documents::AppError;
use std::collections::HashSet;
use std::error::Error as _;
use std::sync::{
    Arc, Mutex, MutexGuard, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Url;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The already-confirmed starter hosts for automatic image requests.
pub const STARTER_HOSTS: [&str; 4] = [
    "github.com",
    "raw.githubusercontent.com",
    "camo.githubusercontent.com",
    "user-images.githubusercontent.com",
];

/// The confirmed starter hosts as one canonical, sorted list. The same list
/// seeds a new installation and a valid older record without the field.
pub fn starter_host_list() -> Vec<String> {
    let mut hosts: Vec<String> = STARTER_HOSTS
        .iter()
        .map(|host| (*host).to_owned())
        .collect();
    hosts.sort();
    hosts
}

/// Product-visible safety budgets confirmed with the accepted design.
pub const MAX_REDIRECTS: usize = 5;
pub const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ACTIVE_OPERATIONS: usize = 4;
pub const MAX_RETAINED_BYTES: usize = 64 * 1024 * 1024;
pub const ATTEMPT_BUDGET: Duration = Duration::from_secs(30);

const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";
const IMAGE_ACCEPT: &str = "image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteErrorKind {
    BlockedHost,
    InvalidUrl,
    RedirectBlocked,
    RedirectLimit,
    Timeout,
    Tls,
    Network,
    Status,
    Unsupported,
    Budget,
    Stale,
}

/// A resource-local failure. It carries only a canonical host, never a URL,
/// a path, a query or a document location.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteError {
    pub kind: RemoteErrorKind,
    pub host: Option<String>,
}

impl RemoteError {
    pub fn new(kind: RemoteErrorKind, host: Option<String>) -> Self {
        Self { kind, host }
    }
    pub fn code(&self) -> &'static str {
        match self.kind {
            RemoteErrorKind::BlockedHost => "blockedHost",
            RemoteErrorKind::InvalidUrl => "invalidRemoteUrl",
            RemoteErrorKind::RedirectBlocked => "redirectBlocked",
            RemoteErrorKind::RedirectLimit => "redirectLimit",
            RemoteErrorKind::Timeout => "remoteTimeout",
            RemoteErrorKind::Tls => "remoteTls",
            RemoteErrorKind::Network => "remoteNetwork",
            RemoteErrorKind::Status => "remoteStatus",
            RemoteErrorKind::Unsupported => "unsupportedImage",
            RemoteErrorKind::Budget => "remoteBudget",
            RemoteErrorKind::Stale => "stale",
        }
    }
    pub fn message(&self) -> String {
        let host = self.host.as_deref().unwrap_or("the image host");
        match self.kind {
            RemoteErrorKind::BlockedHost => {
                format!("Image blocked — {host} is not permitted. Manage hosts in Settings.")
            }
            RemoteErrorKind::InvalidUrl => {
                "Image blocked — unsupported or invalid remote image address.".into()
            }
            RemoteErrorKind::RedirectBlocked => format!(
                "Image blocked — redirect host {host} is not permitted. Manage hosts in Settings."
            ),
            RemoteErrorKind::RedirectLimit => {
                "Image blocked — the redirect chain was too long or repeated.".into()
            }
            RemoteErrorKind::Timeout => format!("Image from {host} timed out."),
            RemoteErrorKind::Tls => {
                format!("Could not verify the secure connection to {host}.")
            }
            RemoteErrorKind::Network => {
                format!("Image from {host} could not load. Check your connection and retry.")
            }
            RemoteErrorKind::Status => format!("Image from {host} is unavailable."),
            RemoteErrorKind::Unsupported => {
                format!("Image from {host} is unsupported or could not be decoded.")
            }
            RemoteErrorKind::Budget => format!(
                "Image from {host} exceeds the supported size or memory limit. Close another document and retry."
            ),
            RemoteErrorKind::Stale => "This image request is no longer current.".to_owned(),
        }
    }
    /// Converts to the shared application error shape. The canonical host is
    /// the only additional detail; no URL, path or query is ever attached.
    pub fn into_app_error(self) -> AppError {
        let mut error = AppError::new(self.code(), self.message());
        error.attempted = self.host;
        error
    }
}

fn invalid() -> RemoteError {
    RemoteError::new(RemoteErrorKind::InvalidUrl, None)
}

// ---------------------------------------------------------------------------
// Host identity
// ---------------------------------------------------------------------------

/// Normalizes one bare DNS host entry to its canonical ASCII identity.
///
/// Surrounding whitespace is trimmed. Schemes, ports, paths, wildcards,
/// userinfo, percent escapes, backslashes, control characters, empty labels
/// and leading or trailing dots are rejected. Unicode labels are mapped to
/// their IDNA form by the HTTPS URL parser; numeric addresses and numeric
/// address disguises are never accepted as domains.
pub fn canonical_host(entry: &str) -> Result<String, RemoteError> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return Err(invalid());
    }
    if trimmed
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid());
    }
    if trimmed.contains(['/', '\\', ':', '?', '#', '@', '%', '*', '[', ']']) {
        return Err(invalid());
    }
    // Raw Unicode full-stop substitutes are ambiguous and are refused before
    // the parser can fold them into an ordinary label separator.
    if trimmed.contains(['\u{3002}', '\u{ff0e}', '\u{ff61}']) {
        return Err(invalid());
    }
    if trimmed.starts_with('.') || trimmed.ends_with('.') || trimmed.contains("..") {
        return Err(invalid());
    }
    let parsed = Url::parse(&format!("https://{trimmed}/")).map_err(|_| invalid())?;
    // A domain host is required: IPv4, IPv6 and numeric address disguises are
    // never accepted as permitted host identities.
    let Some(domain) = parsed.domain() else {
        return Err(invalid());
    };
    let canonical = domain.to_ascii_lowercase();
    validate_labels(&canonical)?;
    Ok(canonical)
}

/// Canonicalizes, de-duplicates and sorts a whole host list.
pub fn canonical_host_list(entries: &[String]) -> Result<Vec<String>, RemoteError> {
    let mut hosts: Vec<String> = Vec::new();
    for entry in entries {
        let canonical = canonical_host(entry)?;
        if !hosts.contains(&canonical) {
            hosts.push(canonical);
        }
    }
    hosts.sort();
    Ok(hosts)
}

fn validate_labels(host: &str) -> Result<(), RemoteError> {
    if host.is_empty() || host.len() > 253 {
        return Err(invalid());
    }
    for label in host.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(invalid());
        }
        let bytes = label.as_bytes();
        let edge = |byte: u8| byte.is_ascii_alphanumeric();
        if !edge(bytes[0]) || !edge(bytes[bytes.len() - 1]) {
            return Err(invalid());
        }
        if !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return Err(invalid());
        }
    }
    Ok(())
}

/// A validated HTTPS image target.
pub struct RemoteTarget {
    pub url: Url,
    pub host: String,
}

/// Parses an absolute HTTPS image reference under the accepted host contract.
///
/// Protocol-relative references, non-HTTPS schemes, outer whitespace,
/// control characters, backslashes, raw authority escapes, any authority
/// userinfo and every port other than the literal default 443 are refused.
pub fn parse_image_url(reference: &str) -> Result<RemoteTarget, RemoteError> {
    if reference.is_empty() || reference != reference.trim() {
        return Err(invalid());
    }
    if reference
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid());
    }
    if reference.contains('\\') {
        return Err(invalid());
    }
    let Some(rest) = reference.strip_prefix("https://") else {
        return Err(invalid());
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    check_authority(&rest[..end])?;
    let mut url = Url::parse(reference).map_err(|_| invalid())?;
    url.set_fragment(None);
    let host = validate_parsed(&url)?;
    Ok(RemoteTarget { url, host })
}

/// Applies the raw authority rules that parsing alone cannot express.
fn check_authority(authority: &str) -> Result<(), RemoteError> {
    if authority.is_empty() {
        return Err(invalid());
    }
    if authority.contains(['@', '%', '\\', '[', ']']) {
        return Err(invalid());
    }
    if let Some((host, port)) = authority.rsplit_once(':')
        && (host.contains(':') || port != "443")
    {
        return Err(invalid());
    }
    Ok(())
}

/// Validates an already parsed target and returns its canonical host.
fn validate_parsed(url: &Url) -> Result<String, RemoteError> {
    if url.scheme() != "https" {
        return Err(invalid());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid());
    }
    if url.port().is_some() {
        return Err(invalid());
    }
    let Some(domain) = url.domain() else {
        return Err(invalid());
    };
    let canonical = domain.to_ascii_lowercase();
    validate_labels(&canonical)?;
    Ok(canonical)
}

// ---------------------------------------------------------------------------
// Permission leases and policy
// ---------------------------------------------------------------------------

/// A revocable permission for one canonical host.
pub struct HostLease {
    host: String,
    revoked: AtomicBool,
    jobs: Mutex<Vec<std::sync::Weak<JobSignal>>>,
}

impl HostLease {
    pub fn live(&self) -> bool {
        !self.revoked.load(Ordering::Acquire)
    }
    fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }
    /// Registers one pending job so that a later removal can cancel it.
    pub fn register(&self, job: &Arc<JobSignal>) {
        let Ok(mut jobs) = self.jobs.lock() else {
            return;
        };
        // A removal between the authorization and this registration must
        // still cancel the job. The check and the registration happen under
        // the same lock a removal takes, so a revocation cannot slip between
        // them and leave an unregistered job running.
        if !self.live() {
            job.cancel();
            return;
        }
        jobs.retain(|weak| weak.strong_count() > 0);
        jobs.push(Arc::downgrade(job));
    }
    fn cancel_jobs(&self) {
        let Ok(jobs) = self.jobs.lock() else {
            return;
        };
        for weak in jobs.iter() {
            if let Some(job) = weak.upgrade() {
                job.cancel();
            }
        }
    }
}

/// A cooperative cancellation handle shared by one remote attempt.
pub struct JobSignal {
    revoked: AtomicBool,
    abort: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl JobSignal {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            revoked: AtomicBool::new(false),
            abort: Mutex::new(None),
        })
    }
    /// Cancels the attempt and aborts its owned task.
    pub fn cancel(&self) {
        self.revoked.store(true, Ordering::Release);
        let handle = self.abort.lock().ok().and_then(|mut abort| abort.take());
        if let Some(handle) = handle {
            handle.abort();
        }
    }
    /// Installs the owned task handle. A task that is registered after its
    /// attempt was already cancelled is aborted immediately.
    pub fn attach(&self, handle: tauri::async_runtime::JoinHandle<()>) {
        let Ok(mut abort) = self.abort.lock() else {
            handle.abort();
            return;
        };
        if self.revoked.load(Ordering::Acquire) {
            handle.abort();
            return;
        }
        *abort = Some(handle);
    }
    pub fn cancelled(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }
}

/// The committed per-host permission state derived from the settings record.
pub struct PolicyState {
    leases: Vec<Arc<HostLease>>,
}

impl PolicyState {
    pub fn authorize(&self, host: &str) -> Option<Arc<HostLease>> {
        self.leases
            .iter()
            .find(|lease| lease.host == host && lease.live())
            .cloned()
    }
    pub fn hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = self.leases.iter().map(|lease| lease.host.clone()).collect();
        hosts.sort();
        hosts
    }
    pub fn leases_live(&self, leases: &[Arc<HostLease>]) -> bool {
        leases.iter().all(|lease| lease.live())
    }
    /// Replaces the committed host set. A removed host is revoked permanently
    /// and its pending jobs are cancelled; a re-added host receives a new
    /// lease identity so old results can never be reused.
    pub fn replace_hosts(&mut self, hosts: &[String]) {
        for lease in &self.leases {
            if !hosts.iter().any(|host| host == &lease.host) {
                lease.revoke();
                lease.cancel_jobs();
            }
        }
        let mut next: Vec<Arc<HostLease>> = Vec::new();
        for host in hosts {
            match self.leases.iter().find(|lease| &lease.host == host) {
                Some(existing) => next.push(existing.clone()),
                None => {
                    next.push(Arc::new(HostLease {
                        host: host.clone(),
                        revoked: AtomicBool::new(false),
                        jobs: Mutex::new(Vec::new()),
                    }));
                }
            }
        }
        self.leases = next;
    }
}

/// The application-wide committed permission owner.
pub struct Policy {
    state: Mutex<PolicyState>,
}

impl Policy {
    pub fn new(hosts: &[String]) -> Self {
        let mut state = PolicyState { leases: Vec::new() };
        state.replace_hosts(hosts);
        Self {
            state: Mutex::new(state),
        }
    }
    /// The single short-held committed-policy guard. Removal, request
    /// admission and final publication all serialize on it.
    pub fn guard(&self) -> MutexGuard<'_, PolicyState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    pub fn authorize(&self, host: &str) -> Option<Arc<HostLease>> {
        self.guard().authorize(host)
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The validated bytes of one remote image plus the leases that authorized it.
pub struct Fetched {
    pub bytes: Arc<Vec<u8>>,
    pub mime: &'static str,
    pub hosts: Vec<String>,
    pub leases: Vec<Arc<HostLease>>,
    pub permits: Arc<OwnedSemaphorePermit>,
}

fn operations() -> &'static Arc<Semaphore> {
    static OPERATIONS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Arc::new(Semaphore::new(MAX_ACTIVE_OPERATIONS)))
}

fn retained() -> &'static Arc<Semaphore> {
    static RETAINED: OnceLock<Arc<Semaphore>> = OnceLock::new();
    RETAINED.get_or_init(|| Arc::new(Semaphore::new(MAX_RETAINED_BYTES)))
}

/// Installs the ring provider exactly once. A failure is remote-image
/// unavailability, never an application startup failure.
fn ensure_provider() -> Result<(), ()> {
    static PROVIDER: OnceLock<bool> = OnceLock::new();
    let installed = *PROVIDER.get_or_init(|| {
        match rustls::crypto::ring::default_provider().install_default() {
            Ok(()) => true,
            Err(_) => rustls::crypto::CryptoProvider::get_default().is_some(),
        }
    });
    if installed { Ok(()) } else { Err(()) }
}

/// One shared client. Automatic redirects, proxies, referers, cookies and
/// compressed bodies are all disabled; certificate and name verification
/// stay enabled through the ordinary platform verifier.
fn client() -> Result<&'static reqwest::Client, RemoteError> {
    static CLIENT: OnceLock<Result<reqwest::Client, ()>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            ensure_provider().map_err(|_| ())?;
            reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .referer(false)
                .no_proxy()
                .retry(reqwest::retry::never())
                .http1_only()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .build()
                .map_err(|_| ())
        })
        .as_ref()
        .map_err(|_| RemoteError::new(RemoteErrorKind::Tls, None))
}

fn is_redirect(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::MOVED_PERMANENTLY
            | reqwest::StatusCode::FOUND
            | reqwest::StatusCode::SEE_OTHER
            | reqwest::StatusCode::TEMPORARY_REDIRECT
            | reqwest::StatusCode::PERMANENT_REDIRECT
    )
}

fn network(_error: reqwest::Error) -> RemoteError {
    RemoteError::new(RemoteErrorKind::Network, None)
}

/// Classifies a transport failure without exposing the request URL.
fn classify(error: &reqwest::Error, host: Option<&str>) -> RemoteError {
    let host = host.map(|value| value.to_owned());
    if error.is_timeout() {
        return RemoteError::new(RemoteErrorKind::Timeout, host);
    }
    if is_tls_failure(error) {
        return RemoteError::new(RemoteErrorKind::Tls, host);
    }
    if error.is_body() || error.is_decode() {
        return RemoteError::new(RemoteErrorKind::Network, host);
    }
    RemoteError::new(RemoteErrorKind::Network, host)
}

fn is_tls_failure(error: &reqwest::Error) -> bool {
    let mut source = error.source();
    while let Some(current) = source {
        let text = current.to_string().to_ascii_lowercase();
        if text.contains("certificate")
            || text.contains("handshake")
            || text.contains("tls alert")
            || text.contains("invalid peer")
        {
            return true;
        }
        source = current.source();
    }
    false
}

/// Reads exactly one usable `Location` header.
fn single_location(response: &reqwest::Response) -> Result<String, RemoteError> {
    let values: Vec<_> = response
        .headers()
        .get_all(reqwest::header::LOCATION)
        .iter()
        .collect();
    if values.len() != 1 {
        return Err(invalid());
    }
    let text = values[0].to_str().map_err(|_| invalid())?;
    Ok(text.to_owned())
}

/// Resolves one redirect destination and validates it before any request.
fn resolve_redirect(current: &Url, location: &str) -> Result<Url, RemoteError> {
    let trimmed = location.trim();
    if trimmed.is_empty()
        || trimmed
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        || trimmed.contains('\\')
    {
        return Err(invalid());
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        check_authority(&rest[..end])?;
        return Ok(parse_image_url(trimmed)?.url);
    }
    if let Some(rest) = trimmed.strip_prefix("//") {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        check_authority(&rest[..end])?;
    }
    let mut joined = current.join(trimmed).map_err(|_| invalid())?;
    joined.set_fragment(None);
    validate_parsed(&joined)?;
    Ok(joined)
}

fn image_mime(headers: &reqwest::header::HeaderMap) -> Result<&'static str, RemoteError> {
    let values: Vec<_> = headers
        .get_all(reqwest::header::CONTENT_TYPE)
        .iter()
        .collect();
    if values.len() != 1 {
        return Err(RemoteError::new(RemoteErrorKind::Unsupported, None));
    }
    let raw = values[0]
        .to_str()
        .map_err(|_| RemoteError::new(RemoteErrorKind::Unsupported, None))?;
    let token = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Ok(match token.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        "image/avif" => "image/avif",
        "image/svg+xml" => "image/svg+xml",
        _ => return Err(RemoteError::new(RemoteErrorKind::Unsupported, None)),
    })
}

/// Compressed bodies are refused; only an absent or identity encoding passes.
fn check_encoding(headers: &reqwest::header::HeaderMap) -> Result<(), RemoteError> {
    let values: Vec<_> = headers
        .get_all(reqwest::header::CONTENT_ENCODING)
        .iter()
        .collect();
    if values.len() > 1 {
        return Err(RemoteError::new(RemoteErrorKind::Unsupported, None));
    }
    if let Some(value) = values.first() {
        let text = value.to_str().unwrap_or("").trim().to_ascii_lowercase();
        if !text.is_empty() && text != "identity" {
            return Err(RemoteError::new(RemoteErrorKind::Unsupported, None));
        }
    }
    Ok(())
}

/// The received-body ceiling of one image attempt.
fn body_limit(total: usize) -> Result<(), RemoteError> {
    if total > MAX_BODY_BYTES {
        return Err(RemoteError::new(RemoteErrorKind::Budget, None));
    }
    Ok(())
}

/// Counts the redirect hops of one attempt and detects repeated targets.
pub struct RedirectChain {
    hops: usize,
    visited: HashSet<String>,
}

impl RedirectChain {
    pub fn new(start: &Url) -> Self {
        let mut visited = HashSet::new();
        visited.insert(start.as_str().to_owned());
        Self { hops: 0, visited }
    }
    /// Admits one further hop under the confirmed hop bound and the repeat
    /// rule. The destination is not requested until it is admitted.
    pub fn admit(&mut self, next: &Url) -> Result<(), RemoteError> {
        self.hops += 1;
        if self.hops > MAX_REDIRECTS {
            return Err(RemoteError::new(RemoteErrorKind::RedirectLimit, None));
        }
        if !self.visited.insert(next.as_str().to_owned()) {
            return Err(RemoteError::new(RemoteErrorKind::RedirectLimit, None));
        }
        Ok(())
    }
}

/// Counts the received body against the shared retained-byte budget.
async fn read_body(
    mut response: reqwest::Response,
) -> Result<(Vec<u8>, OwnedSemaphorePermit), RemoteError> {
    let mut body: Vec<u8> = Vec::new();
    let mut permit: Option<OwnedSemaphorePermit> = None;
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        let length = chunk.len();
        if length == 0 {
            continue;
        }
        body_limit(body.len().saturating_add(length))?;
        let acquired = retained()
            .clone()
            .try_acquire_many_owned(u32::try_from(length).unwrap_or(u32::MAX))
            .map_err(|_| RemoteError::new(RemoteErrorKind::Budget, None))?;
        match permit.as_mut() {
            Some(existing) => existing.merge(acquired),
            None => permit = Some(acquired),
        }
        body.try_reserve(length)
            .map_err(|_| RemoteError::new(RemoteErrorKind::Budget, None))?;
        body.extend_from_slice(&chunk);
    }
    let permit = permit.ok_or_else(|| RemoteError::new(RemoteErrorKind::Unsupported, None))?;
    Ok((body, permit))
}

/// A type guard, not a decoder: the payload must carry the envelope of the
/// declared image family before it may reach the engine.
fn envelope_matches(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/avif" => {
            bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
        }
        "image/svg+xml" => svg_root(bytes),
        _ => false,
    }
}

/// Requires the first root element to be `svg` in the SVG namespace.
fn svg_root(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = quick_xml::reader::NsReader::from_str(text);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_resolved_event() {
            Ok((resolve, event)) => match event {
                quick_xml::events::Event::Start(start) | quick_xml::events::Event::Empty(start) => {
                    return start.local_name().as_ref() == "svg"
                        && matches!(
                            resolve,
                            quick_xml::name::ResolveResult::Bound(namespace)
                                if namespace.as_ref() == SVG_NAMESPACE
                        );
                }
                quick_xml::events::Event::DocType(_) => return false,
                quick_xml::events::Event::Eof => return false,
                _ => {}
            },
            Err(_) => return false,
        }
    }
}

/// Runs one attempt under the whole-operation deadline. The deadline covers
/// queue wait, every redirect and the whole body.
async fn bounded<T>(
    deadline: tokio::time::Instant,
    work: impl std::future::Future<Output = Result<T, RemoteError>>,
) -> Result<T, RemoteError> {
    match tokio::time::timeout_at(deadline, work).await {
        Ok(result) => result,
        Err(_) => Err(RemoteError::new(RemoteErrorKind::Timeout, None)),
    }
}

/// Fetches one authorized image, following only authorized redirect hops.
///
/// The effective policy is checked before the initial request and before
/// every redirect hop. A denial prevents the request rather than hiding its
/// result.
pub async fn fetch(
    policy: &Policy,
    target: &RemoteTarget,
    lease: Arc<HostLease>,
    signal: Arc<JobSignal>,
) -> Result<Fetched, RemoteError> {
    if signal.cancelled() {
        return Err(RemoteError::new(RemoteErrorKind::Stale, None));
    }
    let client = client()?;
    let deadline = tokio::time::Instant::now() + ATTEMPT_BUDGET;
    let work = async {
        let _operation = operations()
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| RemoteError::new(RemoteErrorKind::Budget, None))?;
        let mut current = target.url.clone();
        let mut hosts = vec![target.host.clone()];
        let mut leases = vec![lease.clone()];
        let mut chain = RedirectChain::new(&current);
        loop {
            if signal.cancelled() {
                return Err(RemoteError::new(RemoteErrorKind::Stale, None));
            }
            let host = hosts.last().cloned().unwrap_or_default();
            // The lease must still be live at admission: a removal between
            // the authorization and this request must stop it.
            if !leases.last().is_some_and(|lease| lease.live()) {
                return Err(RemoteError::new(RemoteErrorKind::BlockedHost, Some(host)));
            }
            let response = client
                .get(current.clone())
                .header(reqwest::header::ACCEPT, IMAGE_ACCEPT)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|error| classify(&error, Some(&host)))?;
            let status = response.status();
            if is_redirect(status) {
                let location = single_location(&response)?;
                let mut next = resolve_redirect(&current, &location)?;
                next.set_fragment(None);
                chain
                    .admit(&next)
                    .map_err(|error| RemoteError::new(error.kind, Some(host.clone())))?;
                let next_host = validate_parsed(&next)?;
                let next_lease = policy.authorize(&next_host).ok_or_else(|| {
                    RemoteError::new(RemoteErrorKind::RedirectBlocked, Some(next_host.clone()))
                })?;
                hosts.push(next_host);
                leases.push(next_lease);
                current = next;
                continue;
            }
            if status != reqwest::StatusCode::OK {
                return Err(RemoteError::new(RemoteErrorKind::Status, Some(host)));
            }
            check_encoding(response.headers())?;
            let mime = image_mime(response.headers())?;
            if response
                .content_length()
                .is_some_and(|length| length as usize > MAX_BODY_BYTES)
            {
                return Err(RemoteError::new(RemoteErrorKind::Budget, Some(host)));
            }
            let (bytes, mut permits) = read_body(response).await?;
            if !envelope_matches(mime, &bytes) {
                return Err(RemoteError::new(RemoteErrorKind::Unsupported, Some(host)));
            }
            // The served representation is an owned copy of the retained body,
            // so the copy is charged against the same aggregate budget.
            let copy = retained()
                .clone()
                .try_acquire_many_owned(u32::try_from(bytes.len()).unwrap_or(u32::MAX))
                .map_err(|_| RemoteError::new(RemoteErrorKind::Budget, Some(host)))?;
            permits.merge(copy);
            return Ok(Fetched {
                bytes: Arc::new(bytes),
                mime,
                hosts,
                leases,
                permits: Arc::new(permits),
            });
        }
    };
    bounded(deadline, work).await
}

#[cfg(test)]
mod tests;
