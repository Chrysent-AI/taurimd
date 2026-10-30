import { spawn } from 'node:child_process';

export function run(program, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(program, args, {
      cwd: options.cwd,
      detached: grouped,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: [
        options.input === undefined ? 'inherit' : 'pipe',
        'inherit',
        'inherit',
      ],
    });
    let interrupted = false;
    let escalation;
    let treeStop = Promise.resolve();
    const signal = (name) => {
      interrupted = true;
      if (!grouped) {
        // Windows has no POSIX process-group signal: terminate the owned tree.
        treeStop = new Promise((done) => {
          const killer = spawn(
            'taskkill',
            ['/pid', String(child.pid), '/t', '/f'],
            { stdio: 'inherit' },
          );
          killer.once('error', (error) => {
            console.error(error.message);
            done();
          });
          killer.once('close', (code) => {
            if (code !== 0) console.error('Owned process-tree cleanup failed.');
            done();
          });
        });
        return;
      }
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error.message);
      }
      escalation ??= setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') console.error(error.message);
        }
      }, 5000);
    };
    const onInt = () => {
      signal('SIGINT');
    };
    const onTerm = () => {
      signal('SIGTERM');
    };
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    const cleanup = () => {
      clearTimeout(escalation);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', async (code, termination) => {
      await treeStop;
      cleanup();
      if (interrupted && grouped) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') return reject(error);
        }
        try {
          process.kill(-child.pid, 0);
          return reject(
            new Error(
              'Interrupted process group is still present; inspect owned descendants.',
            ),
          );
        } catch (error) {
          if (error.code !== 'ESRCH') return reject(error);
        }
      }
      if (code !== 0 || interrupted)
        reject(
          new Error(
            `${program} failed (${termination ?? code}${interrupted ? ', interrupted' : ''}).`,
          ),
        );
      else resolve();
    });
    if (options.input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}
