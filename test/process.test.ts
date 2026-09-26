import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, watch, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/readers/process.ts';

for (const reason of ['cancel', 'timeout'] as const) {
  test(`reader ${reason} settles when a detached descendant retains output pipes`, { timeout: 5000 }, async t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gitlab-reader-pipes-'));
    const marker = path.join(dir, 'ready'), file = path.join(dir, 'reader.cjs');
    let descendant: number | undefined;
    t.after(() => {
      if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ } }
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(file, `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",${JSON.stringify(marker)}],{detached:true,stdio:['ignore',1,2]});
      child.unref();
    `);
    const ready = new Promise<void>(resolve => {
      const watcher = watch(dir, () => { if (existsSync(marker)) { watcher.close(); resolve(); } });
      t.after(() => watcher.close());
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const result = runCommand({ executable: process.execPath, args: [file], cwd: dir, timeoutMs: 10000, signal: controller.signal });
    const rejected = assert.rejects(result, reason === 'cancel' ? /Reader cancelled/ : /Reader timed out/);
    await ready; descendant = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
    if (reason === 'cancel') controller.abort();
    else t.mock.timers.tick(10001);
    t.mock.timers.tick(1001);
    await rejected;
  });
}
