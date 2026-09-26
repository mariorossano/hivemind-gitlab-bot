import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { GitLabBot, init, main } from '../src/runtime.ts';
import { configureProfile } from '../src/profile.ts';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function fixture(t: TestContext, bootstrap: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-startup-'));
  init(home, { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' });
  const bot = new GitLabBot(home);
  const pidFile = path.join(home, 'child.pid');
  const preload = path.join(home, 'bootstrap.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
    import { isMainThread } from 'node:worker_threads';
    if (isMainThread) {
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      ${bootstrap}
    }`);
  // Only children of this isolated test process inherit this synthetic preload.
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  const pid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
  t.after(async () => {
    if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original;
    bot.desired(false);
    const child = pid();
    if (child && alive(child)) {
      process.kill(child, 'SIGKILL');
      for (let i = 0; i < 100 && alive(child); i++) await delay(20);
      assert.equal(alive(child), false, 'Only the owned fixture child must exit before profile cleanup');
    }
    bot.close(); rmSync(home, { recursive: true, force: true });
  });
  return { home, bot, pid, async loaded() {
    for (let i = 0; i < 250 && !pid(); i++) await delay(20);
    assert.ok(pid(), 'Synthetic monitor bootstrap must load');
  } };
}

test('monitor start waits for actual readiness beyond the old three-second polling window', { timeout: 15000 }, async t => {
  const f = fixture(t, 'await new Promise(resolve => setTimeout(resolve, 4500));');
  await f.bot.start();
  assert.equal(f.bot.isRunning(), true);
  assert.equal(f.bot.desired(), true);
});

test('a child that exits during startup leaves no running intent or delayed daemon', { timeout: 10000 }, async t => {
  const f = fixture(t, 'process.exit(23);');
  await assert.rejects(f.bot.start(), /monitor.*(start|exit)/i);
  assert.equal(f.bot.desired(), false);
  assert.equal(f.bot.isRunning(), false);
  assert.ok(f.pid());
  assert.equal(alive(f.pid()!), false);
});

test('stop during bootstrap is not overwritten by the late child', { timeout: 15000 }, async t => {
  const f = fixture(t, 'await new Promise(resolve => setTimeout(resolve, 1500));');
  const outcome = f.bot.start().then(() => null, error => error);
  await f.loaded();
  f.bot.desired(false);
  assert.ok((await outcome) instanceof Error, 'An interrupted startup must not return a running receipt');
  assert.equal(f.bot.desired(), false);
  assert.equal(f.bot.isRunning(), false);
  assert.equal(alive(f.pid()!), false);
});

test('profile changes and concurrent starts cannot enter an in-progress startup', { timeout: 15000 }, async t => {
  const f = fixture(t, 'await new Promise(resolve => setTimeout(resolve, 1500));');
  const outcome = f.bot.start().then(() => null, error => error);
  await f.loaded();
  await assert.rejects(f.bot.start(), /locked/);
  assert.throws(() => configureProfile(f.home, { config: { ...f.bot.config, intervalSeconds: 1200 }, projectId: 'p' }), /locked/);
  await assert.rejects(main(['poll', '--home', f.home]), /locked/);
  assert.equal(await outcome, null);
  assert.equal(f.bot.isRunning(), true);
  assert.equal(f.bot.config.intervalSeconds, JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8')).intervalSeconds);
});

test('an invalid child initialization fails promptly and releases the startup lock', { timeout: 10000 }, async t => {
  const f = fixture(t, 'writeFileSync(new URL("./config.json", import.meta.url), "invalid-json");');
  await assert.rejects(f.bot.start(), /Monitor.*(exit|disconnect)/);
  assert.equal(f.bot.desired(), false);
  assert.equal(f.bot.isRunning(), false);
  assert.equal(alive(f.pid()!), false);
  const release = f.bot.lock('setup'); release();
});

test('another temporary monitor lock cannot stand in for child readiness', { timeout: 15000 }, async t => {
  const f = fixture(t, 'await new Promise(resolve => setTimeout(resolve, 1500));');
  const outcome = f.bot.start().then(() => null, error => error);
  await f.loaded();
  const release = f.bot.lock();
  try {
    assert.ok((await outcome) instanceof Error, 'Only the owned child may confirm startup');
    assert.equal(f.bot.desired(), false);
    assert.equal(alive(f.pid()!), false);
  } finally { release(); }
});

test('a one-shot poll with retained running intent is not an already running daemon', async t => {
  const f = fixture(t, 'throw new Error("This test must not spawn a daemon");');
  f.bot.desired(true);
  t.mock.method(GitLabBot.prototype, 'cycle', async () => {
    await assert.rejects(f.bot.start(), /stopping/);
    return [];
  });
  t.mock.method(console, 'log', () => {});
  await main(['poll', '--home', f.home]);
  assert.equal(f.bot.desired(), false);
  assert.equal(f.pid(), undefined);
});

test('a monitor that never becomes ready times out and is reaped before returning', { timeout: 30000 }, async t => {
  const f = fixture(t, 'await new Promise(() => { setInterval(() => {}, 1000); });');
  await assert.rejects(f.bot.start(), /Monitor startup timed out/);
  assert.equal(f.bot.desired(), false);
  assert.equal(f.bot.isRunning(), false);
  assert.equal(alive(f.pid()!), false);
  const release = f.bot.lock('setup'); release();
});

test('loss of the invoking process before readiness cannot leave a late daemon', { timeout: 15000 }, async t => {
  const f = fixture(t, 'await new Promise(resolve => setTimeout(resolve, 1500));');
  // The real start CLI does not get the delay; only its spawned daemon does.
  const script = path.join(f.home, 'parent.mjs');
  writeFileSync(script, `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
    register();
    const { GitLabBot } = await import(${JSON.stringify(new URL('../src/runtime.ts', import.meta.url).href)});
    process.env.NODE_OPTIONS = ${JSON.stringify(process.env.NODE_OPTIONS)};
    const bot = new GitLabBot(${JSON.stringify(f.home)});
    try { await bot.start(); } finally { bot.close(); }`);
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const parent = spawn(process.execPath, [script], { env, stdio: 'ignore' });
  const exited = once(parent, 'exit');
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); await exited; });
  await f.loaded();
  parent.kill('SIGKILL'); await exited;
  for (let i = 0; i < 250 && alive(f.pid()!); i++) await delay(20);
  assert.equal(alive(f.pid()!), false, 'The child must reject the lost startup connection before polling');
  assert.equal(f.bot.isRunning(), false);
});
