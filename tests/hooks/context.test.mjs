import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './fixture-command.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

function hookProbe() {
  // Only the owned outer hook may enter this mode; never recurse through the suite.
  const outer = realpathSync(process.cwd());
  assert.equal(process.env.GIT_DIR, join(outer, '.git'));
  assert.equal(process.env.GIT_WORK_TREE, outer);
  assert.equal(process.env.GIT_INDEX_FILE, join(outer, '.git/index'));
  assert.equal(process.env.MDVIEWERRSX_CONTEXT_FIXTURE, outer);
  const inner = join(outer, 'inner');
  mkdirSync(inner);
  const git = (...args) => {
    const result = command(inner, 'git', args);
    assert.equal(result.status, 0, result.output);
    return result.output.trim();
  };
  git('init', '--initial-branch=main');
  assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), inner);
  git('config', 'core.hooksPath', '.inner-hooks');
  git('config', 'core.bare', 'true');
  git('config', 'core.bare', 'false');
  // Supplying options must not reintroduce the invoking repository's context.
  const explicit = command(
    inner,
    'git',
    ['config', '--local', 'fixture.inner', 'yes'],
    {
      env: { ...process.env },
    },
  );
  assert.equal(explicit.status, 0, explicit.output);
  assert.equal(git('config', '--local', 'fixture.inner'), 'yes');
  for (const key of ['fixture.context', 'fixture.parameter'])
    assert.equal(command(inner, 'git', ['config', '--get', key]).status, 1);
  const marker = command(inner, process.execPath, [
    '-e',
    'process.stdout.write(process.env.MDVIEWERRSX_CONTEXT_FIXTURE)',
  ]);
  assert.equal(marker.status, 0, marker.output);
  assert.equal(marker.output, outer);
  assert.equal(process.env.GIT_DIR, join(outer, '.git'));
  writeFileSync(join(inner, 'inner.txt'), 'inner content\n');
  git('add', 'inner.txt');
  const tree = git('write-tree');
  const object = command(
    inner,
    'git',
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    {
      input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\ntest: isolate inner repository\n`,
    },
  );
  assert.equal(object.status, 0, object.output);
  git('update-ref', 'HEAD', object.output.trim());
  git('checkout', '-b', 'side');
  git('checkout', 'main');
  git('worktree', 'add', '-b', 'linked', join(outer, 'inner-linked'));
  writeFileSync('probe-passed.txt', 'inner mutations stayed isolated\n');
}

if (process.argv[2] === 'hook-probe') {
  hookProbe();
} else {
  test('foreign fixture commands cannot mutate the invoking hook repository', () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'mdviewerrsx-git-context-')),
    );
    const outer = join(root, 'outer');
    // Independent bootstrap: no inherited Git repository, index or config context.
    const env = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'unused-global-config'),
    };
    for (const name of [
      'PATH',
      'Path',
      'SystemRoot',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
    ])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const invoke = (program, args, options = {}) => {
      const result = spawnSync(program, args, {
        cwd: outer,
        encoding: 'utf8',
        ...options,
        env: { ...env, ...options.env },
      });
      if (result.error) throw result.error;
      assert.equal(
        result.status,
        0,
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
      );
      if (args[0] === 'hook')
        process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      return result.stdout.trim();
    };
    const git = (...args) => invoke('git', args);
    const snapshot = () => ({
      head: digest(readFileSync(join(outer, '.git/HEAD'))),
      refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
      index: digest(readFileSync(join(outer, '.git/index'))),
      config: digest(readFileSync(join(outer, '.git/config'))),
      worktrees: digest(git('worktree', 'list', '--porcelain')),
    });
    try {
      mkdirSync(outer);
      git('init', '--initial-branch=main');
      assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), outer);
      assert.equal(
        realpathSync(git('rev-parse', '--absolute-git-dir')),
        join(outer, '.git'),
      );
      writeFileSync(join(outer, 'sentinel.txt'), 'committed sentinel\n');
      git('add', 'sentinel.txt');
      const tree = git('write-tree');
      const id = invoke(
        'git',
        ['hash-object', '-t', 'commit', '-w', '--stdin'],
        {
          input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\ntest: own outer context\n`,
        },
      );
      git('update-ref', 'HEAD', id);
      writeFileSync(join(outer, 'sentinel.txt'), 'staged sentinel\n');
      git('add', 'sentinel.txt');
      cpSync(join(project, 'scripts'), join(outer, 'scripts'), {
        recursive: true,
      });
      mkdirSync(join(outer, 'tests/hooks'), { recursive: true });
      for (const name of [
        'context.test.mjs',
        'fixture-command.mjs',
        'protection.test.mjs',
      ])
        cpSync(
          join(project, 'tests/hooks', name),
          join(outer, 'tests/hooks', name),
        );
      for (const name of ['.gitleaks.toml', 'commitlint.config.js'])
        cpSync(join(project, name), join(outer, name));
      writeFileSync(join(outer, 'package.json'), '{"type":"module"}');
      symlinkSync(
        join(project, 'node_modules'),
        join(outer, 'node_modules'),
        'junction',
      );
      writeFileSync(
        join(outer, '.git/hooks/pre-commit'),
        '#!/bin/sh\n"$MDVIEWERRSX_TEST_NODE" tests/hooks/context.test.mjs hook-probe || exit $?\nexec "$MDVIEWERRSX_TEST_NODE" --test --test-name-pattern="staged native Git traversal|merge-parent traversal|effective linked/custom hooks" tests/hooks/protection.test.mjs\n',
        { mode: 0o755 },
      );
      const before = snapshot();
      invoke('git', ['hook', 'run', 'pre-commit'], {
        env: {
          GIT_DIR: join(outer, '.git'),
          GIT_COMMON_DIR: join(outer, '.git'),
          GIT_WORK_TREE: outer,
          GIT_INDEX_FILE: join(outer, '.git/index'),
          GIT_CONFIG: join(outer, '.git/config'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'fixture.context',
          GIT_CONFIG_VALUE_0: 'outer',
          GIT_CONFIG_PARAMETERS: "'fixture.parameter=outer'",
          MDVIEWERRSX_TEST_NODE: process.execPath,
          MDVIEWERRSX_CONTEXT_FIXTURE: outer,
        },
      });
      assert.equal(
        readFileSync(join(outer, 'probe-passed.txt'), 'utf8'),
        'inner mutations stayed isolated\n',
      );
      assert.deepEqual(snapshot(), before);
      assert.equal(
        readFileSync(join(outer, 'sentinel.txt'), 'utf8'),
        'staged sentinel\n',
      );
      console.log(
        'Owned outer HEAD/refs/index/config/worktrees unchanged after inner mutations and representative protection tests.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  });
}
