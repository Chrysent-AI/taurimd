import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// Metadata is generated with Cargo's locked platform filter, not committed.
const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const noticeFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^(licen[cs]e|notice|copyright)/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
// Only these exact published identities have reviewed supplemental material.
// Registry identity comes from locked inputs, not the display source URL.
const cratesIo = 'registry+https://github.com/rust-lang/crates.io-index';
const tauriPublication =
  'https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/';
const supplements = [
  {
    name: 'alloc-stdlib',
    version: '0.3.0',
    origin: cratesIo,
    files: [
      [
        'alloc-stdlib-0.3.0.txt',
        'https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE',
        'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae',
      ],
    ],
  },
  {
    name: 'selectors',
    version: '0.38.0',
    origin: cratesIo,
    files: [
      [
        'selectors-0.38.0-NOTICE.txt',
        'https://raw.githubusercontent.com/servo/stylo/572ecba2d1600e7c3d490586692a209faf703baa/selectors/lib.rs (lines 1–3, unchanged bytes)',
        '766674381e88a468d55e07de3596987391cf0e8beebe51baf4fddf11078785b3',
      ],
      [
        'selectors-0.38.0-MPL-2.0.txt',
        'https://www.mozilla.org/media/MPL/2.0/index.f75d2927d3c1.txt',
        '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
      ],
    ],
  },
  {
    name: 'tauri-plugin',
    version: '2.7.2',
    origin: cratesIo,
    files: [
      [
        'tauri-plugin-2.7.2-MIT.txt',
        `${tauriPublication}LICENSE-MIT`,
        '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d',
      ],
      [
        'tauri-plugin-2.7.2-APACHE-2.0.txt',
        `${tauriPublication}LICENSE-APACHE-2.0`,
        '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
      ],
      [
        'tauri-plugin-2.7.2-SPDX.txt',
        `${tauriPublication}LICENSE.spdx (attribution/declaration metadata; CC0 is its data license, not the code license; both code alternatives retained without election)`,
        '5e834fe9788c524210deda859c46a550ffa5aa0cba9ea0572f0d81120e97c008',
      ],
    ],
  },
  {
    name: 'marked-footnote',
    version: '1.4.0',
    origin:
      'https://registry.npmjs.org/marked-footnote/-/marked-footnote-1.4.0.tgz',
    files: [
      [
        'marked-footnote-1.4.0.txt',
        'https://raw.githubusercontent.com/bent10/marked-extensions/faab750f00af4788397948286fb8f7fe0c929a7e/license',
        '9359f7399b808813111a91c5d28656d5843d8f6d337168541938286dbf273a32',
      ],
    ],
  },
];
let output =
  '# Third-party notices — PARTIAL / NON-DISTRIBUTABLE\n\nGenerated from the npm lock and Cargo metadata for the local Apple Silicon build. Includes native build dependencies; listing does not establish runtime presence or qualification of other platforms. Dependency sources are unmodified. DOMPurify is distributed under its Apache-2.0 option; its alternative license text is preserved as supplied.\n\nFull binary distribution qualification remains BLOCKED: unresolved attribution/full notices remain UNVERIFIED for block2 0.6.2, dispatch2 0.3.1, objc2 0.6.5, objc2-encode 4.1.0, objc2-exception-helper 0.1.1, rustls-platform-verifier-android 0.2.0, and objc2-app-kit, objc2-core-foundation, objc2-core-graphics, objc2-foundation, objc2-io-surface, objc2-quartz-core, objc2-web-kit 0.3.2. MPL-2.0 components remain separately licensed; recipient covered-source access and informing conditions (§§3.1–3.2) remain UNQUALIFIED. Versioned source URLs and reproduced terms do not establish fulfillment. Other platform closures, later dependency closures, native/platform qualification and all remaining distribution conditions require review before distribution. This inventory is not legal clearance or public binary distribution authorization.\n\n';
function section(name, version, license, source, directory, origin) {
  output += `## ${name} ${version}\n\nDeclared license: ${license}. Source: ${source}\n\n`;
  const files = noticeFiles(directory);
  const supplement = supplements.find(
    (entry) =>
      entry.name === name &&
      entry.version === version &&
      entry.origin === origin,
  );
  if (files.length === 0 && !supplement) {
    console.warn(
      `Missing packaged license text: ${name} ${version} (${license})`,
    );
    output +=
      'UNVERIFIED NOTICE: License text is absent from the installed package; resolve its exact upstream notice before distributing a binary.\n\n';
  }
  for (const file of files)
    output += `### ${file}\n\n\u0060\u0060\u0060text\n${readFileSync(resolve(directory, file), 'utf8')}\n\u0060\u0060\u0060\n\n`;
  if (supplement) {
    output += `Supplemental material for exact locked source: ${origin}. The published archive omitted standalone legal files; assembly here does not change that historical omission or qualify distribution. Packaged originals, when present, are retained above.\n\n`;
    if (files.length === 0)
      console.warn(`Packaged notice omission supplemented: ${name} ${version}`);
    for (const [file, url, hash] of supplement.files) {
      const bytes = readFileSync(resolve('licenses', file));
      if (createHash('sha256').update(bytes).digest('hex') !== hash)
        throw new Error(`Supplemental notice SHA-256 mismatch: ${file}`);
      output += `### Supplemental ${file}\n\nLegal source: ${url}\n\nRetained text SHA-256: ${hash}\n\n\u0060\u0060\u0060text\n${bytes.toString('utf8')}\n\u0060\u0060\u0060\n\n`;
    }
  }
}
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const manifest = JSON.parse(
    readFileSync(resolve(path, 'package.json'), 'utf8'),
  );
  section(
    manifest.name,
    entry.version,
    entry.license,
    `https://www.npmjs.com/package/${manifest.name}/v/${entry.version}`,
    path,
    entry.resolved,
  );
}
const included = new Set(metadata.resolve.nodes.map((node) => node.id));
for (const pkg of metadata.packages
  .filter((pkg) => pkg.source && included.has(pkg.id))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  section(
    pkg.name,
    pkg.version,
    pkg.license,
    `https://crates.io/crates/${pkg.name}/${pkg.version}`,
    dirname(pkg.manifest_path),
    pkg.source,
  );
}
mkdirSync('src-tauri/target', { recursive: true });
writeFileSync('src-tauri/target/THIRD_PARTY_NOTICES.md', output);
