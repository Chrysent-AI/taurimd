import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Discover names only, without consulting the invoking hook's repository/config.
const bootstrapEnv = {};
for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'])
  if (process.env[name] !== undefined) bootstrapEnv[name] = process.env[name];
const discovery = spawnSync('git', ['rev-parse', '--local-env-vars'], {
  cwd: tmpdir(),
  env: bootstrapEnv,
  encoding: 'utf8',
});
if (discovery.error) throw discovery.error;
if (discovery.status !== 0)
  throw new Error('Cannot discover repository-local Git environment names.');
const localNames = discovery.stdout.trim().split(/\s+/);
if (
  !localNames.length ||
  localNames.some((name) => !/^GIT_[A-Z_]+$/.test(name))
)
  throw new Error('Invalid repository-local Git environment names.');
const localKeys = new Set(localNames);

export function command(cwd, program, args, options = {}) {
  // cwd alone cannot select a foreign repository from inside a Git hook.
  // An explicit options.env replaces inheritance (including missing-tool PATHs).
  const env = { ...(options.env ?? process.env) };
  for (const name of Object.keys(env))
    if (localKeys.has(name.toUpperCase())) delete env[name];
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    ...options,
    env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}
