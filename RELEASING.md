# Preparing taurimd candidates

This is local build preparation, **not a publication command or a distribution clearance**.
The repository is the public `https://github.com/Chrysent-AI/taurimd`. No crate is
published on crates.io under this name yet, so registry ownership is not
established. No download/install
command here presumes that a public crate, release or asset exists.

## Human version changes

Cargo's package version is authoritative. The helper checks all six own-version
values before writing: Cargo, its own lock entry, Tauri, npm, and the two npm root
lock versions. Dependencies and formatting remain unchanged.

```sh
make bump-version                 # default patch
make bump-version BUMP=minor       # patch, minor or major
make bump-version VERSION=1.2.3    # stable, strictly increasing version
```

On Windows, or without Make:

```sh
node scripts/bump-version.mjs --bump=patch
node scripts/bump-version.mjs --version=1.2.3
```

Use only one input. Stop other edits while bumping. The helper stages owned local
files and restores already-replaced originals on a normal write failure. This is
not a filesystem-wide atomic transaction: hard process/OS termination can leave
`.version-bump-*` recovery files. Inspect and restore those originals before
retrying. It never stages, commits, tags, pushes, installs, reads keys, logs in,
uses the network or publishes. Normal protection hooks still apply to the human's
subsequent commit.

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
create a tag. PR/push quality, secret/range/full-message, browser and native
debug-profile no-bundle compilation checks remain ordinary checks. `--no-bundle`
only skips installers; `--debug` explicitly selects the ordinary compile profile.
Only validated tag pushes can use the default release profile to generate
installer/archive workflow artifacts. Workflow artifacts are a
human qualification handoff, not GitHub releases or registry publication. No
signing, release creation, publication credential or contents-write permission is
configured. Editing this workflow is not authorization to trigger it.

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

Binstall copies only the manifest executable. It does **not** install a macOS
`.app`, run NSIS/DEB, preserve companion resources, register file associations or
provision system webviews. Keep the existing `.app`/DMG, NSIS and DEB routes.
Support remains macOS 14+ Apple Silicon, Windows 11 x64 with Evergreen WebView2,
and Ubuntu 24.04 x86_64 with WebKitGTK 4.1, desktop/session D-Bus and X11/Wayland.
There is no Intel macOS, Windows ARM, musl or all-distro claim.

## Outstanding qualification and identity

- The human approved temporarily retaining the exact internal bundle identifier
  `com.chrysent.mdviewerrsx` for this rename. Its settings/data/cache and
  single-instance behavior remain unchanged; no profile import, scan or reset is
  implemented. Public branding and association/MIME labels use the new name.
  A future identifier change is deferred and requires a deliberate preference
  migration and affected-platform qualification, not a silent configuration edit.
- Registry ownership must be supplied before URL-dependent metadata or
  official-asset retrieval can be finalized. The repository URL is confirmed;
  no crates.io crate under this name exists yet.
- `DEPENDENCIES.md` and any generated PARTIAL / NON-DISTRIBUTABLE inventory retain
  their unresolved attribution and recipient-source obligations. Neither an
  archive nor a source crate is distribution-cleared by successful compilation.
- Relocated native executable launch, offline reading, menus, settings restart,
  export, loader/runtime prerequisites and ordinary installer association and
  uninstall behavior still require authorized checks on every supported target.
  Browser mocks, headers and source builds are not those checks. Do not let
  compile or QuickInstall fallback hide missing official assets during later
  binstall qualification. No real installation or GUI launch is performed here.

Publication, remote renaming, release tags/pushes, credentials, signing and public
release operations remain exclusively human-controlled and separately authorized.
