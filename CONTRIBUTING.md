# Contributing

Use the pinned toolchain in `README.md`, install with `npm ci`, then run the explicit installer:

```sh
npm run hooks:install
```

The installer queries Git's effective hook path on every run, including linked-worktree common hooks and repository-local custom paths. Dispatchers discover the invoking checkout at execution time; no machine path is stored. Existing or managed protection is never silently wrapped or replaced. Unknown hooks, symlink routes and routes outside the project stop installation; integrate the shared commands through the existing route's owner instead. No Git configuration or identity is changed. Re-running the installer accepts only an identical executable managed dispatcher.

To remove protection, first identify the effective route with `git rev-parse --git-path hooks`. Remove only dispatchers that exactly match the managed templates in `scripts/hooks.mjs`; never remove someone else's protection. Removing hooks does not remove independent CI checks.

## Shared checks

| Command                                       | Boundary                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run format:check`                        | Prettier, no fixes                                                                                  |
| `npm run lint`                                | Strict typed ESLint, React hooks and accessibility checks, including helper scripts                 |
| `npm run typecheck`                           | Strict TypeScript build-mode check                                                                  |
| `npm run build`                               | Bundled Vite frontend and worker                                                                    |
| `npm test`                                    | Production parser/sanitizer, controller and article/component tests                                 |
| `npm run test:hooks`                          | Isolated synthetic Git repositories: staged/range/message scans, merge/root history and hook routes |
| `npm run check:rust`                          | Locked Rust format, Clippy (`-D warnings`), tests, build; run frontend build first                  |
| `npm run test:browser`                        | Chromium, Firefox and WebKit worker/sanitizer/offline tests; browser, not native, evidence          |
| `npm run check:local`                         | Tool preflight, frontend checks, hook fixtures, Rust group                                          |
| `npm run check:commit -- message-file`        | Full-message scan, then strict Conventional Commits                                                 |
| `npm run check:ci -- --base BASE --head HEAD` | Explicit introduced-range diffs and complete messages, then the shared local group                  |
| `npm run check:ci -- --initial HEAD`          | Root-inclusive reachable ancestry and every complete message, then local group                      |

Foreign-repository fixture commands clear the repository-local Git variable names reported by `git rev-parse --local-env-vars` from their child environment, after caller options are applied. Changing only `cwd` is not isolation inside a Git hook. The owned-context regression runs representative protection tests inside a disposable outer repository's actual hook and checks that its HEAD, refs, staged index, config and worktree registrations do not change. Production hooks deliberately retain Git's invoking context so staged scanning still inspects the intended index.

Install test browsers once when needed, preserving other users' cached browser versions:

```sh
npm run browsers:install
```

This cross-platform entrypoint invokes the installed Playwright CLI directly and always sets `PLAYWRIGHT_SKIP_BROWSER_GC=1`, overriding a conflicting inherited value. CI uses `npm run browsers:install -- --with-deps` for its disposable Linux host. No force/uninstall arguments are supported. Provision only when a browser is missing; running the tests does not provision browsers. Each browser run uses one run-owned server on a kernel-assigned port and closes it on teardown. Fixtures are synthetic and do not require real credentials. Browser binaries are test tools, not bundled runtime assets.

The shell browser fixture mounts the actual React App, reader controller, native JS adapter and worker. Tauri's test mocks supply native command responses and menu events; they do not execute the Rust backend, native file chooser, real IPC/capabilities or system-webview menus. Its screenshots are browser evidence only.

Pre-commit first uses Gitleaks' own Git staged-diff traversal, then runs `check:local`. These compilation/tests inspect **working-tree files**, not an isolated staged snapshot. Partial staging and untracked work are permitted. Commit-msg scans the **entire message** including body/footer, then validates Conventional Commits with default ignore shortcuts disabled. Merge/revert-like subjects are not automatically exempt.

Gitleaks must be exactly 8.30.1. Missing/wrong scanners, unreadable/malformed configuration and any scanner error fail closed. The explicit project configuration extends upstream defaults with generic privacy patterns. Project ignore files and inline allow comments cannot bypass these scans. Detectors still cannot prove the absence of every possible secret. Staged/range scans cover introduced diff content, **not unchanged portions of changed files**. Full-message coverage is separate.

CI fetches complete ancestry and independently scans explicit PR merge-base/head or push-before/head ranges using Gitleaks Git mode with root/merge-parent handling, then scans each introduced complete message. Missing/shallow ancestry fails instead of shrinking coverage. The initial case intentionally includes the root. Exactly one existing commit, `9116eedb060c327c637f8556d88eea18cc098e94`, is grandfathered for historical Conventional Commits formatting only. Its complete message and root-inclusive content/history are still secret-scanned before any format exception applies. No subject/prefix exemption or history rewrite is used. Every other commit hash and every proposed commit message, including a new `init`, remains strict.

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

These commands pin both output locations, overriding inherited Cargo directory configuration. For existing target-specific outputs, repeat both commands with `build.build-dir` set to `src-tauri/target/<triple>` (use a target from `rustc --print target-list`), leaving `--target-dir` unchanged. Cargo 1.97.1 ignores `--target` for whole-profile cleaning; the Make targets instead scope Cargo's build directory for each target. They also disable Cargo's compiler-info cache writes during preview. Nonstandard custom-target directories are left untouched. No worktree, global cache, retained candidate or notice cleanup is performed.

## Validation ownership and evidence

Run focused checks while implementing. The finalization owner runs the full gate **once**, normally through the installed pre-commit hook; do not reflexively run `check:local` and then repeat the same full group in a commit. Report failed/unavailable checks honestly, preserve complete output in logs, and never bypass a hook to commit. Native manual smoke has its own checklist in `README.md` and must not be described as covered by browser tests.

Use Conventional Commits such as `feat: read local documents` or `fix: retain the previous document after failed reload`. Do not put personal identifiers, machine paths, private provenance or credentials in content or messages.

Dependency locks are authoritative. To regenerate the local platform notice inventory, capture `cargo metadata --locked --manifest-path src-tauri/Cargo.toml --format-version 1 --filter-platform aarch64-apple-darwin` to a scratch JSON file, then pass it to `node scripts/notices.mjs`. The metadata contains local paths and must not be committed. The generated `src-tauri/target/THIRD_PARTY_NOTICES.md` deliberately preserves upstream legal texts without formatting or redaction and is a distribution artifact, not a committed source document. Missing upstream notices are explicit distribution blockers, not license waivers.
