# Dependency licensing

The npm and Cargo lockfiles pin the actual dependency closure. No dependency source is patched or vendored.

## Bundled frontend

| Package           | Locked version | License selection                               |
| ----------------- | -------------- | ----------------------------------------------- |
| React / react-dom | 19.2.6         | MIT                                             |
| scheduler         | 0.27.0         | MIT                                             |
| @tauri-apps/api   | 2.12.4         | MIT or Apache-2.0                               |
| Marked            | 18.0.3         | MIT                                             |
| DOMPurify         | 3.4.17         | Apache-2.0 (its offered alternative to MPL-2.0) |

The lock also records MIT-licensed `@types/trusted-types` 2.0.7; types are not executable runtime assets. Installed licenses for these packages were inspected and are collected by the notice generator.

## Native and build closure

The inspected Apple Silicon Cargo closure declares MIT/Apache-2.0 choices and compatible BSD, Zlib, Unicode, public-domain alternatives and MPL-2.0 components. The latter remain separate, unmodified files/crates, not a change to the application's MIT license. Versioned crates.io source links and supplied license texts are included in the generated inventory. System SDK/webview components are platform prerequisites, not copied assets.

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
