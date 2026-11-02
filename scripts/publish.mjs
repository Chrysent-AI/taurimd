import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoVersion, versionPaths } from './versions.mjs';

export const tokenFile = '.env';
export const tokenName = 'CARGO_REGISTRY_TOKEN';

// The token never enters the repository: it comes from the environment or from
// the gitignored .env file, and only ever reaches the Cargo process.
export function resolveToken(root, env = process.env) {
  const exported = env[tokenName];
  if (exported && exported.trim()) return exported.trim();
  const file = join(root, tokenFile);
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*CARGO_REGISTRY_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  return '';
}

export function publishCrate(root, options = {}) {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const run =
    options.run ??
    ((program, args, runOptions) => execFileSync(program, args, runOptions));
  const token = resolveToken(root, env);
  if (!token)
    throw new Error(
      `${tokenName} is not set and ${tokenFile} does not provide it.`,
    );
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (status)
    throw new Error(
      `The working tree has uncommitted changes; the crate would package uncommitted bytes:\n${status}`,
    );
  const version = cargoVersion(
    readFileSync(join(root, versionPaths[0]), 'utf8'),
  );
  const args = [
    'publish',
    '--registry',
    'crates-io',
    '--locked',
    '--manifest-path',
    join(root, 'src-tauri', 'Cargo.toml'),
  ];
  if (dryRun) args.push('--dry-run');
  run('cargo', args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...env,
      [tokenName]: token,
      CARGO_REGISTRY_CREDENTIAL_PROVIDER: 'cargo:token',
    },
  });
  return { dryRun, version };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const dryRun = process.argv.includes('--dry-run');
    const result = publishCrate(root, { dryRun });
    console.log(
      result.dryRun
        ? `Publish rehearsal for version ${result.version} finished; nothing was uploaded.`
        : `Published version ${result.version} to crates.io.`,
    );
  } catch (error) {
    console.error(`Publication stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
