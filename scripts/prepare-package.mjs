import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Root documents remain authoritative; these are disposable Cargo-local inputs.
export function preparePackage(root) {
  const docs = join(root, 'src-tauri/package');
  const legal = join(root, 'src-tauri/frontend-dist/legal');
  mkdirSync(docs, { recursive: true });
  mkdirSync(legal, { recursive: true });
  for (const name of ['README.md', 'LICENSE', 'DEPENDENCIES.md']) {
    copyFileSync(join(root, name), join(docs, name));
    copyFileSync(join(root, name), join(legal, name));
  }
  const notices = join(root, 'src-tauri/target/THIRD_PARTY_NOTICES.md');
  if (existsSync(notices)) {
    copyFileSync(notices, join(docs, 'THIRD_PARTY_NOTICES.md'));
    copyFileSync(notices, join(legal, 'THIRD_PARTY_NOTICES.md'));
  } else {
    rmSync(join(docs, 'THIRD_PARTY_NOTICES.md'), { force: true });
    rmSync(join(legal, 'THIRD_PARTY_NOTICES.md'), { force: true });
  }
}
