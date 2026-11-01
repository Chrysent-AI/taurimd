import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const packages = ['pulseaudio', 'pulseaudio-utils', 'libpulse0'];
const pulseVersion = /^1:16\.1\+dfsg1-2ubuntu10(?:\.\d+)?$/;

// Inspect the exact simulated transaction, not just the top-level package names.
export function checkPackagePolicy(policy, version) {
  const blocks = policy.split(/\n(?=\s*(?:\*\*\* )?\S+ \d+\s*$)/m);
  const block = blocks.find((part) =>
    new RegExp(
      `^\\s*(?:\\*\\*\\* )?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+\\s*$`,
      'm',
    ).test(part),
  );
  const sources = block
    ?.split('\n')
    .filter((line) => / Packages\s*$/.test(line));
  if (
    !sources?.length ||
    sources.some(
      (line) =>
        !/^\s*\d+ https?:\/\/(?:azure\.archive|archive|security)\.ubuntu\.com\/ubuntu\/? noble(?:-updates|-security)?\/(?:main|universe|restricted|multiverse) amd64 Packages\s*$/.test(
          line,
        ),
    )
  )
    throw new Error(
      'Package version is not exclusively from the official Noble archive.',
    );
}

function checkPackages() {
  const apt = (args) =>
    execFileSync('apt-cache', args, { encoding: 'utf8', timeout: 60000 });
  for (const name of packages) {
    const policy = apt(['policy', name]);
    console.log(policy);
    const candidate = policy.match(/Candidate: (\S+)/)?.[1];
    if (!pulseVersion.test(candidate ?? ''))
      throw new Error(`Unexpected ${name} candidate family.`);
    checkPackagePolicy(policy, candidate);
  }
  const plan = execFileSync(
    'apt-get',
    [
      '--simulate',
      '--no-install-recommends',
      '--no-remove',
      'install',
      ...packages.slice(0, 2),
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  console.log(plan);
  if (/^Remv /m.test(plan))
    throw new Error('Audio prerequisite would remove packages.');
  for (const match of plan.matchAll(/^Inst (\S+) (?:\[[^\]]+\] )?\((\S+)/gm)) {
    const [, name, version] = match;
    const policy = apt(['policy', name]);
    console.log(policy);
    checkPackagePolicy(policy, version);
    if (/^(pulseaudio|libpulse)/.test(name) && !pulseVersion.test(version))
      throw new Error('Unexpected PulseAudio dependency version.');
  }
}

function groupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// These are local fixture handles, not a replacement for the shared command runner.
function start(command, env, output, lines) {
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = {
    child,
    groups: new Set(),
    result: null,
    closed: false,
    output: '',
  };
  child.once('close', () => {
    handle.closed = true;
  });
  if (child.pid) handle.groups.add(child.pid);
  handle.done = new Promise((resolveDone) => {
    child.once('error', (error) => {
      handle.result = { error };
      resolveDone(handle.result);
    });
    child.once('exit', (code, signal) => {
      handle.result = { code, signal };
      resolveDone(handle.result);
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (output) stream.on('data', (chunk) => output.write(chunk));
    if (lines)
      createInterface({ input: stream }).on('line', (line) =>
        lines(line, handle),
      );
  }
  if (!output && !lines)
    child.stdout.on('data', (chunk) => {
      // pactl responses are tiny; fail closed rather than accumulating unbounded output.
      if (handle.output.length + chunk.length > 1024 * 1024)
        handle.overflow = true;
      else handle.output += chunk.toString();
    });
  return handle;
}

async function until(predicate, deadline, interval) {
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    await delay(Math.min(interval, Math.max(1, deadline - performance.now())));
  }
  return true;
}
async function stop(handle, timing, record, label) {
  if (!handle || handle.stopped) return;
  const absent = () =>
    [...handle.groups].every((pid) => !groupExists(pid)) &&
    handle.closed &&
    handle.result !== null;
  const signalErrors = (handle.signalErrors ??= []);
  const send = (signal) => {
    handle.stopping = signal;
    for (const pid of handle.groups) {
      try {
        signalGroup(pid, signal);
      } catch (error) {
        signalErrors.push(error);
        record(
          `${label}: ${signal} group ${pid} returned ${error.code}; checking absence`,
        );
      }
    }
  };
  send('SIGTERM');
  if (!(await until(absent, performance.now() + timing.stop, timing.poll))) {
    record(`${label}: escalating owned groups to SIGKILL`);
    send('SIGKILL');
    if (!(await until(absent, performance.now() + timing.stop, timing.poll)))
      throw new AggregateError(
        [
          ...signalErrors,
          new Error(`${label}: owned process group remains after SIGKILL.`),
        ],
        `${label}: cleanup failed.`,
      );
  }
  await handle.done;
  handle.stopped = true;
  record(`${label}: owned groups absent`);
}

// Pulse's module-argument parser accepts double quotes and backslash escapes;
// the CLI tokenizer leaves the final load-module argument string intact.
export function pulseQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid PulseAudio argument.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function removePrivate(root) {
  // A dead server may leave its socket inode. Unlink only this owned socket,
  // then verify absence before removing the private files.
  rmSync(join(root, 'native'), { force: true });
  if (existsSync(join(root, 'native')))
    throw new Error('Owned socket remains.');
  rmSync(root, { recursive: true });
  if (existsSync(root)) throw new Error('Owned scratch remains.');
}

export async function browserAudio({
  daemon = ['pulseaudio'],
  probe = ['pactl'],
  browser = ['npm', 'run', 'test:browser'],
  timing = { ready: 10000, probe: 1000, stop: 5000, poll: 25 },
  evidence = resolve('test-results/ci-audio.log'),
  env = process.env,
} = {}) {
  if (process.platform === 'win32')
    throw new Error('CI audio fixture needs POSIX process groups.');
  const records = [];
  const record = (line) => {
    records.push(`${new Date().toISOString()} ${line}`);
    console.log(`[ci-audio] ${line}`);
  };
  let root, service, tests, activeProbe, failure, interrupted;
  const onInt = () => {
    interrupted ??= 'SIGINT';
  };
  const onTerm = () => {
    interrupted ??= 'SIGTERM';
  };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const healthy = () => {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
    if (service?.result)
      throw new Error(
        `Private audio daemon exited unexpectedly (${service.result.error?.code ?? service.result.signal ?? service.result.code}).`,
      );
  };
  try {
    // Short fixed scratch prefix avoids the Unix socket path limit, even on long checkouts.
    root = mkdtempSync('/tmp/ci-audio-');
    chmodSync(root, 0o700);
    for (const name of ['runtime', 'state'])
      mkdirSync(join(root, name), { mode: 0o700 });
    const socket = join(root, 'native');
    const cookie = join(root, 'cookie');
    writeFileSync(cookie, randomBytes(256), { mode: 0o600, flag: 'wx' });
    const script = join(root, 'startup.pa');
    writeFileSync(
      script,
      [
        `load-module module-native-protocol-unix socket=${pulseQuote(socket)} auth-anonymous=no auth-group-enable=no auth-cookie-enabled=yes auth-cookie=${pulseQuote(cookie)}`,
        'load-module module-null-sink sink_name=ci_output',
        'set-default-sink ci_output',
        '',
      ].join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
    const childEnv = {
      ...env,
      PULSE_SERVER: `unix:${socket}`,
      PULSE_SINK: 'ci_output',
      PULSE_COOKIE: cookie,
      PULSE_RUNTIME_PATH: join(root, 'runtime'),
      PULSE_STATE_PATH: join(root, 'state'),
    };
    let streamIndex;
    service = start(
      [
        ...daemon,
        '-n',
        '--daemonize=no',
        '--use-pid-file=no',
        '--exit-idle-time=-1',
        '--fail=yes',
        '--high-priority=no',
        '--realtime=no',
        '--log-target=stderr',
        '--log-level=info',
        `--file=${script}`,
      ],
      childEnv,
      null,
      (line) => {
        // Retain stream creation/format evidence, never the session proplist or startup arguments.
        const stream = line.match(
          /sink-input\.c: Created input (\d+) .* on (ci_output) with sample spec (.+?) and channel map (.+)$/,
        );
        if (stream) {
          streamIndex = stream[1];
          record(
            `stream ${stream[1]} on ${stream[2]}, sample=${stream[3]}, channels=${stream[4]}`,
          );
        }
        const binary = line.match(
          /application\.process\.binary = "(firefox|chromium|chrome|MiniBrowser|WebKitWebProcess)"/,
        );
        const pid = line.match(/application\.process\.id = "(\d+)"/);
        if (streamIndex && binary)
          record(`stream ${streamIndex} browser=${binary[1]}`);
        if (streamIndex && pid)
          record(`stream ${streamIndex} client pid=${pid[1]}`);
        if (/daemon\.c: Daemon startup complete\./.test(line))
          record('daemon startup complete');
        if (/^E:/.test(line))
          record(`daemon error: ${line.replaceAll(root, '<private>')}`);
      },
    );
    record(
      `private endpoint id=${basename(root)}; daemon group ${service.child.pid ?? 'not started'}`,
    );
    const deadline = performance.now() + timing.ready;
    const query = async (args) => {
      healthy();
      activeProbe = start(
        [...probe, `--server=${childEnv.PULSE_SERVER}`, ...args],
        childEnv,
      );
      let output, probeFailure;
      try {
        const finished = await until(
          () => {
            healthy();
            return activeProbe.result !== null && activeProbe.closed;
          },
          Math.min(deadline, performance.now() + timing.probe),
          timing.poll,
        );
        if (!finished) throw new Error('Authenticated audio probe timed out.');
        const result = activeProbe.result;
        if (result.error || result.code !== 0 || activeProbe.overflow)
          throw new Error('Authenticated audio probe failed.');
        output = activeProbe.output.trim();
      } catch (error) {
        probeFailure = error;
      }
      try {
        await stop(activeProbe, timing, record, 'probe');
        activeProbe = null;
      } catch (error) {
        throw new AggregateError(
          [...(probeFailure ? [probeFailure] : []), error],
          'Audio probe cleanup failed.',
        );
      }
      if (probeFailure) throw probeFailure;
      return output;
    };
    let ready = false;
    let lastError;
    while (performance.now() < deadline && !ready) {
      healthy();
      try {
        const sinks = JSON.parse(
          await query(['--format=json', 'list', 'sinks']),
        );
        const selected =
          Array.isArray(sinks) &&
          sinks.find((sink) => sink.name === 'ci_output');
        if (
          !selected ||
          !Number.isSafeInteger(selected.index) ||
          selected.index < 0 ||
          selected.mute !== false ||
          !['IDLE', 'RUNNING'].includes(selected.state)
        )
          throw new Error('Named sink is missing, muted or suspended.');
        if ((await query(['get-default-sink'])) !== 'ci_output')
          throw new Error('Wrong default sink.');
        record(
          `authenticated sink ci_output index=${selected.index} state=${selected.state} mute=false`,
        );
        ready = true;
      } catch (error) {
        lastError = error;
        // A failed probe teardown must never be retried over a still-owned handle.
        if (activeProbe) throw error;
        healthy();
        await delay(
          Math.min(timing.poll, Math.max(1, deadline - performance.now())),
        );
      }
    }
    if (!ready)
      throw new Error(
        `Audio readiness deadline: ${lastError?.message ?? 'no connection'}`,
      );
    healthy();
    // Playwright 1.59.1 explicitly detaches browser groups. Its pinned launcher
    // reports each group before use via DEBUG=pw:browser; retaining these handles
    // covers those groups as well as npm/the worker's ordinary descendants.
    tests = start(browser, childEnv, process.stdout, (line, handle) => {
      // DEBUG output may include terminal color sequences, even on CI.
      const launched = line.match(/pw:browser.*?<launched> pid=(\d+)(?:\s|$)/);
      if (launched) {
        const pid = Number(launched[1]);
        handle.groups.add(pid);
        if (handle.stopping) {
          try {
            signalGroup(pid, handle.stopping);
          } catch (error) {
            (handle.signalErrors ??= []).push(error);
            record(
              `browser: ${handle.stopping} group ${pid} returned ${error.code}; checking absence`,
            );
          }
        }
        record(`owned Playwright browser group ${pid}`);
      }
    });
    record(`browser command group ${tests.child.pid ?? 'not started'}`);
    while (!tests.result) {
      healthy();
      await delay(timing.poll);
    }
    healthy();
    if (tests.result.error || tests.result.code !== 0)
      throw new Error(
        `Browser command failed (${tests.result.signal ?? tests.result.code ?? 'spawn'}).`,
      );
    await stop(tests, timing, record, 'browser');
    healthy();
    if (tests.groups.size < 2)
      throw new Error('No Playwright browser ownership records received.');
  } catch (error) {
    failure = error;
    record(`primary failure: ${error.message}`);
  } finally {
    const cleanupErrors = [];
    // Never remove files while an owned process can still use or recreate them.
    for (const [handle, label] of [
      [tests, 'browser'],
      [activeProbe, 'probe'],
      [service, 'daemon'],
    ]) {
      try {
        await stop(handle, timing, record, label);
      } catch (error) {
        cleanupErrors.push(error);
        record(`cleanup failure: ${error.message}`);
      }
    }
    if (root && cleanupErrors.length === 0) {
      try {
        removePrivate(root);
        record('owned socket and private scratch absent');
      } catch (error) {
        cleanupErrors.push(error);
        record(`cleanup failure: ${error.message}`);
      }
    }
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (interrupted && !failure)
      failure = new Error(`Interrupted by ${interrupted}.`);
    try {
      mkdirSync(resolve(evidence, '..'), { recursive: true });
      writeFileSync(evidence, `${records.join('\n')}\n`, { mode: 0o600 });
    } catch (error) {
      cleanupErrors.push(error);
      record(
        `cleanup failure: cannot preserve evidence (${error.code ?? error.message})`,
      );
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        'CI audio fixture cleanup failed.',
      );
  }
  if (failure) throw failure;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.platform !== 'linux' || !process.env.CI)
      throw new Error('Use only in the disposable Linux browser CI job.');
    if (process.argv.length === 3 && process.argv[2] === '--check-packages')
      checkPackages();
    else if (
      process.argv.length === 2 &&
      process.platform === 'linux' &&
      process.env.CI &&
      process.env.DEBUG?.includes('pw:browser')
    )
      await browserAudio();
    else
      throw new Error(
        'Use only in the Linux browser CI job with DEBUG=pw:browser.',
      );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
