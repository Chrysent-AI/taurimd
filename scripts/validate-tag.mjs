import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBoundary } from './versions.mjs';

export function validateTag(
  root,
  tag,
  readGit = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? ''))
    throw new Error('Release tag must be exactly vX.Y.Z.');
  const git = (...args) => readGit(...args).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false')
    throw new Error('Complete ancestry is required for release validation.');
  const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  if (git('rev-parse', 'HEAD') !== commit)
    throw new Error('Checkout must be the tagged commit.');
  const [head, ...parents] = git(
    'rev-list',
    '--parents',
    '-n',
    '1',
    commit,
  ).split(' ');
  if (head !== commit) throw new Error('Cannot resolve release ancestry.');
  const readAt = (id) => (path) => readGit('show', `${id}:${path}`);
  return releaseBoundary({
    tag,
    read: readAt(commit),
    parentRead: parents[0] ? readAt(parents[0]) : undefined,
    rootCommit: parents.length === 0,
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/validate-tag.mjs vX.Y.Z');
    console.log(
      `Validated release version ${validateTag(fileURLToPath(new URL('../', import.meta.url)), process.argv[2])}.`,
    );
  } catch (error) {
    console.error(`Release validation stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
