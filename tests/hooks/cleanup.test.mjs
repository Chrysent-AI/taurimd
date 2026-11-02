import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../scripts/run.mjs';

const makefile = fileURLToPath(new URL('../../Makefile', import.meta.url));
const make = spawnSync('make', ['--version'], {
  encoding: 'utf8',
  timeout: 5000,
});
const optionalMake =
  process.platform === 'win32' || !make.stdout?.includes('GNU Make')
    ? 'Optional GNU Make/POSIX shell convenience is unavailable; use Cargo directly.'
    : false;

function snapshot(root, prefix = '') {
  return Object.fromEntries(
    readdirSync(join(root, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const name = join(prefix, entry.name);
        return entry.isDirectory()
          ? [[name, 'directory'], ...Object.entries(snapshot(root, name))]
          : [
              [
                name,
                createHash('sha256')
                  .update(readFileSync(join(root, name)))
                  .digest('hex'),
              ],
            ];
      }),
  );
}

async function invoke(cwd, args, env) {
  // Reuse the production runner's interruption/group teardown; the timer is a hang guard.
  const guard = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 15000);
  try {
    await run('make', ['--no-print-directory', '-f', makefile, ...args], {
      cwd,
      env,
    });
  } finally {
    clearTimeout(guard);
  }
}

test(
  'manual Cargo cleanup previews unchanged and cleans only selected host/cross profiles',
  { skip: optionalMake },
  async (t) => {
    const root = mkdtempSync('/tmp/taurimd-clean-builds-');
    const checkout = join(root, 'selected checkout');
    const put = (name, text = `retained ${name}\n`) => {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    };
    const removed = [];
    try {
      put(
        'selected checkout/src-tauri/Cargo.toml',
        '[package]\nname = "cleanup-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      put(
        'selected checkout/src-tauri/Cargo.lock',
        'version = 4\n[[package]]\nname = "cleanup-fixture"\nversion = "0.1.0"\n',
      );
      put('selected checkout/src-tauri/src/lib.rs', '');
      put(
        'selected checkout/src-tauri/target/CACHEDIR.TAG',
        'Signature: 8a477f597d28d172789f06886806bc55\n',
      );
      for (const target of [
        '',
        'aarch64-apple-darwin/',
        'wasm32-unknown-unknown/',
      ]) {
        for (const profile of ['debug', 'release']) {
          const directory = `selected checkout/src-tauri/target/${target}${profile}`;
          put(`${directory}/build/sentinel`);
          removed.push(directory);
        }
      }
      for (const name of [
        'selected checkout/src-tauri/target/native-candidates/debug/retained-binary',
        'selected checkout/src-tauri/target/THIRD_PARTY_NOTICES.md',
        'selected checkout/src-tauri/target/evidence/debug/proof',
        'selected checkout/src-tauri/target/doc/index.html',
        'selected checkout/src-tauri/target/custom-profile/keep',
        'selected checkout/artifacts/proof',
        'selected checkout/node_modules/cache',
        'browser-cache/binary',
        'other checkout/src-tauri/target/debug/keep',
        'other checkout/src-tauri/target/release/keep',
        'configured-output/debug/keep',
        'configured-output/release/keep',
        'inherited-output/debug/keep',
        'inherited-output/release/keep',
      ])
        put(name);
      put(
        '.cargo/config.toml',
        `[build]\ntarget-dir = ${JSON.stringify(join(root, 'configured-output'))}\nbuild-dir = ${JSON.stringify(join(root, 'configured-output'))}\n`,
      );
      const env = {
        CARGO_TARGET_DIR: join(root, 'inherited-output'),
        CARGO_BUILD_BUILD_DIR: join(root, 'inherited-output'),
        CARGO_BUILD_TARGET: 'wasm32-unknown-unknown',
      };
      const before = snapshot(root);
      t.diagnostic(`before: ${JSON.stringify(before)}`);
      await invoke(checkout, [], env);
      assert.deepEqual(
        snapshot(root),
        before,
        'bare make must not change any fixture',
      );
      await invoke(checkout, ['clean-builds-preview'], env);
      assert.deepEqual(
        snapshot(root),
        before,
        'default checkout preview must not mutate anything',
      );
      await invoke(root, ['clean-builds-preview', `WORKTREE=${checkout}`], env);
      assert.deepEqual(
        snapshot(root),
        before,
        'explicit checkout preview must not mutate anything',
      );
      await invoke(root, ['clean-builds', `WORKTREE=${checkout}`], env);
      const expected = Object.fromEntries(
        Object.entries(before).filter(
          ([name]) =>
            !removed.some(
              (directory) =>
                name === directory || name.startsWith(`${directory}/`),
            ),
        ),
      );
      const after = snapshot(root);
      t.diagnostic(`after: ${JSON.stringify(after)}`);
      assert.deepEqual(
        after,
        expected,
        'only selected host/cross dev/release trees may disappear',
      );
      for (const name of removed)
        assert.equal(existsSync(join(root, name)), false, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
      assert.equal(
        existsSync(root),
        false,
        'owned scratch fixture must be gone',
      );
      t.diagnostic('owned scratch fixture absence verified');
    }
  },
);
