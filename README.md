# MDViewerRSX

A local, read-only document reader. Copyright © 2026 Chrysent. MIT licensed.

## Current reader

Open a UTF-8 `.md`, `.markdown`, `.mdown`, `.mkd` or `.mkdown` file using the native **File → Open File…** menu (⌘O on macOS, Ctrl+O elsewhere). Extension matching is case-insensitive. `.txt` and `.log` display literally and never enter Markdown parsing. MDX is not supported.

Markdown uses a bundled worker and one inert sanitizer boundary. Frontmatter appears as read-only metadata, fenced code uses bundled highlighting, and footnotes/heading links focus their exact destinations. Task boxes remain disabled. Local images and native audio/video controls use revocable, read-only media grants within the active document's canonical directory; remote resources, document CSS and automatic navigation stay blocked. Missing, denied or undecodable media shows feedback beside that resource without hiding the article. No network service is required. Try `examples/rich-text.md`, `examples/reading.md` and `examples/literal.txt` offline.

Only a real pointer or Enter activation can request a permitted external HTTP/HTTPS/mail/telephone handoff through the default OS application. The reader reports acknowledgement, not that an external page loaded. Local supported-document links use the normal read/format/commit transaction and currently replace the focused reader; opening/focusing a separate document window remains a later feature. A denied link does not grant a new directory or automatically open a chooser. Caption tracks and untrusted `srcset` are inactive with visible fallback; external SVG is image-only, never inline document markup.

The compact bottom status describes the displayed file, not the pending selection. **View → Show Status Bar** hides or shows it and remembers the choice; it starts visible. **File → Document Information…** exposes the displayed file's full selectable path, name, type, read-only and stale state, even when status is hidden. Reload reads the granted file again. Failed replacement or reload preserves the last good document and marks it stale. Conditional recovery stays available outside the article and hidden status, including supported Cancel and preference Retry. Cancel never changes the displayed source and is unavailable during the final display commit; it cannot interrupt a blocked engine. There are no document write commands.

**Help → User Guide** opens bundled Markdown without replacing the active file, borrowing its media grants, reparsing it or deliberately pausing playback. Guide, Settings, Document Information and About share one temporary dialog slot, with Close, composition-aware Escape, link-inclusive Tab traversal and reading-focus restoration. Guide is unavailable during pending reading so Cancel cannot be stranded behind it. About reports the product version and MIT ownership, not distribution qualification.

Folder browsing, diagrams, directory navigation, search, exports, multiple document windows and OS file associations are not yet implemented; their current limits are documented in the guide rather than advertised by disabled reader controls. This version is not a claim of full-feature parity.

## Appearance and preferences

Open **Settings…** from the macOS application menu or the Settings menu on other platforms (Cmd+, on macOS, Ctrl+, elsewhere). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS; forced Light/Dark selects the corresponding saved palette slot. Both selectors always offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord—even a dark-toned palette in the Light slot or a light-toned palette in the Dark slot.

Page zoom scales reading content only, from 50% to 300% in 10-point steps, with reset to 100%. The native View menu provides the same actions (Cmd/Ctrl+=, Cmd/Ctrl+−, Cmd/Ctrl+0). Fit diagrams and sidebar-default checkboxes are saved preferences; their consuming features are not available yet.

Preferences are stored only in `settings-v1.json` under the application's configuration directory, never beside a source document. Valid fields survive a partially invalid record; missing/invalid fields use defaults with a visible notice, except a valid older record missing only status visibility receives the new default `true` without a corruption notice. Saves are revisioned and atomically replaced. If saving or synchronization fails, the current appearance remains applied for now and **Retry preferences** is available; that state does not claim persistence. Appearance changes do not reload or reparse the document.

## Develop

Use Node 22.22.2, npm 11.6.2, Rust 1.97.1 with rustfmt/Clippy, Git, and Gitleaks **8.30.1**. npm 10.9.7 hit an optional-peer resolution error on the initial unlocked install; npm 11.6.2 resolves the dependency set without disabling peer validation. Both lockfiles are supplied with the application sources.

Install the platform Tauri prerequisites: Xcode command-line tools on macOS; the MSVC build tools and Evergreen WebView2 on Windows; WebKitGTK 4.1 and the Tauri Linux development libraries on Ubuntu. See https://v2.tauri.app/start/prerequisites/ .

```sh
npm ci
npm run hooks:install
npm run tauri -- dev
```

Hook installation is **explicit**, not an npm lifecycle side effect. It preserves existing hooks and stops when automatic integration would be unsafe. See `CONTRIBUTING.md` before installing in a shared or customized checkout.

```sh
npm run build
npm run tauri -- build --no-bundle --ci --no-sign
```

The second command produces an unsigned local native executable under `src-tauri/target/release/` (named `mdviewerrsx`, or `mdviewerrsx.exe` on Windows). It does not publish, sign or create an installer. macOS builds explicitly reject non-Apple-Silicon targets and require macOS 14 or later.

Intended support is macOS 14+ Apple Silicon, Windows 11 x64 and Ubuntu 24.04 x86_64/X11/Wayland. Qualification of those targets is separate from a successful local build. Browser WebKit tests are not native WKWebView certification.

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
16. Re-run the source hash command. Original example bytes must be unchanged. Close the reader and check no app-owned helper process remains.

These native checks remain deferred until recorded on actual target systems; compilation and the headless media fixture do not mark them passed.

Automated tests exercise the production native media GET/HEAD/range, lifetime, scoped-path and link-policy seams without invoking OS handlers. Browser tests additionally decode original media, seek, show decode/fallback errors and exercise the actual React shell, controller, native JS adapter and worker with explicit IPC/URL-conversion/HTTP transport doubles. These mocks do not execute the real native chooser, custom protocol, IPC/capability enforcement or native menus. Native dialog, menu, focus, CSP/transport, system-webview codec, OS handoff and visual evidence must still be recorded on actual targets. A build or browser pass alone must not be recorded as a native-interaction pass.

## Dependency notices

`DEPENDENCIES.md` records licensing choices and known notice gaps. `scripts/notices.mjs` generates exact installed npm runtime and local Apple Silicon Cargo closure notices into `src-tauri/target/THIRD_PARTY_NOTICES.md`, including build dependencies. Generated legal texts are distribution artifacts, not authored source; they preserve upstream copyright notices verbatim and are not committed. DOMPurify uses its Apache-2.0 licensing option. Unmodified MPL components retain their separate terms and versioned source links. Some Cargo packages omit license text from their published crates; the notice inventory explicitly identifies those unresolved upstream notices. Resolve those entries and other platform closures before distributing binaries. No third-party source is patched or vendored.
