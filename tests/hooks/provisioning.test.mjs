import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../../', import.meta.url));
function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), 'mdviewerrsx-provision-contract-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const name of ['check.mjs', 'run.mjs', 'secrets.mjs'])
      cpSync(join(project, 'scripts', name), join(root, 'scripts', name));
    const mockPackage = join(root, 'node_modules/@playwright/test');
    mkdirSync(mockPackage, { recursive: true });
    writeFileSync(join(mockPackage, 'package.json'), '{"type":"commonjs"}');
    // An owned stand-in records the contract. It cannot install or remove a browser.
    writeFileSync(
      join(mockPackage, 'cli.js'),
      "const fs=require('node:fs'); fs.writeFileSync('contract.json', JSON.stringify({args:process.argv.slice(2), skip:process.env.PLAYWRIGHT_SKIP_BROWSER_GC, inherited:process.env.MDVIEWERRSX_FIXTURE_MARKER})); if(process.env.MDVIEWERRSX_FIXTURE_FAIL==='1')process.exitCode=9;",
    );
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}
function invoke(root, args = [], fail = false) {
  return spawnSync(
    process.execPath,
    ['scripts/check.mjs', 'browsers', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_GC: '0',
        MDVIEWERRSX_FIXTURE_MARKER: 'kept',
        MDVIEWERRSX_FIXTURE_FAIL: fail ? '1' : '0',
      },
    },
  );
}
test('browser provisioning forces the cache-preserving environment for all supported browsers', () =>
  fixture((root) => {
    const result = invoke(root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8')),
      {
        args: ['install', 'chromium', 'firefox', 'webkit'],
        skip: '1',
        inherited: 'kept',
      },
    );
    const ci = invoke(root, ['--with-deps']);
    assert.equal(ci.status, 0, ci.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8')).args,
      ['install', '--with-deps', 'chromium', 'firefox', 'webkit'],
    );
  }));
test('browser provisioning rejects force/uninstall arguments before executing a child', () =>
  fixture((root) => {
    for (const args of [
      ['--force'],
      ['uninstall'],
      ['--with-deps', '--force'],
    ]) {
      assert.notEqual(invoke(root, args).status, 0);
      assert.equal(existsSync(join(root, 'contract.json')), false);
    }
  }));
test('browser provisioning propagates the provisioner failure', () =>
  fixture((root) => {
    const result = invoke(root, [], true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed/);
  }));
