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
let output =
  '# Third-party notices\n\nGenerated from the npm lock and Cargo metadata for the local Apple Silicon build. Includes native build dependencies; this is not qualification of other platforms. Dependency sources are unmodified. DOMPurify is distributed under its Apache-2.0 option; its alternative license text is preserved as supplied. MPL-2.0 components remain separately licensed: their exact unmodified source is available at the versioned crates.io links below. Other platform closures must be rechecked before distribution.\n\n';
function section(name, version, license, source, directory) {
  output += `## ${name} ${version}\n\nDeclared license: ${license}. Source: ${source}\n\n`;
  const files = noticeFiles(directory);
  if (files.length === 0) {
    console.warn(
      `Missing packaged license text: ${name} ${version} (${license})`,
    );
    output +=
      'License text is absent from the installed package; resolve its exact upstream notice before distributing a binary.\n\n';
  }
  for (const file of files)
    output += `### ${file}\n\n\u0060\u0060\u0060text\n${readFileSync(resolve(directory, file), 'utf8')}\n\u0060\u0060\u0060\n\n`;
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
  );
}
mkdirSync('src-tauri/target', { recursive: true });
writeFileSync('src-tauri/target/THIRD_PARTY_NOTICES.md', output);
