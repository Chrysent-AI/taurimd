# Development

Setup, checks and qualification material for working on taurimd. The shared check commands and their boundaries are tabulated in [CONTRIBUTING.md](../CONTRIBUTING.md); release preparation, tag validation and outstanding qualification boundaries live in [RELEASING.md](../RELEASING.md).

## Toolchain

The pinned versions are current and supported, not merely working:

- **Node 26.13.0** — `.node-version` holds the version for fnm, and `scripts/check.mjs` re-runs itself under the pinned Node through fnm when the active Node differs. One version therefore runs the gate, the frontend build, the Tauri build and the browser suite; no build can happen on a different Node than the checks that guard it.
- **npm 12.2.1** — npm 12 blocks install scripts by default, so the optional `fsevents` install script is skipped; fsevents only accelerates dev-server file watching on macOS and is not needed to build, test or package. (npm 10.9.7 hit an optional-peer resolution error on the initial unlocked install; npm 11.6.2 and 12.2.1 resolve the dependency set without disabling peer validation.)
- **Rust 1.99.1** with rustfmt and Clippy — pinned by `rust-toolchain.toml` and CI; the declared `rust-version` matches the toolchain the project actually tests.
- **Playwright 1.64.1** for the three-engine browser suite, and **Gitleaks 8.30.1** exactly — missing or wrong scanners fail closed.

Both lockfiles are supplied with the application sources.

## Setup

```sh
npm ci
npm run hooks:install
```

Hook installation is **explicit**, not an npm lifecycle side effect. It preserves existing hooks and stops when automatic integration would be unsafe. See [CONTRIBUTING.md](../CONTRIBUTING.md) before installing in a shared or customized checkout.

Install test browsers once when needed, preserving other users' cached browser versions:

```sh
npm run browsers:install
```

## Building unsigned candidates

```sh
npm run build
npm run tauri -- build --ci --no-sign -- --locked
```

The second command builds unsigned candidates for its native host: Apple Silicon `.app`/DMG, Windows x64 NSIS, or Ubuntu x86_64 DEB and AppImage. It does not publish or sign. macOS builds reject non-Apple-Silicon targets and require macOS 14 or later. Windows 11 requires an installed Evergreen WebView2 runtime; the installer does not download one. Ubuntu 24.04 requires WebKitGTK 4.1 and an X11 or Wayland desktop session. The supported package configurations register only `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdown` for viewing, never MDX, `.txt`, `.log` or generic text. Linux desktop delivery uses file arguments, and Windows association commands quote both executable and filename. Installation, association runtime and secondary-launch behavior require testing on the actual target; generating a package does not certify them. `--no-bundle` remains available for an executable-only development build.

Intended support is macOS 15+ Apple Silicon, Windows 11 x64 and Ubuntu 24.04 x86_64/X11/Wayland. Qualification of those targets is separate from a successful local build. Browser WebKit tests are not native WKWebView certification.

### AppImage candidate

The Ubuntu target produces an AppImage beside the DEB. An AppImage is a single self-contained executable file that bundles the reader and its runtime; the Tauri bundler names it `taurimd_<version>_<arch>.AppImage` — `taurimd_0.1.9_amd64.AppImage` at version 0.1.9 — and writes it to `src-tauri/target/release/bundle/appimage/`. Running an AppImage needs FUSE, or `--appimage-extract-and-run` where FUSE is unavailable. The AppImage does not bundle the extra GStreamer libraries that native audio and video playback need, so playback inside it depends on the libraries the host system already provides. Installation, desktop entry integration, file-association behavior and in-AppImage media playback remain unverified until the authorized native checks below are recorded on an actual Ubuntu target.

### Binstall archives

After a locked native release build, the host `tar` and a Node SHA-256 helper use binstall's default layout, without metadata overrides:

```sh
node scripts/archive.mjs aarch64-apple-darwin
# or x86_64-pc-windows-msvc / x86_64-unknown-linux-gnu on that native host
```

Output is `src-tauri/target/binstall/taurimd-<TARGET>-v<VERSION>.tgz`, with `taurimd-<TARGET>-v<VERSION>/taurimd` (`taurimd.exe` on Windows), README, MIT text and a truthful notices/qualification handoff. Existing output is not overwritten. A `.sha256` sidecar checks corruption, not publisher authenticity. `Cargo.toml` carries `[package.metadata.binstall]` so `cargo binstall taurimd` resolves that exact archive name and finds the binary inside its versioned directory — but only once the archive is attached to a published GitHub release. binstall copies only the executable; it does not install the `.app`, NSIS or DEB candidates, register file associations or provision a system webview. See [RELEASING.md](../RELEASING.md) for the release and publication flow.

## Native smoke checklist

Run the native executable or `npm run tauri -- dev` on the target machine. Record OS/CPU, engine and results; do not substitute a browser screenshot.

1. Record source hashes: `git hash-object examples/reading.md examples/literal.txt examples/rich-text.md`.
2. From the empty reader, use the native File menu/accelerator to open `examples/rich-text.md`. Confirm metadata, highlighted code, disabled tasks, repeated heading/footnote destinations, exact return focus and correct identity. Malformed metadata in a scratch copy must leave the body readable and expose escaped raw YAML.
3. Open `examples/literal.txt`; confirm literal angle brackets/Markdown punctuation and no execution. Cancel another native selection: the displayed document must not change.
4. Reload from the native File menu and accelerator. An external edit to a **scratch copy** must appear only after Reload; preserve reading position where practical.
5. Open an unsupported file or a scratch file containing invalid UTF-8. The prior file and identity remain visible with an attempted-target error and stale indication. Delete a scratch opened file, then Reload: report failure, not success.
6. Cancel a formatting operation and open another file. A late response must not replace the newer document. Check long paths, Tab navigation and visible focus.
7. Open Settings using its native menu and accelerator. Check both palette slots, opposite-toned combinations, System changes, 50/100/300% content zoom, unchanged chrome and reachable final content. Tab/Shift+Tab remain in the dialog; Escape restores prior focus, while IME composition does not close it. Exercise native View zoom actions once each.
8. Change all preferences, wait for **Preferences saved**, close and restart the native application, then verify values survived. Confirm a save failure remains separate from document errors and offers Retry; browser mock hydration is not this restart check.
9. In a scratch folder, create a Markdown document beside copies of the original fixtures in `tests/browser/media/`. Reference `figure.svg`, `tone.wav` and `clip.webm` as local image/audio/video. Confirm native controls, actual supported decoding and repeated seeking under the real application CSP. Record unsupported encodings explicitly; a damaged file must show a content-local error. Exercise HEAD and closed/open/suffix byte ranges through the native protocol, not browser fixture routes.
10. Attempt remote/protocol-relative/data/file/blob references, `srcset`, poster/source/track/CSS fetches, parent-prefix lookalikes, encoded traversal and a symlink escaping that scratch directory. No automatic remote fetch, out-of-scope read, page replacement, new window or download is permitted. Permitted local assets remain read-only.
11. While media is loaded, begin/cancel an Open and fail a replacement/Reload: preserve its node/player and last-good authority. Successful replacement/Reload and reader close revoke old opaque URLs; late resolutions must not repopulate grants. Bytes already buffered by the engine cannot be retracted. Change both palette slots and content zoom: retain playback, selection and disclosure state without reparsing.
12. Use actual pointer/Enter activation for HTTP, HTTPS, mail and telephone links. The OS handler must receive only the permitted URL; handler failure stays separate from Reader/Preferences status. Test a contained document link with a fragment, a missing target and a denied escape; verify requested target focus after a matching commit and last-good recovery on failure. Do not run these OS-handler actions from automated tests.
13. From empty and loaded readers, use File Document Information, View Show Status Bar, Help User Guide and platform About. Check real menu enabled/check states and once-only dispatch, including rapid actions, pending read/commit, modal ownership and IME. Hide status, restart, and verify the applied visibility and native checkmark agree; test applied-but-unsaved failure/Retry and old-record compatibility separately. No automatic path history should be saved.
14. With status hidden, exercise Cancel and failed Open/Reload/preferences/synchronization recovery; full selectable file details and necessary actions remain reachable. If menu subscription fails, direct Open/Settings/applicable Reload is the exceptional fallback. Check one-time meaningful announcements with actual assistive technology, without startup save-success spam or live path chatter.
15. Open/close Guide empty and over a scrolled, playing-media document. Traverse every guide link and Close with Tab/Shift+Tab, composition/Escape and section links; fragments cannot escape into the article. Verify literal guide fallback after parser failure and pending worker disposal on close. Retain article/player nodes, selection, disclosures, time, scroll and focus with no new native document/media call. Inspect Information/About, long paths, narrow 640 layout, 300% reading zoom and all seven palettes in both slots. Actual native transport/menus/IME/AT/restart are not covered by browser doubles.
16. From the file manager, cold-open multiple Markdown files, reopen a canonical/symlink alias, and open additional files while running. Check distinct one-document windows, no target reload, captured relative-path launch directory on Windows/Linux, early delivery and visible recovery for invalid items. In-app Open to a new path replaces only its invoker; an already displayed path focuses its reader. Cached Quick Open/local links create/focus another reader; native Choose File fallback and sidebar/sibling replacement keep their distinct routes. Verify target fragments with Find, modal, native Save and IME owners; no queued navigation or late origin focus steal.
17. Use two readers with independent roots and equal-looking entry IDs. Change committed preferences and exercise failed optimistic persistence/Retry; only settings propagate. Background presentation must not repaint the focused menu checks. Close one reader during scan/read/export preparation and during an atomic save, then quit; the other reader remains usable, owned resources are reaped, and any completed ZIP is reported truthfully. Reopen with no document must not restore history. Install/uninstall the appropriate unsigned candidate and verify Viewer aliases, paths with spaces, public metadata, icons and X11/Wayland integration where available.
18. Re-run the source hash command. Original example bytes must be unchanged. Close the reader and check no app-owned helper process remains.

These native checks remain deferred until recorded on actual target systems; compilation and the headless media fixture do not mark them passed.

Automated tests exercise the production native media GET/HEAD/range, lifetime, scoped-path and link-policy seams without invoking OS handlers. Browser tests additionally decode original media, seek, show decode/fallback errors and exercise the actual React shell, controller, native JS adapter and worker with explicit IPC/URL-conversion/HTTP transport doubles. These mocks do not execute the real native chooser, custom protocol, IPC/capability enforcement or native menus. Native dialog, menu, focus, CSP/transport, system-webview codec, OS handoff and visual evidence must still be recorded on actual targets. A build or browser pass alone must not be recorded as a native-interaction pass.

## Dependency notices

See [RELEASING.md](../RELEASING.md) for human-only version changes, source-package preparation, validated tag-only candidate archives and the outstanding native/legal qualification boundaries. No public crate or release availability is assumed by the release tooling.

[DEPENDENCIES.md](../DEPENDENCIES.md) records licensing choices and known notice gaps. `scripts/notices.mjs` generates exact installed npm runtime and local Apple Silicon Cargo closure notices into `src-tauri/target/THIRD_PARTY_NOTICES.md`, including build dependencies. Generated legal texts are distribution artifacts, not authored source; they preserve upstream copyright notices verbatim and are not committed. DOMPurify uses its Apache-2.0 licensing option. Unmodified MPL components retain their separate terms and versioned source links. Some Cargo packages omit license text from their published crates; the notice inventory explicitly identifies those unresolved upstream notices. Resolve those entries and other platform closures before distributing binaries. No third-party source is patched or vendored.
