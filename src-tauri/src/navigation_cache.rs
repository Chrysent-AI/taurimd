//! One root-lifetime watcher and scan owner. Events are hints, never path grants.
use crate::{
    documents::{AppError, Session},
    navigation::{self, Index},
};
use notify::{Config, EventHandler, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};

pub const RECONCILE: Duration = Duration::from_secs(30);
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub sequence: u64,
    pub scope: u32,
    pub revision: u32,
    pub phase: &'static str,
    pub degraded: bool,
    pub message: String,
    pub scans: u64,
    pub traversals: u64,
    pub entries: usize,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub index: Option<Index>,
    pub status: Status,
}
impl Snapshot {
    pub fn get(session: &Session) -> Self {
        Self {
            index: session.navigation.root.as_ref().map(|root| root.index()),
            status: session.navigation.status.clone(),
        }
    }
}
struct Control {
    stopped: Arc<AtomicBool>,
    dirty: AtomicBool,
    manual: AtomicBool,
    error: AtomicBool,
    directory: Mutex<Option<PathBuf>>,
    wake: SyncSender<()>,
}
impl Control {
    fn wake(&self) {
        let _ = self.wake.try_send(());
    }
    fn dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.wake();
    }
}
// The guard is owned by the production adapter, not by an extra callback clone.
struct Handler {
    control: Arc<Control>,
    released: Option<SyncSender<()>>,
}
impl EventHandler for Handler {
    fn handle_event(&mut self, event: notify::Result<notify::Event>) {
        if self.control.stopped.load(Ordering::Acquire) {
            return;
        }
        match event {
            Ok(event) if event.need_rescan() || !matches!(event.kind, EventKind::Access(_)) => {
                self.control.dirty()
            }
            Ok(_) => {}
            Err(_) => {
                self.control.error.store(true, Ordering::Release);
                self.control.dirty();
            }
        }
    }
}
impl Drop for Handler {
    fn drop(&mut self) {
        if let Some(sender) = self.released.take() {
            let _ = sender.try_send(());
        }
    }
}
struct Watch {
    watcher: RecommendedWatcher,
    released: Receiver<()>,
}
impl Watch {
    fn open(path: &std::path::Path, control: Arc<Control>) -> Result<Self, AppError> {
        // FSEvents' API requires UTF-8. Reconciliation retains native path authority.
        #[cfg(target_os = "macos")]
        if path.to_str().is_none() {
            return Err(AppError::new(
                "unsupported",
                "Live updates require a UTF-8 folder path on this platform.",
            ));
        }
        let (sender, released) = mpsc::sync_channel(1);
        let handler = Handler {
            control,
            released: Some(sender),
        };
        let mut watcher = match RecommendedWatcher::new(handler, watch_config()) {
            Ok(watcher) => watcher,
            Err(_) => {
                let _ = released.recv();
                return Err(AppError::new(
                    "io",
                    "Live updates unavailable; periodic refresh continues.",
                ));
            }
        };
        if watcher.watch(path, RecursiveMode::Recursive).is_err() {
            drop(watcher);
            let _ = released.recv();
            return Err(AppError::new(
                "io",
                "Live updates unavailable; periodic refresh continues.",
            ));
        }
        Ok(Self { watcher, released })
    }
    fn retire(self) {
        drop(self.watcher);
        // Linux/Windows Drop queues stop. Observe callback-owner release; this
        // does not claim to join notify's private driver thread.
        let _ = self.released.recv();
    }
}
fn watch_config() -> Config {
    Config::default().with_follow_symlinks(false)
}
#[derive(Clone)]
pub enum Work {
    Health(bool),
    Scan(Option<PathBuf>, bool),
    Settled,
}
pub struct RootWorker {
    control: Arc<Control>,
    join: Option<JoinHandle<()>>,
}
impl RootWorker {
    pub fn start(
        path: PathBuf,
        lifetime: Arc<AtomicBool>,
        host: impl FnMut(Work) -> bool + Send + 'static,
    ) -> Result<Self, AppError> {
        Self::start_with(path, lifetime, RECONCILE, host)
    }
    fn start_with(
        path: PathBuf,
        lifetime: Arc<AtomicBool>,
        interval: Duration,
        mut host: impl FnMut(Work) -> bool + Send + 'static,
    ) -> Result<Self, AppError> {
        let (wake, receiver) = mpsc::sync_channel(1);
        let control = Arc::new(Control {
            stopped: lifetime,
            dirty: AtomicBool::new(true),
            manual: AtomicBool::new(false),
            error: AtomicBool::new(false),
            directory: Mutex::new(None),
            wake,
        });
        let owned = control.clone();
        let join = thread::Builder::new()
            .name("folder-index".into())
            .spawn(move || {
                let mut watch = None;
                let mut schedule = Schedule::new(Instant::now(), SystemTime::now(), interval);
                let mut initial = true;
                while !owned.stopped.load(Ordering::Acquire) {
                    let now = Instant::now();
                    if owned.error.swap(false, Ordering::AcqRel) {
                        if let Some(old) = watch.take() {
                            Watch::retire(old);
                        }
                        schedule.retry = now + interval;
                        if !host(Work::Health(true)) {
                            break;
                        }
                    }
                    if watch.is_none() && now >= schedule.retry {
                        watch = Watch::open(&path, owned.clone()).ok();
                        schedule.retry = now + interval;
                        if !host(Work::Health(watch.is_none())) {
                            break;
                        }
                    }
                    let manual = owned.manual.swap(false, Ordering::AcqRel);
                    let dirty = owned.dirty.swap(false, Ordering::AcqRel);
                    let directory = owned
                        .directory
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.take());
                    if initial
                        || manual
                        || dirty
                        || schedule.due(now, SystemTime::now())
                        || directory.is_some()
                    {
                        if !host(Work::Scan(
                            if initial || manual || dirty {
                                None
                            } else {
                                directory
                            },
                            watch.is_none(),
                        )) {
                            break;
                        }
                        schedule.scanned(Instant::now(), SystemTime::now());
                        initial = false;
                        if owned.dirty.load(Ordering::Acquire)
                            || owned.manual.load(Ordering::Acquire)
                        {
                            continue;
                        }
                        if !host(Work::Settled) {
                            break;
                        }
                    }
                    let wait = schedule.wait(Instant::now(), watch.is_none());
                    let _ = receiver.recv_timeout(wait);
                }
                owned.stopped.store(true, Ordering::Release);
                if let Some(watch) = watch {
                    watch.retire();
                }
            })
            .map_err(|_| AppError::new("resourceFailure", "Could not start folder indexing."))?;
        Ok(Self {
            control,
            join: Some(join),
        })
    }
    pub fn refresh(&self) {
        self.control.manual.store(true, Ordering::Release);
        self.control.wake();
    }
    pub fn focus(&self) {
        // Wake also checks wall-clock age: monotonic clocks can pause in sleep.
        self.control.wake();
    }
    pub fn directory(&self, path: PathBuf) {
        if let Ok(mut pending) = self.control.directory.lock() {
            *pending = Some(path);
        }
        self.control.wake();
    }
    pub fn stop(&self) {
        self.control.stopped.store(true, Ordering::Release);
        self.control.wake();
    }
    pub fn retire(mut self) {
        self.stop();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
impl Drop for RootWorker {
    fn drop(&mut self) {
        self.stop();
        // Owners extract the worker before joining, outside ReaderState.
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
struct Schedule {
    next: Instant,
    retry: Instant,
    interval: Duration,
    last_wall: SystemTime,
}
impl Schedule {
    fn new(now: Instant, wall: SystemTime, interval: Duration) -> Self {
        Self {
            next: now,
            retry: now,
            interval,
            last_wall: wall,
        }
    }
    fn due(&self, now: Instant, wall: SystemTime) -> bool {
        now >= self.next
            || wall
                .duration_since(self.last_wall)
                .is_ok_and(|age| age >= self.interval)
    }
    fn scanned(&mut self, now: Instant, wall: SystemTime) {
        self.next = now + self.interval;
        self.last_wall = wall;
    }
    fn wait(&self, now: Instant, degraded: bool) -> Duration {
        (if degraded {
            self.next.min(self.retry)
        } else {
            self.next
        })
        .saturating_duration_since(now)
    }
}
// Both the Tauri host and native lifecycle tests use this publication seam.
pub fn apply(state: &Mutex<Session>, id: u32, work: Work, emit: impl Fn(Status)) -> bool {
    let result = (|| -> Result<(), AppError> {
        let draft = {
            let mut session = state.lock().map_err(|_| Session::stale())?;
            let nav = &mut session.navigation;
            let root = nav
                .root
                .as_ref()
                .filter(|root| root.id == id)
                .ok_or_else(Session::stale)?;
            let path = root.path.clone();
            match &work {
                Work::Health(degraded) => {
                    nav.status.degraded = *degraded;
                    None
                }
                Work::Settled => {
                    if nav.status.phase != "unavailable" {
                        nav.status.phase = if root.index().issues.is_empty() {
                            "ready"
                        } else {
                            "partial"
                        };
                    }
                    None
                }
                Work::Scan(directory, degraded) => {
                    nav.status.degraded = *degraded;
                    nav.status.phase = "loading";
                    let draft = nav.start(path, true, true)?;
                    nav.status.revision = draft.revision;
                    if directory.is_some() {
                        nav.status.traversals += 1;
                    } else {
                        nav.status.scans += 1;
                    }
                    Some(draft)
                }
            }
        };
        announce(state, id, &emit)?;
        if let Some(draft) = draft {
            let result = match work {
                Work::Scan(Some(path), _) => navigation::scan_directory(draft, path),
                _ => navigation::scan_progress(draft, true, |entries| {
                    if let Ok(mut session) = state.lock() {
                        let nav = &mut session.navigation;
                        if nav.root.as_ref().is_some_and(|root| root.id == id) {
                            nav.status.entries = entries;
                        }
                    }
                    let _ = announce(state, id, &emit);
                }),
            };
            let mut session = state.lock().map_err(|_| Session::stale())?;
            let nav = &mut session.navigation;
            if nav.root.as_ref().is_none_or(|root| root.id != id) {
                return Err(Session::stale());
            }
            match result {
                Ok(scope) => {
                    nav.status.entries = scope.records.len();
                    nav.publish(scope)?;
                    nav.status.message.clear();
                }
                Err(error) if error.code == "stale" => return Err(error),
                Err(error) => {
                    nav.status.phase = "unavailable";
                    nav.status.message = error.message;
                }
            }
            drop(session);
            announce(state, id, &emit)?;
        }
        Ok(())
    })();
    result.is_ok()
}
fn announce(state: &Mutex<Session>, id: u32, emit: &impl Fn(Status)) -> Result<(), AppError> {
    let (status, lifetime) = {
        let mut session = state.lock().map_err(|_| Session::stale())?;
        let nav = &mut session.navigation;
        let root = nav
            .root
            .as_ref()
            .filter(|root| root.id == id)
            .ok_or_else(Session::stale)?;
        nav.status.scope = id;
        nav.status.revision = root.revision;
        nav.status.sequence += 1;
        (nav.status.clone(), root.lifetime.clone())
    };
    if lifetime.load(Ordering::Acquire) {
        return Err(Session::stale());
    }
    emit(status);
    Ok(())
}
#[cfg(test)]
mod tests;
