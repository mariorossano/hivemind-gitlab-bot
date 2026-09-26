import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureProfile } from '../src/profile.ts';
import { invoke } from '../src/bot-interface.ts';
import { GitLabBot } from '../src/runtime.ts';

test('native bot interface connects one exact identity, keeps tokens out of results and never auto-starts', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-bot-interface-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' }, projectId: 'project' });
  const context = { projectId: 'project', botId: 'bot-id', botName: 'GitLab', arguments: {} };
  await assert.rejects(invoke(home, { ...context, tool: 'status' }), /Connect/);
  assert.deepEqual(await invoke(home, { ...context, tool: 'connect', token: 'private-fixture-token' }), { connected: true });
  const status = await invoke(home, { ...context, tool: 'status' }) as { monitorRunning: boolean };
  assert.equal(status.monitorRunning, false); assert.ok(!JSON.stringify(status).includes('private-fixture-token'));
  await assert.rejects(invoke(home, { ...context, botId: 'different', tool: 'connect', token: 'different' }), /another bot/);
  await assert.rejects(invoke(home, { ...context, projectId: 'different', tool: 'status' }), /another Hivemind project/);
  await assert.rejects(invoke(home, { ...context, tool: 'status', arguments: { command: 'anything' } }));
  await assert.rejects(invoke(home, { ...context, tool: 'status', token: 'unexpected' }), /only accepted by connect/);
  await assert.rejects(invoke(home, { ...context, tool: 'shell', arguments: {} }));
  assert.deepEqual(await invoke(home, { ...context, tool: 'stop' }), { stopRequested: true, monitorRunning: false });
});

test('native status stays bounded and paginates a large retained monitor history without losing IDs', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-bot-status-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' }, projectId: 'project' });
  const context = { projectId: 'project', botId: 'bot-id', botName: 'GitLab', arguments: {} };
  await invoke(home, { ...context, tool: 'connect', token: 'private-fixture-token' });
  const bot = new GitLabBot(home);
  try {
    const insert = bot.db.prepare("INSERT INTO subscriptions(id,url,channel,bot,enabled,initial,last_error) VALUES(?,?,?, ?,1,'snapshot',?)");
    for (let i = 0; i < 200; i++) insert.run(`sub-${String(i).padStart(3, '0')}`, `https://gitlab.example.invalid/group/repo/-/merge_requests/${i+1}`, 'channel', 'bot-id', 'é'.repeat(9000));
  } finally { bot.close(); }
  const summary = await invoke(home, { ...context, tool: 'status' });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 60000);
  const ids: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page = await invoke(home, { ...context, tool: 'status', arguments: { section: 'subscriptions', offset, limit: 40 } }) as any;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 60000);
    assert.equal(page.total, 200); assert.ok(page.rows.length > 0);
    assert.ok(page.truncatedFields.length > 0);
    ids.push(...page.rows.map((row: any) => row.id));
    offset = page.nextOffset;
  }
  assert.equal(ids.length, 200); assert.equal(new Set(ids).size, 200);
  await assert.rejects(invoke(home, { ...context, tool: 'status', arguments: { section: 'bots' } }));
});

test('native start preserves a pending stop until the previous monitor releases its lock', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-bot-restart-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' }, projectId: 'project' });
  const context = { projectId: 'project', botId: 'bot-id', botName: 'GitLab', arguments: {} };
  await invoke(home, { ...context, tool: 'connect', token: 'private-fixture-token' });
  const bot = new GitLabBot(home);
  const release = bot.lock();
  try {
    bot.desired(true);
    assert.deepEqual(await invoke(home, { ...context, tool: 'start' }), { monitorRunning: true });
    assert.deepEqual(await invoke(home, { ...context, tool: 'stop' }), { stopRequested: true, monitorRunning: true });
    // The daemon may already have aborted, but still hold its lock while it
    // reports stopped source links. Start must not mistake it for a healthy run.
    await assert.rejects(invoke(home, { ...context, tool: 'start' }), /stopping/);
    assert.equal(bot.desired(), false);
  } finally { release(); bot.close(); }
  const status = await invoke(home, { ...context, tool: 'status' }) as { monitorRunning: boolean };
  assert.equal(status.monitorRunning, false);
});

test('temporary follow setup cannot be mistaken for an already running daemon by a concurrent start', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-bot-start-follow-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' }, projectId: 'project' });
  const context = { projectId: 'project', botId: 'bot-id', botName: 'GitLab', arguments: {} };
  await invoke(home, { ...context, tool: 'connect', token: 'private-fixture-token' });
  const bot = new GitLabBot(home); bot.desired(true); bot.close(); // retained intent after a previous process exited
  const lock = GitLabBot.prototype.lock;
  let armed = true, concurrent: Promise<unknown> | undefined;
  t.mock.method(GitLabBot.prototype, 'follow', async () => ({ id: 'fixture' }));
  t.mock.method(GitLabBot.prototype, 'lock', function (this: GitLabBot, name = 'monitor') {
    const release = lock.call(this, name);
    if (armed && name === 'monitor') {
      armed = false;
      concurrent = invoke(home, { ...context, tool: 'start' }).then(result => result, error => error);
    }
    return release;
  });
  await invoke(home, { ...context, tool: 'follow', arguments: { url: 'https://gitlab.example.invalid/g/r/-/merge_requests/1', channel: 'channel' } });
  assert.ok(concurrent);
  assert.ok((await concurrent) instanceof Error, 'A transient setup lock must never produce a successful Start receipt');
});
