import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versions, stableVersion, increases } from './versions.mjs';

export function bumpVersion(root, args, replace = renameSync) {
  if (args.length > 1)
    throw new Error('Choose only --bump=patch|minor|major OR --version=X.Y.Z.');
  const option = args[0] ?? '--bump=patch';
  const snapshot = versions((path) =>
    readFileSync(resolve(root, path), 'utf8'),
  );
  let next;
  if (option.startsWith('--version=')) next = option.slice(10);
  else if (/^--bump=(patch|minor|major)$/.test(option)) {
    const parts = stableVersion(snapshot.version);
    const index = { major: 0, minor: 1, patch: 2 }[option.slice(7)];
    parts[index] += 1n;
    for (let i = index + 1; i < 3; i++) parts[i] = 0n;
    next = parts.join('.');
  } else
    throw new Error('Choose only --bump=patch|minor|major OR --version=X.Y.Z.');
  if (!increases(next, snapshot.version))
    throw new Error('New version must strictly increase.');
  const replacements = new Map(snapshot.files);
  for (const [path, text] of snapshot.files) {
    let updated = text;
    const spans = snapshot.records
      .filter(([name]) => name === path)
      .map(([, span]) => span)
      .sort((a, b) => b.start - a.start);
    for (const span of spans)
      updated =
        updated.slice(0, span.start) +
        next +
        updated.slice(span.start + span.value.length);
    replacements.set(path, updated);
  }
  versions((path) => replacements.get(path));
  const scratch = mkdtempSync(join(root, '.version-bump-'));
  const changed = [];
  let keepRecovery = false;
  let failure;
  try {
    let index = 0;
    for (const [path, text] of replacements) {
      const original = resolve(root, path);
      const backup = join(scratch, `${index}.old`);
      const stage = join(scratch, `${index}.new`);
      copyFileSync(original, backup);
      writeFileSync(stage, text);
      chmodSync(stage, statSync(original).mode);
      if (readFileSync(original, 'utf8') !== snapshot.files.get(path))
        throw new Error(
          'Concurrent edit detected; stop all other edits before bumping.',
        );
      replace(stage, original);
      changed.push({ original, backup });
      index++;
    }
  } catch (error) {
    const failures = [];
    for (const { original, backup } of changed.reverse()) {
      try {
        renameSync(backup, original);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) {
      keepRecovery = true;
      failure = new AggregateError(
        [error, ...failures],
        `Restore failed; recover originals from ${scratch.slice(root.length + 1)} before editing.`,
      );
    } else failure = error;
  }
  try {
    if (!keepRecovery) {
      rmSync(scratch, { recursive: true });
      if (existsSync(scratch))
        throw new Error('Version transaction cleanup failed.');
    }
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          'Version transaction and cleanup failed.',
        )
      : error;
  }
  if (failure) throw failure;
  return next;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    let args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--make-inputs') {
      args = [];
      if (process.env.TAURIMD_BUMP_ORIGIN !== 'undefined')
        args.push(`--bump=${process.env.TAURIMD_BUMP_VALUE ?? ''}`);
      if (process.env.TAURIMD_VERSION_ORIGIN !== 'undefined')
        args.push(`--version=${process.env.TAURIMD_VERSION_VALUE ?? ''}`);
    }
    console.log(
      `Version is now ${bumpVersion(root, args)}. No Git, network or publication operation performed.`,
    );
  } catch (error) {
    console.error(`Version bump stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
