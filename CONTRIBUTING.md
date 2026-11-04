# Contributing

Use the pinned toolchain in `README.md`, install with `npm ci`, then run the explicit installer:

```sh
npm run hooks:install
```

The installer queries Git's effective hook path on every run, including linked-worktree common hooks and repository-local custom paths. Dispatchers discover the invoking checkout at execution time; no machine path is stored. Existing or managed protection is never silently wrapped or replaced. Unknown hooks, symlink routes and routes outside the project stop installation; integrate the shared commands through the existing route's owner instead. No Git configuration or identity is changed. Re-running the installer accepts only an identical executable managed dispatcher.

To remove protection, first identify the effective route with `git rev-parse --git-path hooks`. Remove only dispatchers that exactly match the managed templates in `scripts/hooks.mjs`; never remove someone else's protection. Removing hooks does not remove independent CI checks.

## Shared checks

| Command                                | Boundary                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run format:check`                 | Prettier, no fixes                                                                                  |
| `npm run lint`                         | Strict typed ESLint, React hooks and accessibility checks, including helper scripts                 |
| `npm run typecheck`                    | Strict TypeScript build-mode check                                                                  |
| `npm run build`                        | Bundled Vite frontend and worker                                                                    |
| `npm test`                             | Production parser/sanitizer, controller and article/component tests                                 |
| `npm run test:hooks`                   | Isolated synthetic Git repositories: staged/range/message scans, merge/root history and hook routes |
| `npm run check:rust`                   | Locked Rust format, Clippy (`-D warnings`), tests, build; run frontend build first                  |
| `npm run test:browser`                 | Chromium, Firefox and WebKit worker/sanitizer/offline tests; browser, not native, evidence          |
| `npm run check:local`                  | Tool preflight, frontend checks, hook fixtures, Rust group                                          |
| `npm run check:commit -- message-file` | Full-message scan, then strict Conventional Commits                                                 |

Foreign-repository fixture commands clear the repository-local Git variable names reported by `git rev-parse --local-env-vars` from their child environment, after caller options are applied. Changing only `cwd` is not isolation inside a Git hook. The owned-context regression runs representative protection tests inside a disposable outer repository's actual hook and checks that its HEAD, refs, staged index, config and worktree registrations do not change. Production hooks deliberately retain Git's invoking context so staged scanning still inspects the intended index.

Install test browsers once when needed, preserving other users' cached browser versions:

```sh
npm run browsers:install
```

This cross-platform entrypoint invokes the installed Playwright CLI directly and always sets `PLAYWRIGHT_SKIP_BROWSER_GC=1`, overriding a conflicting inherited value. CI uses `npm run browsers:install -- --with-deps` for its disposable Linux host. No force/uninstall arguments are supported. Provision only when a browser is missing; running the tests does not provision browsers. Each browser run uses one run-owned server on a kernel-assigned port and closes it on teardown. Fixtures are synthetic and do not require real credentials. Browser binaries are test tools, not bundled runtime assets.

CI's disposable Linux browser job additionally installs the authenticated Noble PulseAudio daemon/client utilities and wraps the same `npm run test:browser` command with `scripts/ci-browser-audio.mjs`. One private authenticated Unix endpoint and clocked null output sink serve the whole run; the daemon and browser stay unprivileged, and private files/groups are reaped on completion or caught interruption. It exercises normal browser decoding and clock progression, not speaker audibility or native audio hardware. Local browser commands do not install or start audio services. The wrapper retains selected endpoint/stream/cleanup evidence in the job log and `test-results/ci-audio.log`; it relies on the pinned Playwright launch records from `DEBUG=pw:browser` to own its separately detached browser groups as well as the command group.

The shell browser fixture mounts the actual React App, reader controller, native JS adapter and worker. Tauri's test mocks supply native command responses and menu events; they do not execute the Rust backend, native file chooser, real IPC/capabilities or system-webview menus. Its screenshots are browser evidence only.

Pre-commit first uses Gitleaks' own Git staged-diff traversal, then runs `check:local`. These compilation/tests inspect **working-tree files**, not an isolated staged snapshot. Partial staging and untracked work are permitted. Commit-msg scans the **entire message** including body/footer, then validates Conventional Commits with default ignore shortcuts disabled. Merge/revert-like subjects are not automatically exempt.

Gitleaks must be exactly 8.30.1. Missing/wrong scanners, unreadable/malformed configuration and any scanner error fail closed. The explicit project configuration extends upstream defaults with generic privacy patterns. Project ignore files and inline allow comments cannot bypass these scans. Detectors still cannot prove the absence of every possible secret. Staged/range scans cover introduced diff content, **not unchanged portions of changed files**. Full-message coverage is separate.

CI runs the same shared local gate as a pre-commit; it performs no independent secret scan of introduced PR or push ranges or of commit messages. Secret scanning is local-only: the pre-commit hook scans the staged diff and the commit-msg hook scans the entire message. The hook-protection test suite inside the gate still exercises the pinned scanner directly, including root/merge-parent range fixtures over complete ancestry, so CI checkouts keep full history and missing/shallow ancestry fails instead of shrinking coverage. The initial test case intentionally includes the root. Exactly one existing commit, `9116eedb060c327c637f8556d88eea18cc098e94`, is grandfathered for historical Conventional Commits formatting only. Its complete message and root-inclusive content/history are still secret-scanned by the protection tests before any format exception applies. No subject/prefix exemption or history rewrite is used. Every other commit hash and every proposed commit message, including a new `init`, remains strict.

CI uses the same quality commands. Browser tests and unsigned native release builds are separately owned jobs; macOS rejects Intel hosts/targets. The first-party runner image table lists `macos-15` as arm64: https://github.com/actions/runner-images/blob/4da2307112a0fad2fd2ecaca8ba7d08683b8c581/README.md#available-images . The runtime architecture guard remains in place; no Intel job is selected. Repository YAML does not prove remote execution or required-check/branch-protection settings. No publish or deployment job exists.

## Manual Cargo build cleanup

GNU Make with a POSIX shell is an optional convenience, not a Windows prerequisite. Bare `make` only prints help. Preview first, then explicitly clean a checkout that is not building or running validation:

```sh
make clean-builds-preview
make clean-builds
# Select a different checkout, including paths with spaces:
make clean-builds-preview WORKTREE="../completed checkout"
make clean-builds WORKTREE="../completed checkout"
```

`WORKTREE` defaults to the current checkout. Cleanup removes its `src-tauri/target/debug` and `release` outputs, plus the same profiles under existing targets recognized by `rustc --print target-list`. It preserves sibling `native-candidates`, `THIRD_PARTY_NOTICES.md`, documentation, custom profiles, evidence, source, npm/browser caches and other checkouts. Files inside a removed build profile are build outputs, so keep retained evidence outside those profiles. Cleanup is never automatic; the next Cargo validation/build will rebuild cold. Preview lists Cargo's proposed removals without changing the checkout.

Without Make, run Cargo directly from the selected checkout:

```sh
cargo clean --frozen --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target --config 'build.build-dir="src-tauri/target"' --profile dev
cargo clean --frozen --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target --config 'build.build-dir="src-tauri/target"' --profile release
```

These commands pin both output locations, overriding inherited Cargo directory configuration. For existing target-specific outputs, repeat both commands with `build.build-dir` set to `src-tauri/target/<triple>` (use a target from `rustc --print target-list`), leaving `--target-dir` unchanged. Cargo 1.99.1 ignores `--target` for whole-profile cleaning; the Make targets instead scope Cargo's build directory for each target. They also disable Cargo's compiler-info cache writes during preview. Nonstandard custom-target directories are left untouched. No worktree, global cache, retained candidate or notice cleanup is performed.

## Application artwork

The taurimd application, Markdown document associations and README reuse the same artwork. The committed 1024 × 1024 RGBA master uses transparent contain fitting, preserving the complete source without stretching or cropping. The 512 PNG is shared by the README and Linux packaging; Windows uses the embedded multi-size ICO, and macOS uses the ICNS for both application and document types.

To regenerate with the pinned Tauri CLI, set `input` to the source PNG outside the checkout, then run from the repository root:

```sh
scratch=$(mktemp -d)
npm run tauri -- icon "${input:?Set input to the source PNG}" --fit contain --png 1024 --output "$scratch/master"
cp "$scratch/master/1024x1024.png" src-tauri/icons/logo-master.png
npm run tauri -- icon src-tauri/icons/logo-master.png --output "$scratch/native"
npm run tauri -- icon src-tauri/icons/logo-master.png --png 512 --output "$scratch/png"
cp "$scratch/native/icon.ico" "$scratch/native/icon.icns" src-tauri/icons/
cp "$scratch/png/512x512.png" src-tauri/icons/icon.png
```

Retain only those four assets, not the CLI's mobile/Store output. Inspect PNG metadata and alpha and the actual ICO/ICNS frames before replacing the committed files; exclude unnecessary EXIF, text, XMP and timestamps without changing pixels or needed colour data. Remove the owned scratch directory after inspection. Never commit the large source PNG. The README displays the shared PNG at 160 × 160 with descriptive alt text.

`packaging/document-icons.plist` replaces the generated macOS document-type array, so it must retain the common configuration's complete five-extension Viewer entry and default rank for `taurimd.Markdown` when adding the ICNS reference. Check the emitted `.app` plist and Resources, not just the overlay. Linux installs the `taurimd-markdown` MIME icon through the existing DEB file map; `packaging/taurimd.xml` selects it for the already registered `text/markdown` type, without replacing a generic text icon or selecting a default application. Shared MIME-info 2.4's parser accepts this named icon mapping from package XML even though the specification describes `icon` as a user-override mechanism. The target desktop's theme, MIME caches and user overrides still determine displayed icons; package metadata checks do not certify Finder, Explorer or Linux file-manager rendering.

## Validation ownership and evidence

Run focused checks while implementing. The finalization owner runs the full gate **once**, normally through the installed pre-commit hook; do not reflexively run `check:local` and then repeat the same full group in a commit. Report failed/unavailable checks honestly, preserve complete output in logs, and never bypass a hook to commit. Native manual smoke has its own checklist in `README.md` and must not be described as covered by browser tests.

Use Conventional Commits such as `feat: read local documents` or `fix: retain the previous document after failed reload`. Do not put personal identifiers, machine paths, private provenance or credentials in content or messages.

Dependency locks are authoritative. To regenerate the local platform notice inventory using cached dependencies only, capture `cargo metadata --locked --offline --manifest-path src-tauri/Cargo.toml --format-version 1 --filter-platform aarch64-apple-darwin` to a scratch JSON file, then pass it to `node scripts/notices.mjs`. The metadata contains local paths and must not be committed. The generated `src-tauri/target/THIRD_PARTY_NOTICES.md` deliberately preserves upstream legal texts without formatting or redaction and is an explicitly partial, non-distributable inventory, not a committed source document or a newly qualified release. Only the four exact package/version/source supplements documented in `DEPENDENCIES.md` are assembled from `licenses/`, with retained-text SHA-256 checks; missing or changed required material fails generation. Historical archive omissions remain recorded separately from missing assembled text. All twelve unresolved attribution rows, MPL recipient-source conditions and other distribution blocks still require qualification; neither terms nor source links alone clear them. Missing upstream notices are explicit distribution blockers, not license waivers.
