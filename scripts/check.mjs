import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
import { preparePackage } from './prepare-package.mjs';
import { scan, scannerPreflight } from './secrets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const node = (path, args = []) =>
  run(process.execPath, [resolve(root, path), ...args], { cwd: root });

// One Node version runs everything this repository does: the gate, the
// frontend build, the Tauri build and the browser suite. The version is
// pinned in .node-version, which fnm reads. When the active Node is not that
// version, run again under the pinned one, so a build never happens on a
// different Node than the checks that guard it. A checkout without the file
// has no pin and runs on the Node it was started with.
let requiredNode = '';
try {
  requiredNode = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
} catch {
  requiredNode = '';
}
if (
  requiredNode &&
  process.versions.node !== requiredNode &&
  process.env.TAURIMD_NODE_PINNED !== '1'
) {
  // Probe first: a failure here means the pinned version cannot be selected,
  // while a failure of the real run below is the run's own and must speak for
  // itself.
  const probe = spawnSync(
    'fnm',
    ['exec', `--using=${requiredNode}`, '--', 'node', '--version'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  if (probe.error?.code === 'ENOENT') {
    console.error(
      `Node ${requiredNode} is pinned in .node-version and fnm is not installed. Install fnm, or install Node ${requiredNode} and select it with 'fnm use ${requiredNode}'.`,
    );
    process.exit(1);
  }
  if (probe.status !== 0) {
    console.error(
      `Node ${requiredNode} is pinned in .node-version but it could not be selected. Install it with 'fnm install ${requiredNode}' or select it with 'fnm use ${requiredNode}'.`,
    );
    process.exit(1);
  }
  const result = spawnSync(
    'fnm',
    [
      'exec',
      `--using=${requiredNode}`,
      '--',
      // The pinned binary, by name: fnm puts the selected version first on
      // PATH, so this is the pinned Node and not the one running now.
      'node',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, TAURIMD_NODE_PINNED: '1' } },
  );
  process.exit(result.status ?? 1);
}
if (requiredNode && process.versions.node !== requiredNode)
  console.error(
    `Node ${requiredNode} is pinned in .node-version; the active Node is ${process.versions.node}. Install it with 'fnm install ${requiredNode}' or select it with 'fnm use ${requiredNode}'.`,
  );
const commands = {
  format: () =>
    node('node_modules/prettier/bin/prettier.cjs', ['--check', '.']),
  lint: () =>
    node('node_modules/eslint/bin/eslint.js', ['.', '--max-warnings', '0']),
  types: () =>
    node('node_modules/typescript/bin/tsc', ['-b', '--pretty', 'false']),
  build: async () => {
    await node('node_modules/vite/bin/vite.js', ['build']);
    preparePackage(root);
  },
  test: () => node('node_modules/vitest/vitest.mjs', ['run']),
  hooks: () =>
    run(
      process.execPath,
      [
        '--test',
        ...readdirSync(resolve(root, 'tests/hooks'))
          .filter((name) => name.endsWith('.test.mjs'))
          .map((name) => resolve(root, 'tests/hooks', name)),
      ],
      { cwd: root },
    ),
};
async function rust() {
  for (const args of [
    ['fmt', '--all', '--', '--check'],
    ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
    ['test', '--locked', '--all-targets'],
    ['build', '--locked'],
  ]) {
    await run('cargo', args, { cwd: resolve(root, 'src-tauri') });
  }
}
async function local() {
  if (process.versions.node !== '26.13.0')
    throw new Error(
      'Use Node 26.13.0 for the shared checks. The version is pinned in .node-version; run `fnm use 26.13.0` (or `fnm default 26.13.0`).',
    );
  const rustVersion = execFileSync('rustc', ['--version'], {
    encoding: 'utf8',
  });
  if (!rustVersion.startsWith('rustc 1.99.1 '))
    throw new Error(
      'Use Rust 1.99.1 for the shared checks. The version is pinned in rust-toolchain.toml; run `rustup default 1.99.1`.',
    );
  scannerPreflight();
  await run('git', ['--version']);
  await run('cargo', ['fmt', '--version']);
  await run('cargo', ['clippy', '--version']);
  console.log(
    'Quality checks inspect working-tree files, NOT an isolated staged snapshot. Partial staging is permitted.',
  );
  for (const command of Object.values(commands)) await command();
  await rust();
}
try {
  const [mode, ...args] = process.argv.slice(2);
  if (Object.hasOwn(commands, mode)) await commands[mode]();
  else if (mode === 'browsers') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--with-deps'))
      throw new Error(
        'Browser provisioning accepts only optional --with-deps.',
      );
    await run(
      process.execPath,
      [
        resolve(root, 'node_modules/@playwright/test/cli.js'),
        'install',
        ...args,
        'chromium',
        'firefox',
        'webkit',
      ],
      {
        cwd: root,
        env: { PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
      },
    );
  } else if (mode === 'rust') await rust();
  else if (mode === 'dev')
    await node('node_modules/vite/bin/vite.js', [
      '--port',
      '1420',
      '--strictPort',
      ...args,
    ]);
  else if (mode === 'browser')
    await node('node_modules/@playwright/test/cli.js', ['test', ...args]);
  else if (mode === 'tauri')
    await node('node_modules/@tauri-apps/cli/tauri.js', args);
  else if (mode === 'local') await local();
  else if (mode === 'precommit') {
    await scan('staged');
    await local();
  } else if (mode === 'message') await scan('message', args);
  else if (mode === 'ci') {
    await scan('range', args);
    await local();
  } else
    throw new Error(
      'Choose a focused frontend check, local, rust, precommit, message, ci, dev, browser or tauri.',
    );
} catch (error) {
  console.error(`Check failed: ${error.message}`);
  process.exitCode = 1;
}
