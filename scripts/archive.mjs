import {
  closeSync,
  openSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { versions } from './versions.mjs';
import { run } from './run.mjs';

export const targets = [
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];
export function binaryTarget(bytes, target) {
  if (target === targets[0])
    return (
      bytes.length >= 32 &&
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === 0x100000c
    );
  if (target === targets[2])
    return (
      bytes.length >= 64 &&
      bytes.toString('hex', 0, 4) === '7f454c46' &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === 62
    );
  if (
    target === targets[1] &&
    bytes.length >= 64 &&
    bytes.toString('ascii', 0, 2) === 'MZ'
  ) {
    const offset = bytes.readUInt32LE(60);
    return (
      offset <= bytes.length - 6 &&
      bytes.toString('hex', offset, offset + 4) === '50450000' &&
      bytes.readUInt16LE(offset + 4) === 0x8664
    );
  }
  return false;
}
export async function archive({ root, target, binary, output }, tar = run) {
  if (!targets.includes(target)) throw new Error('Unsupported archive target.');
  const version = versions((path) =>
    readFileSync(join(root, path), 'utf8'),
  ).version;
  const info = lstatSync(binary);
  if (!info.isFile() || !binaryTarget(readFileSync(binary), target))
    throw new Error(
      'Expected a regular executable of the requested target format.',
    );
  if (target !== targets[1] && !(info.mode & 0o111))
    throw new Error('Archive binary must be executable.');
  const name = `taurimd-${target}-v${version}`;
  const scratch = mkdtempSync(join(tmpdir(), 'taurimd-archive-'));
  const owned = [];
  const writeOwned = (path, bytes) => {
    const fd = openSync(path, 'wx');
    owned.push(path);
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  };
  let failure;
  let destination;
  try {
    const directory = join(scratch, name);
    mkdirSync(directory);
    copyFileSync(
      binary,
      join(directory, `taurimd${target === targets[1] ? '.exe' : ''}`),
    );
    for (const file of ['README.md', 'LICENSE', 'DEPENDENCIES.md'])
      copyFileSync(join(root, file), join(directory, file));
    // This is an explicit qualification handoff, not a claim of complete notices.
    writeFileSync(
      join(directory, 'NOTICES-STATUS.md'),
      'Local candidate only. DEPENDENCIES.md records unresolved notices and source-access obligations. Do not distribute before legal and target qualification. cargo-binstall copies only the executable, not these companion files; the frontend embeds the same handoff.\n',
    );
    const notices = join(root, 'src-tauri/target/THIRD_PARTY_NOTICES.md');
    if (existsSync(notices))
      copyFileSync(notices, join(directory, 'THIRD_PARTY_NOTICES.md'));
    await tar('tar', [
      '-czf',
      join(scratch, `${name}.tgz`),
      '-C',
      scratch,
      name,
    ]);
    const bytes = readFileSync(join(scratch, `${name}.tgz`));
    const hash = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(output, { recursive: true });
    destination = join(output, `${name}.tgz`);
    writeOwned(destination, bytes);
    writeOwned(`${destination}.sha256`, `${hash}  ${name}.tgz\n`);
  } catch (error) {
    const failures = [error];
    for (const path of owned) {
      try {
        rmSync(path);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    failure =
      failures.length === 1
        ? error
        : new AggregateError(
            failures,
            'Archive creation and output cleanup failed.',
          );
  }
  try {
    rmSync(scratch, { recursive: true });
    if (existsSync(scratch)) throw new Error('Archive scratch cleanup failed.');
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          'Archive creation and scratch cleanup failed.',
        )
      : error;
  }
  if (failure) throw failure;
  return destination;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error(
        'Usage: node scripts/archive.mjs <supported Rust target>',
      );
    const root = fileURLToPath(new URL('../', import.meta.url));
    const target = process.argv[2];
    console.log(
      await archive({
        root,
        target,
        binary: join(
          root,
          `src-tauri/target/release/taurimd${target === targets[1] ? '.exe' : ''}`,
        ),
        output: join(root, 'src-tauri/target/binstall'),
      }),
    );
  } catch (error) {
    console.error(`Archive preparation stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
