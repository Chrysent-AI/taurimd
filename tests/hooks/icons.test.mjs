import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const json = (path) => JSON.parse(read(path));
const extensions = ['md', 'markdown', 'mdown', 'mkd', 'mkdown'];

function png(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buffer[24], 8);
  assert.equal(buffer[25], 6, 'Keep RGBA transparency');
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    chunks.push(buffer.toString('ascii', offset + 4, offset + 8));
    offset += length + 12;
    assert.ok(offset <= buffer.length);
  }
  assert.equal(offset, buffer.length);
  assert.equal(chunks[0], 'IHDR');
  assert.equal(chunks.at(-1), 'IEND');
  assert.ok(chunks.includes('IDAT'));
  const allowed = ['IHDR', 'IDAT', 'IEND', 'sRGB', 'iCCP', 'gAMA', 'cHRM'];
  assert.ok(
    chunks.every((chunk) => allowed.includes(chunk)),
    'No export metadata',
  );
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test('shared logo PNGs and native containers retain alpha and required sizes', () => {
  assert.deepEqual(png(read('src-tauri/icons/logo-master.png')), [1024, 1024]);
  assert.deepEqual(png(read('src-tauri/icons/icon.png')), [512, 512]);
  const ico = read('src-tauri/icons/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [];
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const size = ico[entry] || 256;
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const start = ico.readUInt32LE(entry + 12);
    const end = start + ico.readUInt32LE(entry + 8);
    assert.ok(start >= 6 + ico.readUInt16LE(4) * 16 && end <= ico.length);
    assert.deepEqual(png(ico.subarray(start, end)), [size, size]);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 256]);

  const icns = read('src-tauri/icons/icon.icns');
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const records = new Map();
  let offset = 8;
  while (offset < icns.length) {
    const kind = icns.toString('ascii', offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= icns.length);
    assert.ok(!records.has(kind));
    records.set(kind, icns.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.equal(offset, icns.length);
  for (const [kind, size] of Object.entries({
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
    ic11: 32,
    ic12: 64,
    ic13: 256,
    ic14: 512,
  }))
    assert.deepEqual(png(records.get(kind)), [size, size]);
  assert.equal(records.get('s8mk').length, 16 * 16);
  assert.equal(records.get('l8mk').length, 32 * 32);
});

test('platform icon references preserve the five Markdown Viewer associations', () => {
  const config = json('src-tauri/tauri.conf.json');
  assert.deepEqual(config.bundle.fileAssociations, [
    {
      ext: extensions,
      name: 'taurimd.Markdown',
      description: 'Markdown document',
      role: 'Viewer',
      mimeType: 'text/markdown',
    },
  ]);
  assert.deepEqual(config.bundle.icon, [
    'icons/icon.png',
    'icons/icon.ico',
    'icons/icon.icns',
  ]);
  for (const path of config.bundle.icon)
    assert.ok(existsSync(new URL(`src-tauri/${path}`, root)));

  const mac = json('src-tauri/tauri.macos.conf.json');
  const plist = read(`src-tauri/${mac.bundle.macOS.infoPlist}`).toString();
  assert.deepEqual(
    [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]),
    [
      'CFBundleDocumentTypes',
      'CFBundleTypeExtensions',
      'CFBundleTypeName',
      'CFBundleTypeRole',
      'LSHandlerRank',
      'CFBundleTypeIconFile',
    ],
  );
  assert.deepEqual(
    [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]),
    [...extensions, 'taurimd.Markdown', 'Viewer', 'Default', 'icon.icns'],
  );

  const linux = json('src-tauri/tauri.linux.conf.json');
  assert.equal(
    linux.bundle.linux.deb.files[
      '/usr/share/icons/hicolor/512x512/mimetypes/taurimd-markdown.png'
    ],
    'icons/icon.png',
  );
  const mime = read(
    `src-tauri/${linux.bundle.linux.deb.files['/usr/share/mime/packages/taurimd.xml']}`,
  ).toString();
  assert.match(mime, /<mime-type type="text\/markdown">/);
  assert.match(mime, /<icon name="taurimd-markdown"\s*\/>/);
  assert.deepEqual(
    [...mime.matchAll(/<glob pattern="\*\.([^"/]+)"/g)].map((m) => m[1]),
    extensions,
  );
  assert.match(
    read('src-tauri/packaging/associations.nsh').toString(),
    /Markdown\\DefaultIcon.*\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\",0'/,
  );
});

test('README reuses the lightweight relative logo with alt text and display size', () => {
  const readme = read('README.md').toString();
  assert.match(
    readme,
    /^# taurimd\n\n<img src="src-tauri\/icons\/icon\.png" alt="taurimd logo: [^"]+" width="160" height="160" \/>/,
  );
  assert.ok(!readme.includes('logo-master.png'));
  const ignore = read('.gitignore').toString();
  for (const name of ['icon.png', 'icon.ico', 'icon.icns', 'logo-master.png']) {
    assert.ok(ignore.includes(`!src-tauri/icons/${name}\n`));
  }
});
