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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../../', import.meta.url));
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const npmSource =
  'https://registry.npmjs.org/marked-footnote/-/marked-footnote-1.4.0.tgz';
const legalFiles = [
  'alloc-stdlib-0.3.0.txt',
  'selectors-0.38.0-NOTICE.txt',
  'selectors-0.38.0-MPL-2.0.txt',
  'tauri-plugin-2.7.2-MIT.txt',
  'tauri-plugin-2.7.2-APACHE-2.0.txt',
  'tauri-plugin-2.7.2-SPDX.txt',
  'marked-footnote-1.4.0.txt',
];
const unresolved = [
  ['block2', '0.6.2'],
  ['dispatch2', '0.3.1'],
  ['objc2', '0.6.5'],
  ['objc2-encode', '4.1.0'],
  ['objc2-exception-helper', '0.1.1'],
  ...[
    'objc2-app-kit',
    'objc2-core-foundation',
    'objc2-core-graphics',
    'objc2-foundation',
    'objc2-io-surface',
    'objc2-quartz-core',
    'objc2-web-kit',
  ].map((name) => [name, '0.3.2']),
];
function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), 'taurimd-notices-'));
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  };
  const interrupt = () => {
    cleanup();
    process.exit(130);
  };
  const terminate = () => {
    cleanup();
    process.exit(143);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  process.once('exit', cleanup);
  try {
    mkdirSync(join(root, 'scripts'));
    cpSync(
      join(project, 'scripts/notices.mjs'),
      join(root, 'scripts/notices.mjs'),
    );
    mkdirSync(join(root, 'licenses'));
    for (const file of legalFiles)
      cpSync(join(project, 'licenses', file), join(root, 'licenses', file));
    check(root);
  } finally {
    cleanup();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('exit', cleanup);
  }
}
function invoke(root, cargo = [], npm = []) {
  const packages = cargo.map(
    ([name, version, source = registry, files = {}], i) => {
      const directory = join(root, 'cargo', String(i));
      mkdirSync(directory, { recursive: true });
      for (const [file, bytes] of Object.entries(files))
        writeFileSync(join(directory, file), bytes);
      return {
        name,
        version,
        source,
        id: String(i),
        license: 'fixture declaration',
        manifest_path: join(directory, 'Cargo.toml'),
      };
    },
  );
  const lock = { packages: {} };
  for (const [name, version, resolved = npmSource, files = {}] of npm) {
    const path = `node_modules/${name}`;
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'package.json'), JSON.stringify({ name }));
    for (const [file, bytes] of Object.entries(files))
      writeFileSync(join(root, path, file), bytes);
    lock.packages[path] = { version, resolved, license: 'MIT' };
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(
    join(root, 'metadata.json'),
    JSON.stringify({
      packages,
      resolve: { nodes: packages.map(({ id }) => ({ id })) },
    }),
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/notices.mjs', 'metadata.json'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return {
    ...result,
    output: existsSync(join(root, 'src-tauri/target/THIRD_PARTY_NOTICES.md'))
      ? readFileSync(
          join(root, 'src-tauri/target/THIRD_PARTY_NOTICES.md'),
          'utf8',
        )
      : '',
  };
}
test('real notice CLI assembles four exact identities, verbatim terms and provenance, without clearing qualification', () =>
  fixture((root) => {
    const result = invoke(
      root,
      [
        ['alloc-stdlib', '0.3.0'],
        ['selectors', '0.38.0'],
        ['tauri-plugin', '2.7.2'],
        ...unresolved,
      ],
      [['marked-footnote', '1.4.0']],
    );
    assert.equal(result.status, 0, result.stderr);
    for (const file of legalFiles) {
      const bytes = readFileSync(join(project, 'licenses', file), 'utf8');
      assert.ok(
        result.output.includes(
          `\u0060\u0060\u0060text\n${bytes}\n\u0060\u0060\u0060`,
        ),
        file,
      );
    }
    for (const [name, version] of unresolved) {
      assert.ok(
        result.stderr.includes(
          `Missing packaged license text: ${name} ${version}`,
        ),
      );
      assert.ok(
        result.output.includes(
          `## ${name} ${version}\n\nDeclared license: fixture declaration. Source: https://crates.io/crates/${name}/${version}\n\nUNVERIFIED NOTICE:`,
        ),
      );
    }
    assert.equal(
      result.stderr.match(/Missing packaged license text:/g)?.length,
      12,
    );
    assert.equal(
      result.stderr.match(/Packaged notice omission supplemented:/g)?.length,
      4,
    );
    assert.match(result.output, /PARTIAL \/ NON-DISTRIBUTABLE/);
    assert.match(
      result.output,
      /Full binary distribution qualification remains BLOCKED/,
    );
    assert.match(result.output, /§§3.1–3.2\) remain UNQUALIFIED/);
    assert.match(
      result.output,
      /Other platform closures, later dependency closures, native\/platform qualification/,
    );
    assert.match(
      result.output,
      /CC0 is its data license, not the code license; both code alternatives retained without election/,
    );
    assert.match(
      result.output,
      /published archive omitted standalone legal files/,
    );
    assert.match(result.output, /Retained text SHA-256: c0c56f26/);
    assert.ok(result.output.includes(`exact locked source: ${registry}`));
    assert.ok(result.output.includes(`exact locked source: ${npmSource}`));
  }));
test('wrong versions, foreign registry, Git and missing npm origin never receive known supplements', () =>
  fixture((root) => {
    const result = invoke(
      root,
      [
        ['alloc-stdlib', '0.3.1'],
        ['selectors', '0.38.1'],
        ['tauri-plugin', '2.7.3'],
        ['alloc-stdlib', '0.3.0', 'registry+https://example.invalid/index'],
        ['selectors', '0.38.0', 'git+https://example.invalid/stylo#revision'],
        ['tauri-plugin', '2.7.2', 'registry+https://example.invalid/index'],
      ],
      [['marked-footnote', '1.4.1']],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.output, /### Supplemental/);
    assert.equal(
      result.stderr.match(/Missing packaged license text:/g)?.length,
      7,
    );
    for (const source of [
      'https://example.invalid/marked-footnote.tgz',
      'git+https://example.invalid/footnote',
      null,
    ]) {
      const npm = invoke(root, [], [['marked-footnote', '1.4.0', source]]);
      assert.equal(npm.status, 0, npm.stderr);
      assert.doesNotMatch(npm.output, /### Supplemental/);
      assert.match(
        npm.stderr,
        /Missing packaged license text: marked-footnote 1.4.0/,
      );
    }
  }));
test('packaged originals remain byte-for-byte and unrelated retained files are not activated', () =>
  fixture((root) => {
    writeFileSync(join(root, 'licenses/other-1.0.0.txt'), 'DO NOT ACTIVATE');
    const original =
      'Original legal notice\r\n  exact spacing\nno final newline';
    const result = invoke(
      root,
      [
        ['alloc-stdlib', '0.3.0', registry, { LICENSE: original }],
        ['other', '1.0.0'],
      ],
      [['marked-footnote', '1.4.0', npmSource, { NOTICE: original }]],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.split(original).length - 1, 2);
    assert.ok(
      result.output.includes(
        readFileSync(join(project, 'licenses/alloc-stdlib-0.3.0.txt'), 'utf8'),
      ),
    );
    assert.doesNotMatch(result.output, /DO NOT ACTIVATE/);
    assert.match(result.stderr, /Missing packaged license text: other 1.0.0/);
  }));
test('missing or changed required supplemental material fails rather than writing a qualified-looking inventory', () =>
  fixture((root) => {
    const file = join(root, 'licenses/alloc-stdlib-0.3.0.txt');
    unlinkSync(file);
    const missing = invoke(root, [['alloc-stdlib', '0.3.0']]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal(missing.output, '');
    writeFileSync(file, 'not the verified legal bytes');
    const changed = invoke(root, [['alloc-stdlib', '0.3.0']]);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Supplemental notice SHA-256 mismatch/);
    assert.equal(changed.output, '');
  }));
