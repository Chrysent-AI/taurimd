# MDViewerRSX

A local, read-only document reader. Copyright © 2026 Chrysent. MIT licensed.

## Current reader

Open a UTF-8 `.md`, `.markdown`, `.mdown`, `.mkd` or `.mkdown` file using **Open File** or the native File menu. Extension matching is case-insensitive. `.txt` and `.log` display literally and never enter Markdown parsing. MDX is not supported.

Markdown uses a bundled worker and sanitizer. Tasks are disabled, and all document URLs, embedded resources and document CSS are inactive. A visible note explains this intermediate restriction. No network service is required. Try `examples/reading.md` and `examples/literal.txt` offline.

The identity area describes the displayed file, not the pending selection. Reload reads the granted file again. Failed replacement or reload preserves the last good document and marks it stale. Cancel never changes the displayed source. There are no document write commands.

Folder browsing, rich metadata/media/link handling, highlighting, footnotes, diagrams, navigation, search, exports and OS file associations are not yet implemented. Open Folder is explicitly unavailable rather than a dead enabled control. This version is not a claim of full-feature parity.

## Appearance and preferences

Open **Settings…** from the reader or native menu (Cmd+, on macOS, Ctrl+, elsewhere). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS; forced Light/Dark selects the corresponding saved palette slot. Both selectors always offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord—even a dark-toned palette in the Light slot or a light-toned palette in the Dark slot.

Page zoom scales reading content only, from 50% to 300% in 10-point steps, with reset to 100%. The native View menu provides the same actions (Cmd/Ctrl+=, Cmd/Ctrl+−, Cmd/Ctrl+0). Fit diagrams and sidebar-default checkboxes are saved preferences; their consuming features are not available yet.

Preferences are stored only in `settings-v1.json` under the application's configuration directory, never beside a source document. Valid fields survive a partially invalid record; missing/invalid fields use defaults with a visible notice. Saves are revisioned and atomically replaced. If saving or synchronization fails, the current appearance remains applied for now and **Retry preferences** is available; that state does not claim persistence. Appearance changes do not reload or reparse the document.

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

1. Record source hashes: `git hash-object examples/reading.md examples/literal.txt`.
2. From the empty reader, use the native File menu/accelerator to open `examples/reading.md`. Confirm formatted headings, table and disabled tasks; correct identity; reading focus; no active links/media.
3. Open `examples/literal.txt`; confirm literal angle brackets/Markdown punctuation and no execution. Cancel another native selection: the displayed document must not change.
4. Reload from the visible control and native accelerator. An external edit to a **scratch copy** must appear only after Reload; preserve reading position where practical.
5. Open an unsupported file or a scratch file containing invalid UTF-8. The prior file and identity remain visible with an attempted-target error and stale indication. Delete a scratch opened file, then Reload: report failure, not success.
6. Cancel a formatting operation and open another file. A late response must not replace the newer document. Check long paths, Tab navigation and visible focus.
7. Open Settings using the button and native accelerator. Check both palette slots, opposite-toned combinations, System changes, 50/100/300% content zoom, unchanged chrome and reachable final content. Tab/Shift+Tab remain in the dialog; Escape restores prior focus, while IME composition does not close it. Exercise native View zoom actions once each.
8. Change all preferences, wait for **Preferences saved**, close and restart the native application, then verify values survived. Confirm a save failure remains separate from document errors and offers Retry; browser mock hydration is not this restart check.
9. Re-run the source hash command. Original example bytes must be unchanged. Close the reader and check no app-owned helper process remains.

Automated tests exercise native read/state/response-serialization seams and the actual React shell, controller, native JS adapter and worker in browsers with a mocked native backend. These mocks do not execute the real native chooser, IPC/capability enforcement or native menus. Native dialog, menu, focus and visual evidence must still be recorded on actual targets. A build or browser pass alone must not be recorded as a native-interaction pass.

## Dependency notices

`DEPENDENCIES.md` records licensing choices and known notice gaps. `scripts/notices.mjs` generates exact installed npm runtime and local Apple Silicon Cargo closure notices into `src-tauri/target/THIRD_PARTY_NOTICES.md`, including build dependencies. Generated legal texts are distribution artifacts, not authored source; they preserve upstream copyright notices verbatim and are not committed. DOMPurify uses its Apache-2.0 licensing option. Unmodified MPL components retain their separate terms and versioned source links. Some Cargo packages omit license text from their published crates; the notice inventory explicitly identifies those unresolved upstream notices. Resolve those entries and other platform closures before distributing binaries. No third-party source is patched or vendored.
