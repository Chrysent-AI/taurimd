# Preparing taurimd candidates

This is local build preparation, **not a publication command or a distribution clearance**.
The repository is the public `https://github.com/Chrysent-AI/taurimd`. The
`taurimd` crate is published on crates.io (registry ownership established by the
human's publication of v0.1.23 on 2026-11-05). No download/install
command here presumes that a public release or asset exists.

## Version bump, release commit and tag

Cargo's package version is authoritative. The helper checks all six own-version
values before writing: Cargo, its own lock entry, Tauri, npm, and the two npm root
lock versions. Dependencies and formatting remain unchanged.

```sh
make bump-version                 # default patch
make bump-version BUMP=minor       # patch, minor or major
make bump-version VERSION=1.2.3    # stable, strictly increasing version
make bump-version VERIFY=1      # run the local gate, build and lint first
```

On Windows, or without Make:

```sh
node scripts/release.mjs --bump=patch
node scripts/release.mjs --version=1.2.3
```

One command performs the whole release preparation: it rewrites the six
own-version values, commits them with the fixed message
`chore(release): taurimd vX.Y.Z`, and creates the annotated tag `vX.Y.Z` on that
commit. It refuses to run on a dirty working tree, off `main`, or when the tag
already exists, and it restores the version files when the commit fails. The
branch and the tag are still pushed by the human. If the tag itself fails, the
release commit stays and the command prints the exact `git tag` command that
finishes it; nothing is pushed either way.

The release commit does not run the local gate, the build or the lint: it only
rewrites the six version values, commits them and tags the commit. The same
checks run on the branch push and on the tag push in CI. `VERIFY=1` runs them
locally first instead, and a failing gate then aborts the release and restores
the version files.

Use only one input. Stop other edits while bumping. The helper stages owned local
files and restores already-replaced originals on a normal write failure. This is
not a filesystem-wide atomic transaction: hard process/OS termination can leave
`.version-bump-*` recovery files. Inspect and restore those originals before
retrying. It never pushes, installs, reads keys, logs in, uses the network or
publishes. The release commit carries the same fixed message every time, so the
repository's message gate passes it unchanged.

## Read-only release validation

A release tag must be exactly `vX.Y.Z` and match all six values **on that tagged
commit**. For every non-root commit the Cargo version must increase against that
commit's first parent. An unrelated later commit with the same version does not
qualify. Only an actual repository-root introduction has no parent requirement;
this existing repository must bump its current `0.1.0` before its first release.

```sh
node scripts/validate-tag.mjs v1.2.3
```

This only reads an already-existing local tag and complete ancestry; it does not
create a tag. PR/push quality, browser and native
debug-profile no-bundle compilation checks remain ordinary checks. `--no-bundle`
only skips installers; `--debug` explicitly selects the ordinary compile profile.
Only validated tag pushes can use the default release profile to generate the
installer and archive candidates. The tag workflow publishes those unsigned
candidates on a GitHub release page for the tag; it signs nothing and it does
not publish to any registry. Editing this workflow is not authorization to
trigger it.

## Workflow split

A branch push and a tag push are two events even when they name the same commit,
so they run two workflows:

- `.github/workflows/checks.yml` runs on pull requests and on pushes to `main`. On
  a push to `main` the quality gate, the three-engine browser matrix and the
  unsigned debug native builds run only when the pushed commit message is a
  conventional `feat`, `fix`, `test` or `tests` commit. A push to `main` with any
  other commit message runs no test.
- `.github/workflows/release.yml` runs on `v*` tag pushes only. It validates the
  tag, builds the unsigned installer and archive candidates on the three
  platforms, and publishes them on a GitHub release page for that tag.

The release stage runs no quality gate, no build of the product and no test: it
validates the tag, produces the binaries and hosts them. The candidates are
unsigned, and the release stage publishes to GitHub only; the crates.io
publication is a separate, human-driven step.

## Publishing to crates.io

The crate is published on crates.io under the account that ran the first
`make publish` (v0.1.23). The `Chrysent-AI` organization may or may not exist
there; if registry ownership should move to an organization account, that
transfer is a human step (crates.io cannot transfer published crates between
accounts automatically).

The token never enters the repository. Create a crates.io API token under the
owning account, copy `.env.example` to `.env` (gitignored), and put the token
there, or export `CARGO_REGISTRY_TOKEN` in the shell.

```sh
make publish DRY_RUN=1   # rehearsal: packages, verifies and uploads nothing
make publish              # publishes the version in Cargo.toml
```

The command refuses without a token and refuses on a dirty working tree, so the
crate can never package uncommitted bytes. It publishes the version that
`src-tauri/Cargo.toml` carries, with `--locked`, so the published crate is the
reviewed lockfile.

It passes `--allow-dirty` to Cargo on purpose. The crate carries generated
inputs that git ignores — the built frontend, the Tauri schemas, the packaged
legal documents and the generated permissions — so Cargo always counts them as
uncommitted. The command's own guard is stricter than that flag: any tracked
modification or untracked non-ignored file stops the publication before Cargo
runs.

**Publish after the GitHub release for the same version.** The crate's binstall
metadata resolves `https://github.com/Chrysent-AI/taurimd/releases/download/v{version}/…`,
so a crate published before its release exists sends `cargo binstall taurimd` to
a URL that 404s until the release is published. The registry carries the source
crate; the signed, installable candidates come from the GitHub release.

## Toolchain and workflow currency

The pinned versions are current and supported, not merely working:

- **Actions** are pinned by commit to `actions/checkout` v7.0.1, `actions/setup-node`
  v7.1.0 and `actions/upload-artifact` v7.0.2. All three run on the Node 24 action
  runtime. The v4 line targeted Node 20, and GitHub removed Node 20 from the
  runners on 2026-09-23, so a v4 pin is a removed runtime rather than an
  old-but-working one. `setup-node` v6 and later enable npm caching automatically
  when `packageManager` names npm; the workflows set `package-manager-cache: false`
  and keep the explicit `cache: npm`, so caching behaves exactly as before.
- **Node** is pinned to 26.13.0, the current LTS line (26.x became LTS on
  2026-10-28). `.node-version` holds that version for fnm, and
  `scripts/check.mjs` re-runs itself under the pinned Node through fnm when
  the active Node differs. One version therefore runs everything this
  repository does: the gate, the frontend build, the Tauri build and the
  browser suite. The `dev`, `tauri` and `test:browser` scripts go through
  `scripts/check.mjs`, so no build can happen on a different Node than the
  checks that guard it. When the pinned version cannot be selected, the
  command says so and names the remedy.
- **npm** is pinned to 12.2.1. npm 12 blocks install scripts by default, so the
  optional `fsevents` install script is skipped; fsevents only accelerates
  dev-server file watching on macOS and is not needed to build, test or package.
- **Rust** is pinned to 1.99.1, the current stable release, by `rust-toolchain.toml`
  and by CI. The declared `rust-version` matches the toolchain the project
  actually tests.
- **Playwright** is pinned to 1.64.1; the browser suite runs chromium, firefox and
  webkit from that release. A media seek is checked with a frame-sized
  tolerance because an engine snaps a seek to the nearest decodable frame.
- **Gitleaks** is pinned to 8.30.1, the current release.
- **Runner images** are `ubuntu-24.04`, `macos-15` and `windows-2025`. GitHub
  supports the two most recent versions of each OS: the macOS 14 runners were
  retired on 2026-11-02, `macos-latest` now points at macOS 26, and Ubuntu 24.04
  is both still supported and the distribution this project targets.
- **Supported operating systems** are macOS 15+ Apple Silicon (macOS 14 Sonoma
  reached end of life on 2026-09-14), Windows 11 x64 with Evergreen WebView2, and
  Ubuntu 24.04 x86_64 with WebKitGTK 4.1, desktop/session D-Bus and X11/Wayland.

## Source package

Use the pinned project Node/npm and native Rust development prerequisites. Keep
both locks. `npm run build` generates `src-tauri/frontend-dist` and copies the
root README, MIT license and dependency-qualification handoff into ignored
crate-local paths. If an existing partial native notice inventory is present, it
is copied verbatim too; absence does not become notice clearance. Frontend legal
assets carry these documents because binstall installs only the executable.
Cargo defaults enable Tauri's custom protocol so an ordinary source build embeds
the frontend rather than requiring the development server. Tauri CLI development
filters that default feature through its existing supported feature handling.

```sh
npm run build
cargo build --locked --offline --manifest-path src-tauri/Cargo.toml
cargo package --list --locked --offline --manifest-path src-tauri/Cargo.toml
cargo package --locked --offline --manifest-path src-tauri/Cargo.toml
```

Package from clean prepared inputs. Cargo does not run npm's build automatically.
The explicit source allowlist includes generated ACL/schema inputs, allowing
normal Tauri generation during package verification without a second permission
authority. An extracted source crate should need Rust/native development tools,
not Node or this checkout's node_modules. Build verification does not clear legal
or GUI qualification. See `DEPENDENCIES.md` before distributing compiled assets.

## Candidate archive layout

After a locked native release build, the host `tar` and Node SHA-256 helper use
binstall's default layout, without metadata overrides:

```sh
node scripts/archive.mjs aarch64-apple-darwin
# or x86_64-pc-windows-msvc / x86_64-unknown-linux-gnu on that native host
```

Output is `src-tauri/target/binstall/taurimd-<TARGET>-v<VERSION>.tgz`, with
`taurimd-<TARGET>-v<VERSION>/taurimd` (`taurimd.exe` on Windows), README, MIT text
and a truthful notices/qualification handoff. Existing output is not overwritten.
A `.sha256` sidecar checks corruption, not publisher authenticity. The tgz archive
suffix is `.tgz`, not `.tar.gz`. Header checks reject obvious wrong-target inputs;
they do not demonstrate native GUI operation.

`Cargo.toml` carries `[package.metadata.binstall]` so `cargo binstall taurimd`
resolves that exact archive name and finds the binary inside its versioned
directory — but only once the human attaches the retained archive to a published
GitHub release for the validated tag. binstall copies only the executable; it
does not install the `.app`, NSIS or DEB candidates, the MIME icon or a system
webview, and it does not verify the archive's publisher.

Binstall copies only the manifest executable. It does **not** install a macOS
`.app`, run NSIS/DEB, preserve companion resources, register file associations or
provision system webviews. Keep the existing `.app`/DMG, NSIS, DEB and AppImage
routes.
Support remains macOS 15+ Apple Silicon, Windows 11 x64 with Evergreen WebView2,
and Ubuntu 24.04 x86_64 with WebKitGTK 4.1, desktop/session D-Bus and X11/Wayland.
There is no Intel macOS, Windows ARM, musl or all-distro claim.

## Linux AppImage candidate

The Ubuntu build target now produces an AppImage beside the DEB. The Tauri
bundler names it `taurimd_<version>_<arch>.AppImage` — `taurimd_0.1.0_amd64.AppImage`
at version 0.1.0 — and writes it to
`src-tauri/target/release/bundle/appimage/`. The `package-candidates` workflow job
retains it with the other unsigned candidates as a workflow artifact: an unsigned
human qualification handoff, not a GitHub release and not a registry publication.
The DEB target is unchanged and still produced.

The AppImage was not built, run, installed or desktop-integrated by this
repository's local checks; the Linux CI job builds it on an Ubuntu runner.
Running an AppImage needs FUSE, or `--appimage-extract-and-run` on a system
without FUSE. Installation, desktop entry integration, `.md`/`.markdown`/`.mdown`/
`.mkd`/`.mkdown` file associations and in-AppImage media playback are unverified
on an actual Ubuntu target and still require the authorized native checks in
"Outstanding qualification and identity".

## Outstanding qualification and identity

- The human approved temporarily retaining the exact internal bundle identifier
  `com.chrysent.mdviewerrsx` for this rename. Its settings/data/cache and
  single-instance behavior remain unchanged; no profile import, scan or reset is
  implemented. Public branding and association/MIME labels use the new name.
  A future identifier change is deferred and requires a deliberate preference
  migration and affected-platform qualification, not a silent configuration edit.
- Registry ownership is established (v0.1.23 published on crates.io,
  2026-11-05); the repository URL is confirmed. Signing and formal
  distribution clearance remain outstanding.
- `DEPENDENCIES.md` and any generated PARTIAL / NON-DISTRIBUTABLE inventory retain
  their unresolved attribution and recipient-source obligations. Neither an
  archive nor a source crate is distribution-cleared by successful compilation.
- Relocated native executable launch, offline reading, menus, settings restart,
  export, loader/runtime prerequisites and ordinary installer association and
  uninstall behavior still require authorized checks on every supported target.
  AppImage launch on Linux additionally needs FUSE or
  `--appimage-extract-and-run`, and that route is unverified.
  Browser mocks, headers and source builds are not those checks. Do not let
  compile or QuickInstall fallback hide missing official assets during later
  binstall qualification. No real installation or GUI launch is performed here.

Publication, remote renaming, branch and tag pushes, credentials, signing and
public release operations remain exclusively human-controlled and separately
authorized. `make bump-version` prepares a release locally — the version files,
the commit and the tag — and stops there.
