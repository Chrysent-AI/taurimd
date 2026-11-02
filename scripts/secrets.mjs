import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
export function scannerPreflight() {
  const version = execFileSync('gitleaks', ['version'], {
    encoding: 'utf8',
  }).trim();
  if (version !== '8.30.1')
    throw new Error(
      'Install Gitleaks 8.30.1; missing or different scanners fail closed.',
    );
}
export async function scan(mode, values = []) {
  scannerPreflight();
  // Git mode also loads the repository ignore file; an empty explicit path is
  // not sufficient to disable it in the pinned scanner. Reject it fail-closed.
  try {
    lstatSync(resolve('.gitleaksignore'));
    throw new Error(
      'Project policy does not permit .gitleaksignore files. Remove the ignore file; do not exempt findings.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'taurimd-scan-'));
  const ignore = join(scratch, 'empty-ignore');
  writeFileSync(ignore, '');
  const flags = [
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--verbose',
    '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path',
    ignore,
    '--config',
    resolve(project, '.gitleaks.toml'),
    '--timeout',
    '90',
  ];
  const inspectMessage = async (input, historicalCommit) => {
    await run('gitleaks', ['stdin', ...flags], { input });
    // Only this existing bootstrap object predates the format policy. Its
    // complete message has already been scanned; new messages stay strict.
    if (historicalCommit === '9116eedb060c327c637f8556d88eea18cc098e94') {
      console.log(
        `Historical format-only exception: ${historicalCommit}. Full-message secret scan passed.`,
      );
      return;
    }
    await run(
      process.execPath,
      [
        resolve(project, 'node_modules/@commitlint/cli/cli.js'),
        '--strict',
        '--config',
        resolve(project, 'commitlint.config.js'),
      ],
      { input },
    );
  };
  try {
    if (mode === 'staged') {
      console.log(
        'Scanning introduced staged diff content (not unchanged file portions).',
      );
      await run('gitleaks', ['git', '--pre-commit', '--staged', ...flags, '.']);
    } else if (mode === 'message') {
      if (values.length !== 1)
        throw new Error('Pass exactly one commit-message file.');
      await inspectMessage(readFileSync(values[0]));
    } else if (mode === 'range') {
      const [baseFlag, base, headFlag, head] = values;
      const initial = values[0] === '--initial' && values.length === 2;
      const selectedHead = initial ? values[1] : head;
      if (
        !initial &&
        (baseFlag !== '--base' || headFlag !== '--head' || values.length !== 4)
      )
        throw new Error(
          'Use range --base SHA --head SHA or range --initial SHA.',
        );
      const validSha = (sha) =>
        typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha);
      if (!validSha(selectedHead) || (!initial && !validSha(base)))
        throw new Error('Ranges require full object IDs.');
      if (git(['rev-parse', '--is-shallow-repository']) !== 'false')
        throw new Error('Fetch complete ancestry before CI range checks.');
      git(['cat-file', '-e', `${selectedHead}^{commit}`]);
      if (!initial) {
        git(['cat-file', '-e', `${base}^{commit}`]);
        git(['merge-base', '--is-ancestor', base, selectedHead]);
      }
      const range = initial ? selectedHead : `${base}..${selectedHead}`;
      // Gitleaks owns diff traversal, including root and each merge-parent diff.
      await run('gitleaks', [
        'git',
        ...flags,
        '--log-opts',
        `--full-history --root -m ${range}`,
        '.',
      ]);
      const commits = git(['rev-list', '--reverse', range])
        .split('\n')
        .filter(Boolean);
      for (const commit of commits) {
        console.log(`Checking complete message for ${commit}.`);
        await inspectMessage(
          execFileSync('git', ['show', '-s', '--format=%B', commit]),
          commit,
        );
      }
    } else throw new Error('Unknown scan mode.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await scan(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(`Protection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
