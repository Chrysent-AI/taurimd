import { readFileSync } from 'node:fs';

export const versionPaths = [
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'package.json',
  'package-lock.json',
];
export function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error(`Expected a stable X.Y.Z version, received ${value}.`);
  return value.split('.').map(BigInt);
}
export function increases(next, previous) {
  const a = stableVersion(next);
  const b = stableVersion(previous);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function capture(text, pattern) {
  const match = pattern.exec(text);
  if (!match)
    throw new Error('Unrecognized own-version layout. No files changed.');
  return { start: match.index + match[1].length, value: match[2] };
}
export function cargoVersion(text) {
  return capture(text, /^(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)"/m)
    .value;
}
export function versions(read = (path) => readFileSync(path, 'utf8')) {
  const files = new Map(versionPaths.map((path) => [path, read(path)]));
  const cargo = files.get(versionPaths[0]);
  if (!/^name = "taurimd"$/m.test(cargo))
    throw new Error('Unexpected Cargo package identity.');
  const records = [
    [
      versionPaths[0],
      capture(cargo, /^(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)"/m),
    ],
    [
      versionPaths[1],
      capture(
        files.get(versionPaths[1]),
        /^(\[\[package\]\]\nname = "taurimd"\nversion = ")([^"]+)"/m,
      ),
    ],
  ];
  for (const path of versionPaths.slice(2)) {
    const text = files.get(path);
    const data = JSON.parse(text);
    records.push([
      path,
      capture(
        text,
        /^(\{(?:\s*"[^"\n]+"\s*:\s*[^\n]+\n)*?\s*"version"\s*:\s*")([^"]+)"/,
      ),
    ]);
    if (path === 'package-lock.json') {
      if (data.name !== 'taurimd' || data.packages[''].name !== 'taurimd')
        throw new Error('Unexpected npm lock identity.');
      records.push([
        path,
        capture(
          text,
          /("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"taurimd",\s*"version"\s*:\s*")([^"]+)"/,
        ),
      ]);
      if (records.at(-1)[1].value !== data.packages[''].version)
        throw new Error('Unrecognized npm root lock version.');
    }
    if (records.findLast(([name]) => name === path)[1].value !== data.version)
      throw new Error('Unrecognized root version.');
  }
  const version = cargoVersion(cargo);
  stableVersion(version);
  if (
    records.length !== 6 ||
    records.some(([, span]) => span.value !== version)
  )
    throw new Error(
      'All six own-version values must match Cargo before proceeding.',
    );
  return { version, files, records };
}
export function releaseBoundary({ tag, read, parentRead, rootCommit }) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    throw new Error('Release tag must be exactly vX.Y.Z.');
  const current = versions(read).version;
  if (tag !== `v${current}`)
    throw new Error('Tag and all own versions must match.');
  if (rootCommit) {
    if (parentRead) throw new Error('Root introduction cannot have a parent.');
  } else {
    if (!parentRead) throw new Error('First-parent version is required.');
    if (!increases(current, cargoVersion(parentRead('src-tauri/Cargo.toml'))))
      throw new Error(
        'Version must increase on the tagged commit against its first parent.',
      );
  }
  return current;
}
