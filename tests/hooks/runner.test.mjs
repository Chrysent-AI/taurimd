import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { run } from '../../scripts/run.mjs';

test('shared command runner propagates nonzero quality results', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(7)']),
    /failed/,
  );
  await run(process.execPath, ['-e', 'process.exit(0)']);
});
test(
  'interruption reaps the owned command group and grandchild',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const childCode =
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);";
    const moduleUrl = new URL('../../scripts/run.mjs', import.meta.url).href;
    const wrapperCode = `import(${JSON.stringify(moduleUrl)}).then(({run})=>run(process.execPath,['-e',${JSON.stringify(childCode)}])).catch(()=>{process.exitCode=1});`;
    const wrapper = spawn(process.execPath, ['-e', wrapperCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pids = [];
    let output = '';
    let guard;
    let cleanupError;
    const exited = new Promise((resolve, reject) => {
      wrapper.once('exit', resolve);
      wrapper.once('error', reject);
    });
    try {
      await new Promise((resolve, reject) => {
        guard = setTimeout(() => {
          reject(new Error('Command fixture did not become ready'));
        }, 5000);
        wrapper.once('error', reject);
        wrapper.stdout.on('data', (data) => {
          output += data.toString();
          if (output.includes('\n')) {
            pids = JSON.parse(output.split('\n')[0]);
            clearTimeout(guard);
            resolve();
          }
        });
      });
      wrapper.kill('SIGTERM');
      assert.notEqual(await exited, 0);
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const alive = pids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
              return false;
            }
          });
          if (alive.length === 0) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error('Owned fixture descendants survived interruption'),
            );
          setTimeout(probe, 20);
        };
        probe();
      });
    } finally {
      clearTimeout(guard);
      if (wrapper.exitCode === null && wrapper.signalCode === null)
        wrapper.kill('SIGTERM');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            cleanupError = error;
            console.error(error);
          }
        }
      }
      await exited;
    }
    assert.equal(cleanupError, undefined);
  },
);
