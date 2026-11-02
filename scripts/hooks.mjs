import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
export const hookText = (mode) => `#!/bin/sh
# Repository managed dispatcher; resolves the invoking checkout.
set -eu
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"
command -v node >/dev/null 2>&1 || { echo "Node is required for repository protection." >&2; exit 1; }
exec node scripts/check.mjs ${mode} "$@"
`;
export function install() {
  const root = realpathSync(git('rev-parse', '--show-toplevel'));
  const common = realpathSync(resolve(git('rev-parse', '--git-common-dir')));
  const hooks = resolve(
    git('rev-parse', '--path-format=absolute', '--git-path', 'hooks'),
  );
  const inside = (parent, path) => {
    const rel = relative(parent, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  let override = '';
  try {
    override = git('config', '--show-origin', '--get', 'core.hooksPath');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  console.log(
    override
      ? 'Configured hook route detected; checking project containment and preservation.'
      : 'Default common hook route detected.',
  );
  if (!inside(root, hooks) && hooks !== join(common, 'hooks'))
    throw new Error(
      'Hook route is outside this project. Preserve it and chain the documented commands through its owner.',
    );
  if (existsSync(hooks) && lstatSync(hooks).isSymbolicLink())
    throw new Error(
      'Refusing a symlinked hooks directory. Preserve and integrate its existing route explicitly.',
    );
  mkdirSync(hooks, { recursive: true });
  const effective = realpathSync(hooks);
  if (!inside(root, effective) && effective !== join(common, 'hooks'))
    throw new Error('Resolved hook directory is outside the project.');
  const entries = [
    ['pre-commit', 'precommit'],
    ['commit-msg', 'message'],
  ].map(([name, mode]) => ({ path: join(hooks, name), text: hookText(mode) }));
  for (const entry of entries) {
    try {
      const info = lstatSync(entry.path);
      // Only the description line may vary; executable bytes must be identical.
      const body = (text) => text.replace(/^#[^\n]*\n(?=set -eu\n)/m, '');
      if (
        !info.isFile() ||
        body(readFileSync(entry.path, 'utf8')) !== body(entry.text)
      )
        throw new Error(
          'Existing protection must not be overwritten. Chain check:local/staged and check:commit through its supported installer.',
        );
      accessSync(entry.path, constants.X_OK);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const installed = [];
  try {
    for (const entry of entries) {
      if (existsSync(entry.path)) continue;
      writeFileSync(entry.path, entry.text, { flag: 'wx', mode: 0o755 });
      installed.push(entry);
    }
  } catch (error) {
    for (const entry of installed)
      if (readFileSync(entry.path, 'utf8') === entry.text)
        unlinkSync(entry.path);
    throw error;
  }
  console.log(
    'Effective project hook dispatchers installed without replacing existing protection. No Git configuration changed.',
  );
}
try {
  install();
} catch (error) {
  console.error(`Hook installation stopped: ${error.message}`);
  process.exitCode = 1;
}
