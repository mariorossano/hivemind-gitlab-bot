import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GitLabBot } from '../src/runtime.ts';

const source = process.env.HIVEMIND_TEST_SOURCE;
test('external GitLab native tools configure, connect, follow, watch and stop one real isolated monitor', { skip: !source, timeout: 30000 }, async t => {
  const { Hive } = await import(pathToFileURL(path.join(source!, 'src/server/hive.ts')).href);
  const { createApp } = await import(pathToFileURL(path.join(source!, 'src/server/app.ts')).href);
  const { startServer } = await import(pathToFileURL(path.join(source!, 'src/server/serve.ts')).href);
  const { registerBotDefinition, saveProjectBotConfiguration } = await import(pathToFileURL(path.join(source!, 'src/server/bot-definitions.ts')).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-native-gitlab-'));
  const hive = new Hive(path.join(dir, 'hive', 'hive.db'));
  registerBotDefinition(hive.home, fileURLToPath(new URL('../hivemind-bot.json', import.meta.url)));
  const core = startServer({ hive, port: 0, telegram: false });
  let profile: string | undefined;
  t.after(async () => {
    if (profile) {
      const monitor = new GitLabBot(profile);
      try {
        monitor.desired(false);
        for (let i = 0; i < 150 && monitor.isRunning(); i++) await delay(50);
        assert.equal(monitor.isRunning(), false, 'owned test monitor must stop before removing its profile');
      } finally { monitor.close(); }
    }
    await core.shutdown(); hive.close(); rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${await core.ready}`, app = createApp(hive);
  const human = hive.identity.getAgent('human');
  const project = hive.projects.createProject(human, { name: 'GitLab fixture', slug: 'gitlab-fixture' });
  const brain = hive.identity.join({ role: 'brain', project: project.slug });
  const channel = hive.channels.createChannel(human, { name: 'MR', type: 'private', project: project.slug, memberNames: [brain.agent.name] });
  const summary = hive.channels.createChannel(human, { name: 'Discovery', type: 'private', project: project.slug, memberNames: [brain.agent.name] });
  const calls = path.join(dir, 'calls.log'), executable = path.join(dir, 'fixture-glab');
  writeFileSync(calls, '');
  writeFileSync(executable, `#!${process.execPath}
    const fs=require('node:fs'),args=process.argv.slice(2);
    if(args[0]!=='api'||args[args.indexOf('--method')+1]!=='GET'||args[args.indexOf('--hostname')+1]!=='gitlab.example.invalid')process.exit(31);
    const endpoint=decodeURIComponent(new URL('https://gitlab.example.invalid/'+args[1]).pathname);
    fs.appendFileSync(${JSON.stringify(calls)},endpoint+'\\n');
    let result;
    if(endpoint==='/user')result={id:7,username:'fixture'};
    else if(endpoint==='/projects/group/repo')result={id:42,path_with_namespace:'group/repo',web_url:'https://gitlab.example.invalid/group/repo'};
    else if(endpoint==='/projects/42/merge_requests')result=[];
    else process.exit(32);
    console.log(JSON.stringify(result));`, { mode: 0o700 });
  const saved = await saveProjectBotConfiguration(hive.home, project, origin, 'hivemind-gitlab', {
    enabled: true, expectedRevision: 0, values: { host: 'gitlab.example.invalid', executable },
  });
  profile = saved.home;
  const setup = await app.request(`${origin}/api/ui/projects/${project.id}/bots/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'GitLab', definitionId: 'hivemind-gitlab' }),
  });
  assert.equal(setup.status, 201);
  const created = await setup.json() as any; assert.equal(created.connected, true);
  const call = async (tool: string, args = {}) => {
    const response = await app.request(`${origin}/api/agent/bots/${created.bot.id}/tools`, {
      method: 'POST', headers: { authorization: `Bearer ${brain.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool, arguments: args }),
    });
    const body = await response.json() as any;
    let diagnostic = `${tool}: ${JSON.stringify(body)}`;
    if (response.status !== 200 && tool === 'start' && profile) {
      // This profile contains synthetic fixtures only. Preserve the daemon's
      // startup evidence before test cleanup removes it; the API stays redacted.
      try { diagnostic += `\nFixture monitor log:\n${readFileSync(path.join(profile, 'monitor.log'), 'utf8')}`; }
      catch { /* startup may have failed before opening its log */ }
    }
    assert.equal(response.status, 200, diagnostic); return body.result;
  };
  assert.equal((await call('status')).monitorRunning, false);
  const followed = await call('follow', { url: 'https://gitlab.example.invalid/group/repo/-/merge_requests/1', channel: channel.id });
  assert.ok(followed.id); assert.equal(readFileSync(calls, 'utf8'), '');
  assert.ok(hive.channels.getChannel(channel.id).memberIds.includes(created.bot.id));
  const watched = await call('watch', { repository: 'https://gitlab.example.invalid/group/repo', channel: summary.id, brain: brain.agent.name });
  assert.ok(watched.id); assert.equal(watched.monitorRunning, false, 'Watch setup must not report its own temporary lock as a running monitor');
  assert.equal((await call('status')).monitorRunning, false);
  const readsBeforeStopWatch = readFileSync(calls, 'utf8');
  assert.equal((await call('stop_watch', { id: watched.id })).discoveryEnabled, false);
  const discoveryLink = hive.rooms.botLinks(created.bot, summary.id)[0]!;
  assert.equal(discoveryLink.observed, 'failed', 'Stopping offline discovery must reconcile its source link too');
  assert.match(discoveryLink.detail, /explicitly unfollowed/);
  assert.equal(readFileSync(calls, 'utf8'), readsBeforeStopWatch);
  assert.equal((await call('resume_watch', { id: watched.id })).discoveryEnabled, true);
  const details = await call('status', { section: 'subscriptions' });
  assert.equal(details.total, 2); assert.equal(details.rows.length, 2);
  const providerReads = readFileSync(calls, 'utf8');
  assert.equal((await call('stop')).monitorRunning, false);
  const sourceLink = () => hive.rooms.botLinks(created.bot, channel.id).find((link: { id: string }) => link.id === followed.id)!;
  assert.equal(sourceLink().observed, 'failed');
  assert.match(sourceLink().detail, /Monitor explicitly stopped/);
  assert.equal((await call('unfollow', { id: followed.id })).state, 'stopped');
  assert.match(sourceLink().detail, /Subscription explicitly unfollowed/);
  assert.equal(readFileSync(calls, 'utf8'), providerReads, 'Stop/unfollow reconcile only with Hivemind, without reading GitLab');
  assert.equal((await call('start')).monitorRunning, true);
  assert.equal((await call('stop')).stopRequested, true);
  let state = await call('status');
  for (let i = 0; i < 30 && state.monitorRunning; i++) { await delay(50); state = await call('status'); }
  assert.equal(state.monitorRunning, false);
  assert.equal(hive.identity.listAgents(human).filter((agent: { role: string }) => agent.role === 'bot').length, 1);
});
