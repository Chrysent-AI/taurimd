import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyVersion, planVersion } from './bump-version.mjs';
import { releaseBoundary, versionPaths } from './versions.mjs';

export const releaseBranch = 'main';

export function releaseMessage(version) {
  return `chore(release): taurimd v${version}`;
}

function defaultGit(root) {
  return (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      // The release commit runs the repository's protection gate. Its output
      // belongs on the terminal, not in a buffer the human cannot see.
      stdio: args[0] === 'commit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
}

function reason(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  return stderr || error?.message || String(error);
}

function samePath(left, right) {
  const a = realpathSync(left);
  const b = realpathSync(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

// Prepares a release commit and its tag. It never pushes, installs, logs in,
// uses the network or publishes; the human pushes the branch and the tag.
export function releaseVersion(root, args, options = {}) {
  const readGit = options.readGit ?? defaultGit(root);
  const branch = options.branch ?? releaseBranch;
  const git = (...gitArgs) => String(readGit(...gitArgs)).trim();
  const fails = (...gitArgs) => {
    try {
      readGit(...gitArgs);
      return false;
    } catch {
      return true;
    }
  };

  if (fails('rev-parse', '--show-toplevel'))
    throw new Error(
      'A Git repository is required to commit and tag a release.',
    );
  const top = git('rev-parse', '--show-toplevel');
  if (!samePath(top, resolve(root)))
    throw new Error(`Run the release from the repository root: ${top}`);
  if (fails('rev-parse', '--verify', 'HEAD'))
    throw new Error('The repository needs a commit before a release is cut.');
  const status = git('status', '--porcelain');
  if (status) {
    const tracked = status
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('??'));
    throw new Error(
      tracked.length
        ? `The working tree has uncommitted changes; commit or stash them first:\n${status}`
        : `Untracked files are present; move, ignore or remove them before releasing:\n${status}`,
    );
  }
  const current = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch && options.allowAnyBranch !== true)
    throw new Error(
      `Releases are cut from ${branch}; the current branch is ${current}.`,
    );

  const plan = planVersion(root, args);
  const tag = `v${plan.next}`;
  if (!fails('rev-parse', '--verify', `refs/tags/${tag}`))
    throw new Error(`Tag ${tag} already exists.`);

  applyVersion(root, plan);
  const restore = () => {
    try {
      git(
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        ...versionPaths,
      );
      return true;
    } catch {
      return false;
    }
  };
  const stopped = (what, error) => {
    const restored = restore();
    throw new Error(
      `${what}; the working tree was ${
        restored ? 'restored' : 'NOT restored'
      }.\n${reason(error)}${
        restored
          ? ''
          : `\nRestore it with: git restore --source=HEAD --staged --worktree -- ${versionPaths.join(' ')}`
      }`,
    );
  };

  try {
    releaseBoundary({
      tag,
      read: (path) => readFileSync(join(root, path), 'utf8'),
      parentRead: (path) => readGit('show', `HEAD:${path}`),
      rootCommit: false,
    });
  } catch (error) {
    stopped('The release boundary does not hold', error);
  }

  try {
    git('add', '--', ...versionPaths);
    git('commit', '-m', releaseMessage(plan.next));
  } catch (error) {
    stopped('The release commit failed', error);
  }

  const commit = git('rev-parse', 'HEAD');
  try {
    git('tag', '-a', tag, '-m', releaseMessage(plan.next));
  } catch (error) {
    throw new Error(
      `Committed ${commit} but the tag ${tag} failed: ${reason(error)}\nFinish with: git tag -a ${tag} -m "${releaseMessage(
        plan.next,
      )}"`,
    );
  }
  const remotes = git('remote').split('\n').filter(Boolean);
  const remote = remotes.includes('origin')
    ? 'origin'
    : remotes.length === 1
      ? remotes[0]
      : null;
  return {
    version: plan.next,
    tag,
    commit,
    branch: current,
    remote,
    message: releaseMessage(plan.next),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    let args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--make-inputs') {
      args = [];
      if (process.env.TAURIMD_BUMP_ORIGIN !== 'undefined')
        args.push(`--bump=${process.env.TAURIMD_BUMP_VALUE ?? ''}`);
      if (process.env.TAURIMD_VERSION_ORIGIN !== 'undefined')
        args.push(`--version=${process.env.TAURIMD_VERSION_VALUE ?? ''}`);
    }
    const result = releaseVersion(root, args);
    const push = `git push ${result.remote ?? '<remote>'} ${result.branch} ${result.tag}`;
    console.log(
      `Released ${result.tag}: version ${result.version} committed as ${result.commit.slice(
        0,
        7,
      )} and tagged.\nPush the branch and the tag with: ${push}`,
    );
  } catch (error) {
    console.error(`Release stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
