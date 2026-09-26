import { spawn } from 'node:child_process';

const ready = 'gitlab-monitor-ready', commit = 'gitlab-monitor-commit', started = 'gitlab-monitor-started';

/** The owned child, not a contended SQLite lock, confirms readiness. No retry. */
export function launchMonitor(entrypoint: string, home: string, log: number, desired: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, 'run', '--home', home, '--managed-start'], {
      detached: true, stdio: ['ignore', log, log, 'ipc'],
    });
    let settled = false, failure: Error | undefined, committed = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const clean = () => {
      clearTimeout(timer); clearTimeout(cleanupTimer); clearInterval(stopTimer);
      child.off('message', message); child.off('exit', exited); child.off('disconnect', disconnected);
      if (child.connected) child.disconnect();
      child.unref();
    };
    const rejectOnce = () => {
      if (settled) return;
      settled = true; clean(); reject(failure!);
    };
    const fail = (reason: string) => {
      if (settled || failure) return;
      failure = new Error(reason); clearTimeout(timer);
      // Only this attempt's detached child group is owned by us. Never kill a
      // daemon discovered through status or retry an ambiguous start.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch { /* exit notification may already be queued */ }
        cleanupTimer = setTimeout(rejectOnce, 1000);
      } else rejectOnce();
    };
    const exited = () => {
      if (!failure) failure = new Error('Monitor exited before startup completed; inspect monitor.log');
      rejectOnce();
    };
    const disconnected = () => fail('Monitor disconnected before startup completed; inspect monitor.log');
    const checkDesired = () => {
      try {
        if (desired()) return true;
        fail('Monitor start cancelled by stop');
      } catch { fail('Monitor startup state could not be verified'); }
      return false;
    };
    const message = (value: unknown) => {
      if (settled || failure) return;
      try {
        if (!checkDesired()) return;
        if (value === ready && !committed) {
          committed = true;
          child.send(commit, error => { if (error) fail('Monitor startup acknowledgement failed'); });
        } else if (value === started && committed) {
          settled = true; clean(); resolve();
        }
      } catch { fail('Monitor startup state could not be verified'); }
    };
    // Leave headroom inside the bot executor's 30-second admission deadline.
    const timer = setTimeout(() => fail('Monitor startup timed out; inspect monitor.log'), 20000);
    const stopTimer = setInterval(() => { if (!settled && !failure) checkDesired(); }, 100);
    child.on('message', message); child.once('exit', exited); child.once('disconnect', disconnected);
    child.on('error', () => fail('Cannot start monitor; inspect monitor.log'));
  });
}

/** Called only after initialization, the monitor lock and stop handlers exist. */
export async function acceptMonitorStart(desired: () => boolean) {
  if (!process.send || !process.connected) throw new Error('Monitor startup parent is unavailable');
  await new Promise<void>((resolve, reject) => {
    const clean = () => { process.off('message', message); process.off('disconnect', disconnected); };
    const disconnected = () => { clean(); reject(new Error('Monitor startup parent disconnected')); };
    const message = (value: unknown) => {
      if (value !== commit) return;
      clean();
      if (desired()) resolve(); else reject(new Error('Monitor start cancelled by stop'));
    };
    process.on('message', message); process.once('disconnect', disconnected);
    process.send!(ready, error => { if (error) { clean(); reject(error); } });
  });
  if (!desired()) throw new Error('Monitor start cancelled by stop');
  await new Promise<void>((resolve, reject) => {
    process.send!(started, error => { if (error) reject(error); else resolve(); });
  });
  if (process.connected) process.disconnect?.();
}
