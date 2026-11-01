import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  browserAudio,
  checkPackagePolicy,
  pulseQuote,
} from '../../scripts/ci-browser-audio.mjs';

// Real subprocesses/socket, but no Pulse installation, browser, or production wait.
const fixtureCode = String.raw`
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [role, mode, report, ...args] = process.argv.slice(2);
const socket = process.env.PULSE_SERVER.slice(5);
const root = dirname(socket);
const update = (value) => {
  const target = report + '-' + role;
  writeFileSync(target + '.next', JSON.stringify(value));
  renameSync(target + '.next', target);
};
if (role === 'daemon') {
  update({ root, daemon: process.pid,
    rootMode: statSync(root).mode & 0o777,
    runtimeMode: statSync(process.env.PULSE_RUNTIME_PATH).mode & 0o777,
    stateMode: statSync(process.env.PULSE_STATE_PATH).mode & 0o777,
    cookieMode: statSync(process.env.PULSE_COOKIE).mode & 0o777,
    cookieSize: statSync(process.env.PULSE_COOKIE).size,
    scriptMode: statSync(join(root, 'startup.pa')).mode & 0o777,
    script: readFileSync(join(root, 'startup.pa'), 'utf8'), daemonArgs: args });
  if (mode === 'start-fail') process.exit(9);
  createServer((client) => { client.end('authenticated-fake'); }).listen(socket, () => {
    console.error('I: [pulseaudio] sink-input.c: Created input 2 "AudioStream" on ci_output with sample spec float32le 2ch 48000Hz and channel map front-left,front-right');
    console.error('    application.process.binary = "firefox"');
    console.error('    application.process.id = "1234"');
  });
} else if (role === 'probe') {
  if (mode === 'probe-hang') {
    process.on('SIGTERM', () => {});
    update({ probe: process.pid });
    setInterval(() => {}, 1000);
  } else if (mode === 'connection-fail') process.exit(7);
  else {
    const client = connect(socket);
    client.on('error', () => process.exit(7));
    client.on('data', () => {
      const value = args.includes('get-default-sink') ? 'ci_output' :
        JSON.stringify([{ name: 'ci_output', index: 0, mute: mode === 'muted', state: mode === 'suspended' ? 'SUSPENDED' : 'IDLE' }]);
      console.log(value);
    });
  }
} else {
  const childCode = "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  const detached = spawn(process.execPath, ['-e', childCode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  await Promise.all([child, detached].map((entry) => new Promise((resolve) => entry.stdout.once('data', resolve))));
  console.error('^[[30;1mpw:browser ^[[0m<launched> pid=' + detached.pid);
  update({ browser: process.pid, child: child.pid, detached: detached.pid,
    route: { server: process.env.PULSE_SERVER, sink: process.env.PULSE_SINK, cookie: process.env.PULSE_COOKIE } });
  // Reap direct children when cancelled; deliberately retain them on normal exit
  // so the fixture must clean both inherited and detached groups as well.
  process.on('SIGTERM', async () => {
    child.kill('SIGTERM'); detached.kill('SIGTERM');
    await Promise.all([child, detached].map((entry) => new Promise((resolve) => entry.once('exit', resolve))));
    process.exit(0);
  });
  if (mode === 'daemon-dies') process.kill(JSON.parse(readFileSync(report + '-daemon', 'utf8')).daemon, 'SIGTERM');
  if (mode === 'success' || mode === 'nonzero' || mode === 'cleanup-fail') process.exit(mode === 'success' ? 0 : 7);
  setInterval(() => {}, 1000);
}
`;

const timing = { ready: 600, probe: 120, stop: 250, poll: 5 };
const alive = (pid, group = false) => {
  if (!pid) return false;
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
};
async function waitFor(predicate) {
  const deadline = performance.now() + 5000; // outer fixture hang guard only
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'fixture condition did not arrive');
    await delay(5);
  }
}

test('private fixture quotes Pulse module arguments, and rejects non-Noble package sources', () => {
  assert.equal(pulseQuote('/tmp/a "b" \\ c'), '"/tmp/a \\"b\\" \\\\ c"');
  assert.throws(() => pulseQuote('bad\nload-module other'));
  const policy =
    'pkg:\n  Installed: (none)\n  Candidate: 1:16.1+dfsg1-2ubuntu10.1\n  Version table:\n     1:16.1+dfsg1-2ubuntu10.1 500\n        500 http://azure.archive.ubuntu.com/ubuntu noble-updates/universe amd64 Packages\n     1:16.1+dfsg1-2ubuntu10 500\n        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages\n';
  checkPackagePolicy(policy, '1:16.1+dfsg1-2ubuntu10.1');
  checkPackagePolicy(
    policy.replace(
      '     1:16.1+dfsg1-2ubuntu10.1',
      ' *** 1:16.1+dfsg1-2ubuntu10.1',
    ),
    '1:16.1+dfsg1-2ubuntu10.1',
  );
  assert.throws(() =>
    checkPackagePolicy(
      policy.replace('azure.archive.ubuntu.com', 'other.invalid'),
      '1:16.1+dfsg1-2ubuntu10.1',
    ),
  );
  assert.throws(() =>
    checkPackagePolicy(
      policy.replace('noble-updates', 'jammy-updates'),
      '1:16.1+dfsg1-2ubuntu10.1',
    ),
  );
  assert.throws(() => checkPackagePolicy(policy, '99'));
});

for (const mode of [
  'success',
  'signal-race',
  'nonzero',
  'cleanup-fail',
  'start-fail',
  'missing-daemon',
  'connection-fail',
  'probe-hang',
  'muted',
  'suspended',
  'daemon-dies',
  'SIGINT',
  'SIGTERM',
]) {
  test(
    `private CI audio ownership: ${mode}`,
    { skip: process.platform === 'win32', timeout: 15000 },
    async (context) => {
      const scratch = mkdtempSync(join(tmpdir(), 'ci-audio-test-'));
      const fixture = join(scratch, 'command.mjs');
      const report = join(scratch, 'state.json');
      const evidence =
        mode === 'cleanup-fail'
          ? join(report, 'impossible.log')
          : join(scratch, 'evidence.log');
      writeFileSync(fixture, fixtureCode);
      writeFileSync(report, '{}');
      const state = () =>
        Object.assign(
          {},
          ...['daemon', 'probe', 'browser'].map((role) => {
            const path = `${report}-${role}`;
            return existsSync(path)
              ? JSON.parse(readFileSync(path, 'utf8'))
              : {};
          }),
        );
      const names = [
        'PULSE_SERVER',
        'PULSE_COOKIE',
        'PULSE_SINK',
        'PULSE_RUNTIME_PATH',
        'PULSE_STATE_PATH',
      ];
      const before = names.map((name) => process.env[name]);
      let outcome;
      let injected = false;
      const originalKill = process.kill.bind(process);
      if (mode === 'signal-race')
        context.mock.method(process, 'kill', (pid, signal) => {
          if (!injected && pid < 0 && signal === 'SIGTERM') {
            // The completed probe is already exiting; the signal result alone
            // must neither prove cleanup nor prevent a fresh absence check.
            injected = true;
            throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
          }
          return originalKill(pid, signal);
        });
      try {
        const command = (role) => [
          process.execPath,
          fixture,
          role,
          mode === 'signal-race' ? 'success' : mode,
          report,
        ];
        const running = browserAudio({
          daemon:
            mode === 'missing-daemon'
              ? [join(scratch, 'absent')]
              : command('daemon'),
          probe: command('probe'),
          browser: command('browser'),
          timing,
          evidence,
          env: {
            ...process.env,
            PULSE_SERVER: 'unix:/invalid-existing-session',
            PULSE_COOKIE: '/invalid-existing-cookie',
            PULSE_SINK: 'wrong',
          },
        }).then(
          () => null,
          (error) => error,
        );
        if (mode === 'SIGINT' || mode === 'SIGTERM') {
          await waitFor(() => state().browser);
          process.kill(process.pid, mode);
        }
        outcome = await running;
        if (mode === 'success' || mode === 'signal-race')
          assert.equal(outcome, null);
        else assert.ok(outcome instanceof Error, `${mode} must fail`);
        assert.deepEqual(
          names.map((name) => process.env[name]),
          before,
          'caller environment unchanged',
        );
        const actual = state();
        if (actual.root) {
          assert.equal(actual.rootMode, 0o700);
          assert.equal(actual.runtimeMode, 0o700);
          assert.equal(actual.stateMode, 0o700);
          assert.equal(actual.cookieMode, 0o600);
          assert.equal(actual.cookieSize, 256);
          assert.equal(actual.scriptMode, 0o600);
          assert.equal(
            actual.script
              .split('\n')
              .filter((line) => line.startsWith('load-module')).length,
            2,
          );
          assert.match(
            actual.script,
            /auth-anonymous=no auth-group-enable=no auth-cookie-enabled=yes/,
          );
          assert.ok(actual.daemonArgs.includes('-n'));
          assert.ok(actual.daemonArgs.includes('--daemonize=no'));
          assert.equal(
            existsSync(actual.root),
            false,
            'private files and socket removed',
          );
        }
        await waitFor(() =>
          ['daemon', 'browser', 'child', 'detached', 'probe'].every(
            (name) => !alive(actual[name]),
          ),
        );
        for (const name of ['daemon', 'browser', 'detached', 'probe'])
          assert.equal(alive(actual[name], true), false);
        if (mode === 'cleanup-fail') {
          assert.ok(outcome instanceof AggregateError);
          assert.match(
            outcome.errors[0].message,
            /Browser command failed \(7\)/,
          );
          assert.ok(
            outcome.errors.some(
              (error) => error.code === 'ENOTDIR' || error.code === 'EEXIST',
            ),
          );
          return;
        }
        const log = readFileSync(evidence, 'utf8');
        const id = log.match(/private endpoint id=(ci-audio-[^;]+)/)?.[1];
        assert.ok(id);
        assert.equal(existsSync(join('/tmp', id)), false);
        assert.match(log, /owned socket and private scratch absent/);
        if (actual.root && mode !== 'start-fail') {
          assert.match(
            log,
            /stream 2 on ci_output, sample=float32le 2ch 48000Hz/,
          );
          assert.match(log, /stream 2 browser=firefox/);
          assert.match(log, /stream 2 client pid=1234/);
        }
        if (actual.browser) {
          assert.equal(actual.route.server, `unix:${actual.root}/native`);
          assert.equal(actual.route.sink, 'ci_output');
          assert.equal(actual.route.cookie, `${actual.root}/cookie`);
          assert.ok(
            log.indexOf('browser: owned groups absent') <
              log.indexOf('daemon: owned groups absent'),
          );
        }
        if (mode === 'signal-race') {
          assert.equal(injected, true);
          assert.match(log, /returned EPERM; checking absence/);
        }
        if (mode === 'probe-hang')
          assert.match(log, /probe: escalating owned groups to SIGKILL/);
      } finally {
        context.mock.restoreAll();
        // Last-resort fixture-only cleanup, even if an assertion or outer guard fails.
        const actual = state();
        for (const name of ['browser', 'detached', 'probe', 'daemon']) {
          if (alive(actual[name], true)) process.kill(-actual[name], 'SIGKILL');
        }
        if (alive(actual.child)) process.kill(actual.child, 'SIGKILL');
        await waitFor(() =>
          ['daemon', 'browser', 'child', 'detached', 'probe'].every(
            (name) => !alive(actual[name]),
          ),
        );
        if (actual.root && existsSync(actual.root))
          rmSync(actual.root, { recursive: true });
        rmSync(scratch, { recursive: true });
        assert.equal(existsSync(scratch), false);
      }
    },
  );
}
