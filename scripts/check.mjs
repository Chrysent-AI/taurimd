import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
import { preparePackage } from './prepare-package.mjs';
import { scan, scannerPreflight } from './secrets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const node = (path, args = []) =>
  run(process.execPath, [resolve(root, path), ...args], { cwd: root });
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
  if (process.versions.node !== '22.22.2')
    throw new Error('Use Node 22.22.2 for the shared checks.');
  const rustVersion = execFileSync('rustc', ['--version'], {
    encoding: 'utf8',
  });
  if (!rustVersion.startsWith('rustc 1.97.1 '))
    throw new Error('Use Rust 1.97.1 for the shared checks.');
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
      'Choose a focused frontend check, local, rust, precommit, message or ci.',
    );
} catch (error) {
  console.error(`Check failed: ${error.message}`);
  process.exitCode = 1;
}
