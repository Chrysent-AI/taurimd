import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command } from './fixture-command.mjs';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../../', import.meta.url));
function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, result.output);
  return result.output.trim();
}
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'taurimd-hooks-'));
  try {
    git(root, 'init', '--initial-branch=main');
    cpSync(resolve(project, 'scripts'), join(root, 'scripts'), {
      recursive: true,
    });
    for (const name of ['.gitleaks.toml', 'commitlint.config.js'])
      cpSync(resolve(project, name), join(root, name));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    symlinkSync(
      resolve(project, 'node_modules'),
      join(root, 'node_modules'),
      'junction',
    );
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}
const scan = (root, ...args) =>
  command(root, process.execPath, ['scripts/secrets.mjs', ...args]);
const synthetic = () => ['reader.fixture', 'gmail.com'].join('@');
function commitObject(root, tree, parents, message) {
  // Fixture objects do not consult or change a developer's Git identity.
  const content = `tree ${tree}\n${parents.map((id) => `parent ${id}\n`).join('')}author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n${message}\n`;
  const result = command(
    root,
    'git',
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    { input: content },
  );
  assert.equal(result.status, 0, result.output);
  return result.output.trim();
}
function commit(root, name, contents, message = 'test: add fixture') {
  writeFileSync(join(root, name), contents);
  git(root, 'add', '--', name);
  const current = command(root, 'git', ['rev-parse', '--verify', 'HEAD']);
  const parents = current.status === 0 ? [current.output.trim()] : [];
  const id = commitObject(root, git(root, 'write-tree'), parents, message);
  git(root, 'update-ref', 'HEAD', id);
  return id;
}
test('staged native Git traversal rejects introduced content, including allow comments', () =>
  fixture((root) => {
    commit(root, 'clean.txt', 'clean\n');
    assert.equal(scan(root, 'staged').status, 0);
    writeFileSync(
      join(root, 'candidate.txt'),
      `contact = '${synthetic()}' # gitleaks:allow\n`,
    );
    git(root, 'add', 'candidate.txt');
    const result = scan(root, 'staged');
    assert.notEqual(result.status, 0);
    assert.match(result.output, /consumer-email/);
    assert.doesNotMatch(
      result.output,
      new RegExp(synthetic().replace('.', '\\.')),
    );
    const report = join(root, 'report.json');
    const nativeArgs = [
      'git',
      '--pre-commit',
      '--staged',
      '--ignore-gitleaks-allow',
      '--redact=100',
      '--config',
      '.gitleaks.toml',
      '--report-format',
      'json',
      '--report-path',
      report,
      '.',
    ];
    assert.notEqual(command(root, 'gitleaks', nativeArgs).status, 0);
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(typeof findings[0]?.Fingerprint, 'string');
    writeFileSync(
      join(root, '.gitleaksignore'),
      `${findings[0].Fingerprint}\n`,
    );
    assert.equal(command(root, 'gitleaks', nativeArgs).status, 0);
    assert.notEqual(scan(root, 'staged').status, 0);
  }));
test('Win32 local-device paths pass staged and full-message native scans', () =>
  fixture((root) => {
    const device = ['', '', '.', 'COM1'].join('\\');
    const message = join(root, 'message.txt');
    for (const value of [device, '%5c%5c.%5cCOM1']) {
      writeFileSync(join(root, 'candidate.txt'), `${value}\n`);
      git(root, 'add', 'candidate.txt');
      const staged = scan(root, 'staged');
      assert.equal(staged.status, 0, staged.output);
      writeFileSync(message, `test: local device fixture\n\n${value}\n`);
      const fullMessage = scan(root, 'message', message);
      assert.equal(fullMessage.status, 0, fullMessage.output);
    }
  }));
test('UNC hosts and admin shares remain rejected raw and percent-decoded', () =>
  fixture((root) => {
    const message = join(root, 'message.txt');
    for (const host of [
      'a',
      '0',
      '_',
      '-',
      '..',
      '.a',
      'a.',
      'host.example.invalid',
      'fixture-host',
    ]) {
      for (const share of ['share', 'C$']) {
        const unc = ['', '', host, share].join('\\');
        for (const value of [unc, encodeURIComponent(unc)]) {
          writeFileSync(join(root, 'candidate.txt'), `${value}\n`);
          git(root, 'add', 'candidate.txt');
          writeFileSync(message, `test: network fixture\n\n${value}\n`);
          for (const result of [
            scan(root, 'staged'),
            scan(root, 'message', message),
          ]) {
            assert.notEqual(result.status, 0, result.output);
            assert.match(result.output, /RuleID:\s+network-share/);
            assert.ok(
              !result.output.includes(value),
              'finding must be redacted',
            );
          }
        }
      }
    }
  }));
test('home paths and default secrets still fail staged and full-message scans', () =>
  fixture((root) => {
    const message = join(root, 'message.txt');
    for (const [rule, value] of [
      [
        'home-dir-path',
        `path = "${['', 'home', 'fixture-reader', 'document.md'].join('/')}"`,
      ],
      [
        'generic-api-key',
        `api_key = "${['r7K2v9M4', 'q6T8n3W5', 'b1Y0f2H9'].join('')}"`,
      ],
    ]) {
      writeFileSync(join(root, 'candidate.txt'), `${value}\n`);
      git(root, 'add', 'candidate.txt');
      writeFileSync(message, `test: privacy fixture\n\n${value}\n`);
      for (const result of [
        scan(root, 'staged'),
        scan(root, 'message', message),
      ]) {
        assert.notEqual(result.status, 0, result.output);
        assert.match(result.output, new RegExp(`RuleID:\\s+${rule}`));
        assert.ok(!result.output.includes(value), 'finding must be redacted');
      }
    }
  }));
test('complete messages and strict subjects fail closed without merge/init exemptions', () =>
  fixture((root) => {
    const message = join(root, 'message.txt');
    writeFileSync(message, 'feat: read local files\n\nReadable body.\n');
    assert.equal(scan(root, 'message', message).status, 0);
    writeFileSync(
      message,
      `feat: read local files\n\nContact: ${synthetic()}\n`,
    );
    assert.notEqual(scan(root, 'message', message).status, 0);
    for (const subject of [
      'init',
      'Merge branch feature',
      'Revert "old change"',
    ]) {
      writeFileSync(message, `${subject}\n`);
      assert.notEqual(scan(root, 'message', message).status, 0);
    }
  }));
test('range sees introduced-then-deleted content and complete messages', () =>
  fixture((root) => {
    const base = commit(root, 'clean.txt', 'clean\n');
    commit(root, 'history.txt', synthetic());
    const head = commit(root, 'history.txt', 'removed\n');
    const result = scan(root, 'range', '--base', base, '--head', head);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /consumer-email/);
  }));
test('initial traversal scans root content before accepting its conventional message', () =>
  fixture((root) => {
    const head = commit(root, 'initial.txt', synthetic());
    const result = scan(root, 'range', '--initial', head);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /consumer-email/);
  }));
test('the exact existing bootstrap object keeps scanning and skips only historical format', () => {
  const legacy = '9116eedb060c327c637f8556d88eea18cc098e94';
  const result = scan(project, 'range', '--initial', legacy);
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    new RegExp(`Checking complete message for ${legacy}`),
  );
  assert.match(result.output, /Full-message secret scan passed/);
  assert.equal((result.output.match(/no leaks found/g) ?? []).length, 2);
});
test('root-inclusive initial policy rejects legacy init and invalid ranges', () =>
  fixture((root) => {
    const head = commit(root, 'clean.txt', 'clean\n', 'init');
    const result = scan(root, 'range', '--initial', head);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /subject-empty|type-empty/);
    assert.notEqual(
      scan(root, 'range', '--base', '0'.repeat(40), '--head', head).status,
      0,
    );
  }));
test('clean range passes, but a secret complete message fails independently', () =>
  fixture((root) => {
    const base = commit(root, 'clean.txt', 'base\n');
    const head = commit(root, 'clean.txt', 'next\n');
    assert.equal(scan(root, 'range', '--base', base, '--head', head).status, 0);
    const unsafeHead = commit(
      root,
      'clean.txt',
      'final\n',
      `test: add fixture\n\nContact: ${synthetic()}`,
    );
    assert.notEqual(
      scan(root, 'range', '--base', head, '--head', unsafeHead).status,
      0,
    );
  }));
test('merge-parent traversal catches content introduced in a merge tree', () =>
  fixture((root) => {
    const base = commit(root, 'base.txt', 'base\n');
    git(root, 'checkout', '-b', 'side');
    const side = commit(root, 'side.txt', 'side\n');
    git(root, 'checkout', 'main');
    const main = commit(root, 'main.txt', 'main\n');
    writeFileSync(join(root, 'merged.txt'), synthetic());
    git(root, 'add', 'merged.txt');
    const tree = git(root, 'write-tree');
    const merged = commitObject(
      root,
      tree,
      [main, side],
      'test: merge fixture',
    );
    assert.notEqual(
      scan(root, 'range', '--base', base, '--head', merged).status,
      0,
    );
  }));
test(
  'malformed scanner config and missing/wrong scanner reject clean inputs',
  { skip: process.platform === 'win32' },
  () =>
    fixture((root) => {
      const message = join(root, 'message.txt');
      writeFileSync(message, 'feat: clean input\n');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const missing = command(
        root,
        process.execPath,
        ['scripts/secrets.mjs', 'message', message],
        { env: { PATH: bin } },
      );
      assert.notEqual(missing.status, 0);
      writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\necho 8.29.0\n', {
        mode: 0o755,
      });
      assert.notEqual(
        command(
          root,
          process.execPath,
          ['scripts/secrets.mjs', 'message', message],
          { env: { PATH: bin } },
        ).status,
        0,
      );
      writeFileSync(join(root, '.gitleaks.toml'), '[invalid');
      assert.notEqual(scan(root, 'message', message).status, 0);
    }),
);
test('installed production hooks reject staged content and messages without changing HEAD', () =>
  fixture((root) => {
    const head = commit(root, 'clean.txt', 'clean\n');
    assert.equal(
      command(root, process.execPath, ['scripts/hooks.mjs']).status,
      0,
    );
    writeFileSync(join(root, 'unsafe.txt'), synthetic());
    git(root, 'add', 'unsafe.txt');
    const rejected = command(root, 'git', ['hook', 'run', 'pre-commit']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /consumer-email/);
    const message = join(root, 'message.txt');
    writeFileSync(message, 'feat: clean hook message\n');
    assert.equal(
      command(root, 'git', ['hook', 'run', 'commit-msg', '--', message]).status,
      0,
    );
    writeFileSync(message, `feat: clean subject\n\n${synthetic()}\n`);
    assert.notEqual(
      command(root, 'git', ['hook', 'run', 'commit-msg', '--', message]).status,
      0,
    );
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  }));
test('shared type and test commands reject real failures and accept a repaired fixture', () =>
  fixture((root) => {
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'es2022',
        },
        include: ['bad.ts'],
      }),
    );
    writeFileSync(
      join(root, 'bad.ts'),
      'const count: number = "not a number";',
    );
    const rejected = command(root, process.execPath, [
      'scripts/check.mjs',
      'types',
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /TS2322/);
    writeFileSync(join(root, 'bad.ts'), 'const count: number = 1;');
    assert.equal(
      command(root, process.execPath, ['scripts/check.mjs', 'types']).status,
      0,
    );
    writeFileSync(
      join(root, 'fixture.test.ts'),
      "import {it,expect} from 'vitest'; it('fixture outcome',()=>{expect(1).toBe(2)});",
    );
    assert.notEqual(
      command(root, process.execPath, ['scripts/check.mjs', 'test']).status,
      0,
    );
    writeFileSync(
      join(root, 'fixture.test.ts'),
      "import {it,expect} from 'vitest'; it('fixture outcome',()=>{expect(1).toBe(1)});",
    );
    assert.equal(
      command(root, process.execPath, ['scripts/check.mjs', 'test']).status,
      0,
    );
  }));
test('managed hook description may change but executable bytes and permissions cannot', () =>
  fixture((root) => {
    const install = () =>
      command(root, process.execPath, ['scripts/hooks.mjs']);
    assert.equal(install().status, 0);
    const path = join(root, '.git/hooks/pre-commit');
    const original = readFileSync(path, 'utf8');
    const commentOnly = original.replace(
      /^# Repository managed dispatcher[^\n]*$/m,
      '# Earlier managed description',
    );
    assert.notEqual(commentOnly, original);
    writeFileSync(path, commentOnly);
    assert.equal(install().status, 0);
    assert.equal(readFileSync(path, 'utf8'), commentOnly);
    const changed = commentOnly.replace(
      'exec node scripts/check.mjs',
      'exec node other.mjs',
    );
    writeFileSync(path, changed);
    assert.notEqual(install().status, 0);
    assert.equal(readFileSync(path, 'utf8'), changed);
    if (process.platform !== 'win32') {
      writeFileSync(path, commentOnly);
      chmodSync(path, 0o644);
      assert.notEqual(install().status, 0);
      chmodSync(path, 0o755);
    }
  }));

test('documented installer preserves existing hooks and custom routing', () =>
  fixture((root) => {
    git(root, 'config', 'core.hooksPath', '.custom-hooks');
    mkdirSync(join(root, '.custom-hooks'));
    const old = '#!/bin/sh\nexit 23\n';
    writeFileSync(join(root, '.custom-hooks/pre-commit'), old, { mode: 0o755 });
    const result = command(root, process.execPath, ['scripts/hooks.mjs']);
    assert.notEqual(result.status, 0);
    assert.equal(
      readFileSync(join(root, '.custom-hooks/pre-commit'), 'utf8'),
      old,
    );
    assert.equal(existsSync(join(root, '.custom-hooks/commit-msg')), false);
  }));
test('effective linked/custom hooks discover the invoking checkout and preserve arguments/status', () =>
  fixture((root) => {
    // A small fixture check target isolates hook routing from the expensive product gate.
    writeFileSync(
      join(root, 'scripts/check.mjs'),
      "import {writeFileSync} from 'node:fs'; writeFileSync('route.json', JSON.stringify(process.argv.slice(2))); if(process.argv[3] === 'reject') process.exitCode=19;\n",
    );
    git(root, 'config', 'core.hooksPath', '.custom-hooks');
    assert.equal(
      command(root, process.execPath, ['scripts/hooks.mjs']).status,
      0,
    );
    assert.equal(
      command(root, 'git', [
        'hook',
        'run',
        'commit-msg',
        '--',
        'message with spaces',
      ]).status,
      0,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'route.json'), 'utf8')),
      ['message', 'message with spaces'],
    );
    assert.notEqual(
      command(root, 'git', ['hook', 'run', 'commit-msg', '--', 'reject'])
        .status,
      0,
    );
    // A fresh linked repository uses common hooks, without a custom override.
    const linkedRoot = join(root, 'linked-repo');
    mkdirSync(linkedRoot);
    git(linkedRoot, 'init', '--initial-branch=main');
    commit(linkedRoot, 'README.md', 'fixture\n');
    cpSync(join(root, 'scripts'), join(linkedRoot, 'scripts'), {
      recursive: true,
    });
    assert.equal(
      command(linkedRoot, process.execPath, ['scripts/hooks.mjs']).status,
      0,
    );
    const linked = join(root, 'linked-worktree');
    git(linkedRoot, 'worktree', 'add', '-b', 'linked-test', linked);
    mkdirSync(join(linked, 'scripts'));
    writeFileSync(
      join(linked, 'scripts/check.mjs'),
      "import {writeFileSync} from 'node:fs'; writeFileSync('linked-route.txt', process.argv[2]);\n",
    );
    assert.equal(
      command(linked, 'git', ['hook', 'run', 'pre-commit']).status,
      0,
    );
    assert.equal(
      readFileSync(join(linked, 'linked-route.txt'), 'utf8'),
      'precommit',
    );
    assert.equal(existsSync(join(linkedRoot, 'linked-route.txt')), false);
  }));
