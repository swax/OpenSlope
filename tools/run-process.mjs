import { spawn, spawnSync } from 'node:child_process';

/** Stop only the tree created for this verification step, including npm's child test runners and Chrome. */
export function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

/** A timeout or Ctrl+C owns the entire spawned tree; waiting for close retains its final output. */
export function runProcess(command, args, { timeout, ...options }) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let error;
    const cancel = () => {
      error = Object.assign(new Error('Verification interrupted'), {
        code: 'EINTR',
      });
      stopProcessTree(child);
    };
    const deadline = setTimeout(() => {
      error = Object.assign(new Error(`Verification step timed out after ${timeout}ms`), { code: 'ETIMEDOUT' });
      stopProcessTree(child);
    }, timeout);
    deadline.unref();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    child.once('error', value => {
      error = value;
    });
    child.once('close', status => {
      clearTimeout(deadline);
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      resolve({ status, error });
    });
  });
}
