# Dependency licensing

The npm and Cargo lockfiles pin the actual dependency closure. No dependency source is patched or vendored.

## Bundled frontend

| Package           | Locked version | License selection                                         |
| ----------------- | -------------- | --------------------------------------------------------- |
| React / react-dom | 19.2.6         | MIT                                                       |
| scheduler         | 0.27.0         | MIT                                                       |
| @tauri-apps/api   | 2.12.4         | MIT or Apache-2.0                                         |
| Marked            | 18.0.3         | MIT                                                       |
| marked-footnote   | 1.4.0          | MIT; exact upstream notice retained below                 |
| Highlight.js      | 11.12.0        | BSD-3-Clause                                              |
| js-yaml           | 4.3.2          | MIT                                                       |
| argparse          | 2.0.1          | Python-2.0; conservative npm production closure           |
| DOMPurify         | 3.4.17         | Apache-2.0 (its offered alternative to MPL-2.0)           |
| Mermaid           | 12.2.0         | MIT; exact direct notice in `licenses/mermaid-12.2.0.txt` |

The lock also records MIT-licensed `@types/trusted-types` 2.0.7; types are not executable runtime assets. Installed licenses for these packages were inspected and are collected by the notice generator.

The rich-text runtime uses the locally bundled Highlight.js common language set, the published Marked footnote extension, and js-yaml's standard schema. Installed types/source and actual worker integration were checked; no CDN, custom YAML executable tags, upstream patch, or dependency theme injection is used. js-yaml's ESM browser entry does not import its CLI's argparse; argparse nevertheless remains in the production lock/notice inventory. Its supplied Python-2.0 notice permits unmodified redistribution with the notice retained. Preserve Highlight.js's BSD copyright/disclaimer/non-endorsement terms and js-yaml's MIT notice. The added `@types/js-yaml` 4.0.9 is MIT, development/type-only.

The published `marked-footnote` archive omits a standalone license file. Its registry `gitHead` is `faab750f00af4788397948286fb8f7fe0c929a7e`. The complete exact upstream lowercase `license` text is preserved in `licenses/marked-footnote-1.4.0.txt`, fetched from:
https://raw.githubusercontent.com/bent10/marked-extensions/faab750f00af4788397948286fb8f7fe0c929a7e/license

The existing notice generator reports that missing archive notice; include the preserved exact text in the generated distribution notice before any binary distribution. This is not a license-gap waiver or distribution authorization. Runtime and transitive tarball integrity values are pinned in `package-lock.json`; a normal npm 11.6.2 clean install in an empty, owned manifest/lock context succeeded without bypasses. The production advisory audit reported zero vulnerabilities. The existing thirteen moderate development-only minimatch/lint-chain advisories remain separately tracked; no unrelated toolchain upgrade is included here.

Mermaid is bundled locally for strict-mode inline SVG diagrams. Its generated SVG/CSS is trusted for display and SVG export; it is not an independently sanitized or resource-free image contract. Only the direct Mermaid dependency was added; its locked production closure includes renderer/layout/math packages, KaTeX font assets and `elkjs` (EPL-2.0). The direct MIT notice is retained exactly in `licenses/mermaid-12.2.0.txt`. Preserve the actual transitive legal texts and bundled font notices, including the EPL layout obligations, during final distribution qualification; this addition does not claim that the application's MIT license covers that closure or that distribution has been cleared. The focused production-only npm advisory audit reported zero vulnerabilities; existing development advisories were not force-fixed.

## Native and build closure

Diagram export adds exact Rust `zip` 9.0.1 with default features disabled and uses Stored entries only. The actual resolved archive feature set is empty: no optional compression or cryptography. Its direct closure is crc32fast 1.5.3, indexmap 2.14.2, memchr 2.8.3, typed-path 0.12.3 and, on macOS/BSD, nix 0.31.3 with `fs`. The only new lock entries are zip, typed-path, nix and its build dependency cfg_aliases 0.2.2; existing locked versions remain unchanged. Those packages offer MIT or MIT/Apache-2.0 licensing. The exact direct ZIP MIT notice is retained in `licenses/zip-9.0.1.txt`.

The export-local cleanup guard also directly references already-locked `same-file` 1.0.6, selecting MIT from its offered Unlicense/MIT terms; its exact notice is retained in `licenses/same-file-1.0.6.txt`. It compares live handles before deleting only owned temporary paths. Its Windows dependency remains the existing winapi-util 0.1.11 (MIT/Unlicense) and windows-sys 0.61.2 (MIT/Apache-2.0); lock membership and installed API inspection are not Windows execution evidence or universal filesystem-isolation claims. Existing tempfile 3.27.0 remains unchanged. Preserve all transitive notices through the existing distribution qualification; adding these direct notices does not clear the previously recorded notice gaps. No JS ZIP/canvas library, native rasterizer, system executable, dependency patch or new service is added.

The inspected Apple Silicon Cargo closure declares MIT/Apache-2.0 choices and compatible BSD, Zlib, Unicode, public-domain alternatives and MPL-2.0 components. The latter remain separate, unmodified files/crates, not a change to the application's MIT license. Versioned crates.io source links and supplied license texts are included in the generated inventory. System SDK/webview components are platform prerequisites, not copied assets.

The settings store adds `tempfile` 3.27.0 using its MIT option for same-directory atomic replacement and owned temporary-file cleanup. Installed source verifies `NamedTempFile::new_in`, file synchronization and `persist` replacement semantics; on Windows it uses `MoveFileExW` with replacement enabled. This is not Windows execution evidence or a claim of power-loss durability. The added lock entries `errno` 0.3.14, `rustix` 1.1.6 and `linux-raw-sys` 0.12.1 also offer MIT, with supplied license texts inspected. Existing locked versions are unchanged. Include these notices in the generated inventory before distribution.

The native-only `tauri-plugin-opener` is pinned to **2.7.2**, using its MIT option. Installed source verifies `Builder::open_js_links_on_click(false)` and `OpenerExt::open_url(validated_url, None::<&str>)`; application commands independently reparse/allowlist URLs because native opener methods do not enforce plugin JS scopes. No JS opener dependency or generic opener/filesystem/shell/HTTP capability is added. The installed Tauri 2.12.4/Wry 0.57.1 APIs supply requesting-webview protocol context and setup-time navigation/new-window/download hooks; application code owns path, lifetime, range and URL policy.

The lock adds the opener's published cross-platform closure without changing existing locked versions. New exact entries are `open` 5.4.5; `is-docker` 0.2.0; `is-wsl` 0.4.0; `async-broadcast` 0.7.2; `async-channel` 2.5.0; `async-executor` 1.14.0; `async-io` 2.6.0; `async-lock` 3.4.2; `async-process` 2.5.0; `async-recursion` 1.2.0; `async-signal` 0.2.14; `async-task` 4.7.1; `async-trait` 0.1.92; `blocking` 1.7.0; `concurrent-queue` 2.5.0; `endi` 1.1.1; `enumflags2`/`enumflags2_derive` 0.7.12; `event-listener` 5.4.2; `event-listener-strategy` 0.5.4; `futures-lite` 2.6.1; `hermit-abi` 0.5.3; `ordered-stream` 0.2.0; `parking` 2.2.1; `piper` 0.2.5; `polling` 3.11.0; `signal-hook-registry` 1.4.8; `tracing-attributes` 0.1.31; `uds_windows` 1.2.1; `zbus`/`zbus_macros` 5.19.0; `zbus_names` 4.3.5; `zcheapstr` 1.2.0; `zvariant`/`zvariant_derive` 5.15.1; and `zvariant_utils` 4.2.0. Each added crate supplies a notice and declares MIT or an MIT/Apache-2.0 alternative. Preserve the additional third-party notices in `futures-lite` and `parking`. Cross-platform lock membership does not imply every crate ships on every target.

A current Cargo advisory audit found zero vulnerability entries, but not a blanket clean bill: the new Linux closure carries unmaintained notices for `zbus_names`, `zvariant` and `zvariant_derive`; existing `proc-macro-error` unmaintained and `glib` unsound-iterator notices remain. The audit made no exceptions or dependency-source patches. Platform execution and final distribution review remain separate. Regenerated Apple Silicon notices retain the pre-existing missing-notice list below; no new added crate lacks a packaged notice. The original browser geometric image, PCM tone and VP8 clip in `tests/browser/media/` are project-authored MIT fixtures, not third-party recordings; running tests does not require FFmpeg.

Generate notices using the documented Cargo metadata command and `scripts/notices.mjs` in `CONTRIBUTING.md`. The output is `src-tauri/target/THIRD_PARTY_NOTICES.md`. It includes build-time crates as well as native dependencies, not a claim that every listed crate is dynamically present in the executable. Generated upstream legal texts retain their original authorship notices; do not redact them or treat them as newly authored product prose. Do not commit build outputs.

The following packages omit separate license files from their installed crate archives. Exact upstream notices must be collected and reviewed **before binary distribution**:

- `alloc-stdlib` 0.3.0
- `block2` 0.6.2
- `dispatch2` 0.3.1
- `objc2` 0.6.5
- `objc2-app-kit`, `objc2-core-foundation`, `objc2-core-graphics`, `objc2-foundation`, `objc2-io-surface`, `objc2-quartz-core`, `objc2-web-kit` 0.3.2
- `objc2-encode` 4.1.0
- `objc2-exception-helper` 0.1.1
- `selectors` 0.38.0
- `tauri-plugin` 2.7.2

Licensing is not waived because a package archive omits its notice. Other platform closures and any later runtime packages require their own final notice review. Public binary distribution is not authorized by this development build.

Development tools are not bundled product assets: the installed ESLint/TypeScript/Vite/React-plugin/Prettier/Vitest/jsdom/Testing Library/commitlint stack is MIT or Apache-2.0; Playwright is Apache-2.0 and its separately downloaded browser binaries carry vendor terms; Gitleaks is MIT. CI uses a pinned Gitleaks executable release with a checked SHA-256, not an organizational scanning action.
