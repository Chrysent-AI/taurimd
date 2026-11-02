import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  versionPaths,
  versions,
  releaseBoundary,
} from '../../scripts/versions.mjs';
import { bumpVersion } from '../../scripts/bump-version.mjs';
import { releaseVersion } from '../../scripts/release.mjs';
import { publishCrate, resolveToken } from '../../scripts/publish.mjs';
import { archive, targets } from '../../scripts/archive.mjs';
import { preparePackage } from '../../scripts/prepare-package.mjs';
import { command } from './fixture-command.mjs';
import { validateTag } from '../../scripts/validate-tag.mjs';
import { load } from 'js-yaml';

const project = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taurimd-delivery-'));
  t.after(() => {
    rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false);
  });
  for (const path of [
    ...versionPaths,
    'README.md',
    'LICENSE',
    'DEPENDENCIES.md',
    'Makefile',
    'scripts/bump-version.mjs',
    'scripts/publish.mjs',
    'scripts/release.mjs',
    'scripts/versions.mjs',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  // Keep test ancestry independent of future human changes to the project version.
  const source = versions((path) => readFileSync(join(root, path), 'utf8'));
  for (const [path, text] of source.files) {
    let normalized = text;
    for (const [, span] of source.records
      .filter(([name]) => name === path)
      .sort((a, b) => b[1].start - a[1].start))
      normalized =
        normalized.slice(0, span.start) +
        '0.1.0' +
        normalized.slice(span.start + span.value.length);
    writeFileSync(join(root, path), normalized);
  }
  return root;
}
const readAt = (root) => (path) => readFileSync(join(root, path), 'utf8');
const snapshot = (root) =>
  new Map(versionPaths.map((path) => [path, readAt(root)(path)]));
function assertUnchanged(root, before) {
  assert.deepEqual(snapshot(root), before);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith('.version-bump-')),
    false,
  );
}
for (const [args, expected] of [
  [[], '0.1.1'],
  [['--bump=minor'], '0.2.0'],
  [['--bump=major'], '1.0.0'],
  [['--version=2.3.4'], '2.3.4'],
]) {
  test(`version transaction ${args.join(' ') || 'default patch'} changes only six own versions`, (t) => {
    const root = fixture(t);
    const before = versions(readAt(root));
    assert.equal(bumpVersion(root, args), expected);
    const after = versions(readAt(root));
    assert.equal(after.version, expected);
    for (const path of versionPaths) {
      let original = after.files.get(path);
      for (const [, span] of after.records
        .filter(([name]) => name === path)
        .sort((a, b) => b[1].start - a[1].start)) {
        original =
          original.slice(0, span.start) +
          before.version +
          original.slice(span.start + expected.length);
      }
      assert.equal(
        original,
        before.files.get(path),
        `${path}: dependency bytes and formatting preserved`,
      );
    }
  });
}
test('invalid or conflicting version requests and mismatched duplicates write nothing', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  for (const args of [
    ['--bump=no'],
    ['--version=0.1.0'],
    ['--version=0.0.9'],
    ['--version=01.2.3'],
    ['--version=1.2.3-beta'],
    ['--version=1.2.3', '--bump=patch'],
    ['--version='],
    ['--bump=patch;exit 0'],
  ]) {
    assert.throws(() => bumpVersion(root, args));
    assertUnchanged(root, before);
  }
  const path = join(root, 'package-lock.json');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '"version": "0.1.0"',
      '"version": "9.0.0"',
    ),
  );
  const mismatch = snapshot(root);
  assert.throws(() => bumpVersion(root, []));
  assertUnchanged(root, mismatch);
});
test('each of the six independent own-version mismatches fails before writes', (t) => {
  const root = fixture(t);
  const source = versions(readAt(root));
  for (const [path, span] of source.records) {
    const text = source.files.get(path);
    writeFileSync(
      join(root, path),
      text.slice(0, span.start) +
        '9.0.0' +
        text.slice(span.start + span.value.length),
    );
    const mismatched = snapshot(root);
    assert.throws(() => bumpVersion(root, []));
    assertUnchanged(root, mismatched);
    writeFileSync(join(root, path), text);
  }
});

test('partial replacement failure restores every already-written file and removes transaction files', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  let replaced = 0;
  assert.throws(
    () =>
      bumpVersion(root, [], (from, to) => {
        if (++replaced === 4) throw new Error('injected rename failure');
        renameSync(from, to);
      }),
    /injected rename failure/,
  );
  assert.equal(replaced, 4);
  assertUnchanged(root, before);
});
function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release@example.invalid',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
}
function gitFixture(t) {
  const root = fixture(t);
  const env = gitEnv();
  for (const args of [
    ['init'],
    ['symbolic-ref', 'HEAD', 'refs/heads/main'],
    ['add', '-A'],
    ['commit', '-m', 'chore: fixture'],
  ]) {
    const result = command(root, 'git', args, { env });
    assert.equal(result.status, 0, result.output);
  }
  return { root, env };
}
const gitText = (root, env, args) =>
  command(root, 'git', args, { env }).output.trim();

test('the version module is a library and the release entry point needs a repository', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const library = command(root, process.execPath, [
    'scripts/bump-version.mjs',
    '--version=0.2.0',
  ]);
  assert.notEqual(library.status, 0, library.output);
  assert.match(library.output, /make bump-version/);
  const withoutRepository = command(root, process.execPath, [
    'scripts/release.mjs',
    '--version=0.2.0',
  ]);
  assert.notEqual(withoutRepository.status, 0, withoutRepository.output);
  assert.match(withoutRepository.output, /Git repository is required/);
  assertUnchanged(root, before);
});
test('the release command rewrites the six versions, commits them with a fixed message and tags the commit', (t) => {
  const { root, env } = gitFixture(t);
  const before = gitText(root, env, ['rev-list', '--count', 'HEAD']);
  const made = command(
    root,
    process.execPath,
    ['scripts/release.mjs', '--bump=minor'],
    { env },
  );
  assert.equal(made.status, 0, made.output);
  assert.equal(versions(readAt(root)).version, '0.2.0');
  assert.equal(
    gitText(root, env, ['log', '-1', '--format=%s']),
    'chore(release): taurimd v0.2.0',
  );
  const head = gitText(root, env, ['rev-parse', 'HEAD']);
  assert.equal(
    gitText(root, env, ['rev-parse', 'refs/tags/v0.2.0^{commit}']),
    head,
  );
  assert.equal(
    gitText(root, env, ['cat-file', '-t', 'refs/tags/v0.2.0']),
    'tag',
  );
  assert.equal(gitText(root, env, ['status', '--porcelain']), '');
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '2');
  assert.notEqual(before, '2');
  assert.deepEqual(
    gitText(root, env, ['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .sort(),
    [...versionPaths].sort(),
  );
});
test('the release command refuses a dirty tree, an existing tag and a branch that is not main', (t) => {
  const { root, env } = gitFixture(t);
  const readme = join(root, 'README.md');
  const original = readFileSync(readme, 'utf8');
  writeFileSync(readme, `${original}\nlocal edit\n`);
  const dirty = command(root, process.execPath, ['scripts/release.mjs'], {
    env,
  });
  assert.notEqual(dirty.status, 0, dirty.output);
  assert.match(dirty.output, /uncommitted changes/);
  writeFileSync(readme, original);
  assert.equal(gitText(root, env, ['status', '--porcelain']), '');

  assert.equal(command(root, 'git', ['tag', 'v0.1.1'], { env }).status, 0);
  const tagged = command(root, process.execPath, ['scripts/release.mjs'], {
    env,
  });
  assert.notEqual(tagged.status, 0, tagged.output);
  assert.match(tagged.output, /Tag v0\.1\.1 already exists/);
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(versions(readAt(root)).version, '0.1.0');

  assert.equal(
    command(root, 'git', ['checkout', '-b', 'feature/other'], { env }).status,
    0,
  );
  const branched = command(root, process.execPath, ['scripts/release.mjs'], {
    env,
  });
  assert.notEqual(branched.status, 0, branched.output);
  assert.match(branched.output, /Releases are cut from main/);
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(versions(readAt(root)).version, '0.1.0');
});
test('a failed release commit restores the version files and leaves no tag', (t) => {
  const { root, env } = gitFixture(t);
  const before = snapshot(root);
  const readGit = (...args) => {
    if (args[0] === 'commit') throw new Error('injected commit failure');
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  assert.throws(
    () => releaseVersion(root, [], { readGit }),
    /injected commit failure/,
  );
  assertUnchanged(root, before);
  assert.equal(gitText(root, env, ['tag', '--list']), '');
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(gitText(root, env, ['status', '--porcelain']), '');
  assert.equal(gitText(root, env, ['diff', '--cached', '--name-only']), '');
});
test('the release commit runs the protection hooks, and a rejecting hook aborts the release', (t) => {
  const { root, env } = gitFixture(t);
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const before = snapshot(root);
  const blocked = command(root, process.execPath, ['scripts/release.mjs'], {
    env,
  });
  assert.notEqual(blocked.status, 0, blocked.output);
  assert.match(blocked.output, /release commit failed/);
  assertUnchanged(root, before);
  assert.equal(gitText(root, env, ['status', '--porcelain']), '');
  assert.equal(gitText(root, env, ['diff', '--cached', '--name-only']), '');
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(gitText(root, env, ['tag', '--list']), '');
});
test('the release commit skips the protection hooks only when the gate is skipped', (t) => {
  const { root, env } = gitFixture(t);
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const made = command(root, process.execPath, ['scripts/release.mjs'], {
    env: { ...env, TAURIMD_RELEASE_SKIP_GATE: '1' },
  });
  assert.equal(made.status, 0, made.output);
  assert.equal(versions(readAt(root)).version, '0.1.1');
  assert.equal(
    gitText(root, env, ['log', '-1', '--format=%s']),
    'chore(release): taurimd v0.1.1',
  );
  assert.equal(gitText(root, env, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(
    gitText(root, env, ['rev-parse', 'refs/tags/v0.1.1^{commit}']),
    gitText(root, env, ['rev-parse', 'HEAD']),
  );
});
test('the release command refuses a repository that has no commit yet', (t) => {
  const root = fixture(t);
  const env = gitEnv();
  const before = snapshot(root);
  assert.equal(command(root, 'git', ['init'], { env }).status, 0);
  const empty = command(root, process.execPath, ['scripts/release.mjs'], {
    env,
  });
  assert.notEqual(empty.status, 0, empty.output);
  assert.match(empty.output, /needs a commit before a release/);
  assertUnchanged(root, before);
});
test('the publish command needs a registry token, refuses a dirty tree and passes the token only to Cargo', (t) => {
  const root = fixture(t);
  assert.equal(resolveToken(root, {}), '');
  writeFileSync(
    join(root, '.env'),
    '# comment\nCARGO_REGISTRY_TOKEN="file-token"\n',
  );
  assert.equal(resolveToken(root, {}), 'file-token');
  assert.equal(
    resolveToken(root, { CARGO_REGISTRY_TOKEN: 'env-token' }),
    'env-token',
  );
  const { root: gitRoot } = gitFixture(t);
  const calls = [];
  const run = (program, args, runOptions) => {
    calls.push({ program, args, env: runOptions.env });
  };
  const published = publishCrate(gitRoot, {
    env: { CARGO_REGISTRY_TOKEN: 'env-token' },
    run,
  });
  assert.equal(published.version, '0.1.0');
  assert.equal(published.dryRun, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'cargo');
  assert.ok(calls[0].args.includes('--locked'));
  assert.ok(calls[0].args.includes('crates-io'));
  assert.ok(calls[0].args.includes('--manifest-path'));
  assert.equal(calls[0].env.CARGO_REGISTRY_TOKEN, 'env-token');
  assert.equal(calls[0].env.CARGO_REGISTRY_CREDENTIAL_PROVIDER, 'cargo:token');
  const rehearsal = publishCrate(gitRoot, {
    dryRun: true,
    env: { CARGO_REGISTRY_TOKEN: 'env-token' },
    run,
  });
  assert.equal(rehearsal.dryRun, true);
  assert.ok(calls[1].args.includes('--dry-run'));
  writeFileSync(join(gitRoot, 'README.md'), 'local edit\n');
  assert.throws(
    () =>
      publishCrate(gitRoot, {
        env: { CARGO_REGISTRY_TOKEN: 'env-token' },
        run,
      }),
    /uncommitted changes/,
  );
  assert.throws(
    () => publishCrate(gitRoot, { env: {}, run }),
    /CARGO_REGISTRY_TOKEN is not set/,
  );
  assert.equal(calls.length, 2);
});
test('Make and direct Windows-friendly Node entry points validate data before writes', (t) => {
  const { root, env } = gitFixture(t);
  // An isolated copy exercises the CLI's own project-root resolution, not this checkout.
  const direct = command(
    root,
    process.execPath,
    ['scripts/release.mjs', '--version=0.2.0'],
    { env },
  );
  assert.equal(direct.status, 0, direct.output);
  assert.equal(versions(readAt(root)).version, '0.2.0');
  if (process.platform !== 'win32') {
    const made = command(root, 'make', ['bump-version', 'BUMP=minor'], { env });
    assert.equal(made.status, 0, made.output);
    assert.equal(versions(readAt(root)).version, '0.3.0');
    assert.equal(
      gitText(root, env, ['log', '-1', '--format=%s']),
      'chore(release): taurimd v0.3.0',
    );
    assert.equal(
      gitText(root, env, ['rev-parse', 'refs/tags/v0.3.0^{commit}']),
      gitText(root, env, ['rev-parse', 'HEAD']),
    );
    const before = snapshot(root);
    for (const args of [
      ['BUMP=patch', 'VERSION=0.4.0'],
      ['VERSION='],
      ['BUMP=patch;exit 0'],
    ]) {
      const result = command(root, 'make', ['bump-version', ...args], { env });
      assert.notEqual(result.status, 0, result.output);
      assertUnchanged(root, before);
    }
  }
});
test('release boundary requires a bump on the tagged commit, not merely a first tag or earlier bump', (t) => {
  const root = fixture(t);
  const previous = snapshot(root);
  const parentRead = (path) => previous.get(path);
  const old = readAt(root);
  assert.throws(
    () =>
      releaseBoundary({
        tag: 'v0.1.0',
        read: old,
        parentRead,
        rootCommit: false,
      }),
    /increase/,
  );
  assert.equal(
    releaseBoundary({ tag: 'v0.1.0', read: old, rootCommit: true }),
    '0.1.0',
  );
  assert.throws(
    () => releaseBoundary({ tag: 'v0.1.0', read: old, rootCommit: false }),
    /parent/,
  );
  bumpVersion(root, []);
  const read = readAt(root);
  assert.equal(
    releaseBoundary({ tag: 'v0.1.1', read, parentRead, rootCommit: false }),
    '0.1.1',
  );
  for (const tag of ['0.1.1', 'v0.1.0', 'v0.1.1-beta', 'v01.1.1', 'release']) {
    assert.throws(() =>
      releaseBoundary({ tag, read, parentRead, rootCommit: false }),
    );
  }
  assert.throws(
    () =>
      releaseBoundary({
        tag: 'v0.1.1',
        read,
        parentRead: read,
        rootCommit: false,
      }),
    /increase/,
  );
  const laterParent = (path) =>
    parentRead(path).replace('version = "0.1.0"', 'version = "9.0.0"');
  assert.throws(
    () =>
      releaseBoundary({
        tag: 'v0.1.1',
        read,
        parentRead: laterParent,
        rootCommit: false,
      }),
    /increase/,
  );
  assert.throws(
    () =>
      releaseBoundary({
        tag: 'v0.1.1',
        read,
        parentRead: () => {
          throw new Error('missing ancestry');
        },
        rootCommit: false,
      }),
    /missing ancestry/,
  );
});
function binary(target) {
  const data = Buffer.alloc(128);
  if (target === targets[0]) {
    data.writeUInt32LE(0xfeedfacf);
    data.writeUInt32LE(0x100000c, 4);
  }
  if (target === targets[1]) {
    data.write('MZ');
    data.writeUInt32LE(64, 60);
    data.write('PE\0\0', 64);
    data.writeUInt16LE(0x8664, 68);
  }
  if (target === targets[2]) {
    data.write('7f454c46', 0, 'hex');
    data[4] = 2;
    data[5] = 1;
    data.writeUInt16LE(62, 18);
  }
  return data;
}
for (const target of targets) {
  test(`archive uses binstall default tgz layout and manifest executable for ${target}`, async (t) => {
    const root = fixture(t);
    const executable = join(root, 'candidate');
    writeFileSync(executable, binary(target), { mode: 0o755 });
    const output = join(root, 'archives');
    const path = await archive({ root, target, binary: executable, output });
    const name = `taurimd-${target}-v0.1.0`;
    assert.equal(path, join(output, `${name}.tgz`));
    const unpacked = join(root, 'unpacked');
    mkdirSync(unpacked);
    const extract = command(root, 'tar', ['-xzf', path, '-C', unpacked]);
    assert.equal(extract.status, 0, extract.output);
    assert.deepEqual(
      readdirSync(join(unpacked, name)).sort(),
      [
        'DEPENDENCIES.md',
        'LICENSE',
        'NOTICES-STATUS.md',
        'README.md',
        `taurimd${target === targets[1] ? '.exe' : ''}`,
      ].sort(),
    );
    assert.deepEqual(
      readFileSync(
        join(unpacked, name, `taurimd${target === targets[1] ? '.exe' : ''}`),
      ),
      binary(target),
    );
    assert.equal(
      readFileSync(join(unpacked, name, 'LICENSE'), 'utf8'),
      readAt(root)('LICENSE'),
    );
    const digest = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
    assert.equal(
      readFileSync(`${path}.sha256`, 'utf8'),
      `${digest}  ${name}.tgz\n`,
    );
    await assert.rejects(
      archive({ root, target, binary: executable, output }),
      /EEXIST/,
    );
    await assert.rejects(
      archive({ root, target: 'other', binary: executable, output }),
      /Unsupported/,
    );
    writeFileSync(executable, Buffer.alloc(128));
    await assert.rejects(
      archive({ root, target, binary: executable, output }),
      /format/,
    );
  });
}
test('archive tool failure reaps its exact scratch and missing legal handoff fails closed', async (t) => {
  const root = fixture(t);
  const executable = join(root, 'candidate');
  writeFileSync(executable, binary(targets[0]), { mode: 0o755 });
  const output = join(root, 'archives');
  let scratch;
  await assert.rejects(
    archive(
      { root, target: targets[0], binary: executable, output },
      async (_program, args) => {
        scratch = dirname(args[1]);
        throw new Error('injected tar failure');
      },
    ),
    /injected tar failure/,
  );
  assert.equal(existsSync(scratch), false);
  assert.equal(existsSync(output), false);
  rmSync(join(root, 'DEPENDENCIES.md'));
  await assert.rejects(
    archive({ root, target: targets[0], binary: executable, output }),
    /ENOENT/,
  );
  assert.equal(existsSync(output), false);
});

test('checksum collision preserves existing evidence and removes only the newly owned archive', async (t) => {
  const root = fixture(t);
  const executable = join(root, 'candidate');
  writeFileSync(executable, binary(targets[0]), { mode: 0o755 });
  const output = join(root, 'archives');
  mkdirSync(output);
  const destination = join(output, 'taurimd-aarch64-apple-darwin-v0.1.0.tgz');
  writeFileSync(`${destination}.sha256`, 'pre-existing checksum');
  await assert.rejects(
    archive({ root, target: targets[0], binary: executable, output }),
    /EEXIST/,
  );
  assert.equal(existsSync(destination), false);
  assert.equal(
    readFileSync(`${destination}.sha256`, 'utf8'),
    'pre-existing checksum',
  );
});

test('tag adapter resolves the tag commit and its first parent, with no tag creation', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  bumpVersion(root, []);
  let shallow = false;
  let checkout = 'head';
  let parents = ['first', 'second'];
  const observed = [];
  const readGit = (...args) => {
    observed.push(args);
    if (args.join(' ') === 'rev-parse --is-shallow-repository')
      return shallow ? 'true' : 'false';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return 'head';
    if (args.join(' ') === 'rev-parse HEAD') return checkout;
    if (args[0] === 'rev-list') return ['head', ...parents].join(' ');
    if (args[0] === 'show') {
      const [id, path] = args[1].split(':');
      assert.notEqual(
        id,
        'second',
        'release comparison must use only the first parent',
      );
      return id === 'head' ? readAt(root)(path) : before.get(path);
    }
    throw new Error(`Unexpected Git operation: ${args.join(' ')}`);
  };
  assert.equal(validateTag(root, 'v0.1.1', readGit), '0.1.1');
  assert.ok(observed.some((args) => args[2] === 'refs/tags/v0.1.1^{commit}'));
  checkout = 'later';
  assert.throws(() => validateTag(root, 'v0.1.1', readGit), /tagged commit/);
  checkout = 'head';
  shallow = true;
  assert.throws(() => validateTag(root, 'v0.1.1', readGit), /ancestry/);
  shallow = false;
  parents = [];
  assert.equal(validateTag(root, 'v0.1.1', readGit), '0.1.1');
});
test('workflow keeps ordinary debug native compilation and validated tag-only release builds', () => {
  const workflow = load(
    readFileSync(join(project, '.github/workflows/checks.yml'), 'utf8'),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.equal(workflow.permissions.contents, 'read');
  const jobs = workflow.jobs;
  const scripts = (job) =>
    jobs[job].steps.map((step) => step.run ?? '').join('\n');
  assert.match(scripts('quality'), /npm run check:ci/);
  assert.match(scripts('browsers'), /node scripts\/ci-browser-audio.mjs/);
  const buildCommands = (job) =>
    jobs[job].steps.flatMap((step) =>
      (step.run ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(
          (args) => args.slice(0, 5).join(' ') === 'npm run tauri -- build',
        ),
    );
  assert.deepEqual(buildCommands('native-build'), [
    [
      'npm',
      'run',
      'tauri',
      '--',
      'build',
      '--debug',
      '--no-bundle',
      '--ci',
      '--no-sign',
      '--',
      '--locked',
    ],
  ]);
  assert.deepEqual(buildCommands('package-candidates'), [
    [
      'npm',
      'run',
      'tauri',
      '--',
      'build',
      '--ci',
      '--no-sign',
      '--',
      '--locked',
    ],
  ]);
  assert.doesNotMatch(
    scripts('native-build'),
    /scripts\/archive|build --ci --no-sign/,
  );
  assert.deepEqual(jobs['package-candidates'].needs, [
    'quality',
    'browsers',
    'native-build',
    'release-version',
  ]);
  assert.match(
    jobs['release-version'].if,
    /github.event_name == 'push'.*refs\/tags\/v/,
  );
  assert.match(scripts('release-version'), /node scripts\/validate-tag.mjs/);
  assert.deepEqual(
    jobs['package-candidates'].strategy.matrix.include.map(
      (entry) => entry.target,
    ),
    targets,
  );
  assert.match(scripts('package-candidates'), /uname -m.*arm64/);
  assert.doesNotMatch(
    scripts('package-candidates'),
    /cargo publish|gh release|contents: write/,
  );
});

test('package preparation uses authoritative legal/document bytes and clears stale optional notices', (t) => {
  const root = fixture(t);
  preparePackage(root);
  for (const name of ['README.md', 'LICENSE', 'DEPENDENCIES.md']) {
    assert.equal(
      readFileSync(join(root, 'src-tauri/package', name), 'utf8'),
      readAt(root)(name),
    );
    assert.equal(
      readFileSync(join(root, 'src-tauri/frontend-dist/legal', name), 'utf8'),
      readAt(root)(name),
    );
  }
  mkdirSync(join(root, 'src-tauri/target'));
  const notices = join(root, 'src-tauri/target/THIRD_PARTY_NOTICES.md');
  writeFileSync(notices, 'PARTIAL / NON-DISTRIBUTABLE\n');
  preparePackage(root);
  assert.equal(
    readFileSync(
      join(root, 'src-tauri/package/THIRD_PARTY_NOTICES.md'),
      'utf8',
    ),
    readFileSync(notices, 'utf8'),
  );
  rmSync(notices);
  preparePackage(root);
  assert.equal(
    existsSync(join(root, 'src-tauri/package/THIRD_PARTY_NOTICES.md')),
    false,
  );
  assert.equal(
    existsSync(
      join(root, 'src-tauri/frontend-dist/legal/THIRD_PARTY_NOTICES.md'),
    ),
    false,
  );
});
