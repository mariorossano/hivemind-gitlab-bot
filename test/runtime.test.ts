import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { GitLabBot, init, hiveOrigin } from '../src/runtime.ts';
import { definitionId, label } from '../src/provider.ts';
import { archiveError } from '../src/lifecycle.ts';
import type { Runner } from '../src/readers/process.ts';
const slack = definitionId.endsWith('slack');
const url = slack ? 'https://example.slack.com/archives/CFIXTURE/p1900000000123456' : 'https://gitlab.example.invalid/demo/repo/-/merge_requests/7';
const other = slack ? url.replace('CFIXTURE', 'COTHER') : url.replace('/7', '/8');
const root = fileURLToPath(new URL('../', import.meta.url));
async function setup(t: TestContext, runner: Runner = async () => { throw new Error('NO REAL PROVIDER IN THIS TEST'); }) {
  const home = mkdtempSync(path.join(os.tmpdir(), definitionId + '-test-'));
  const channels = ['one', 'two'].map(id => ({ id, name: id, type: 'private', projectId: 'p', memberIds: [] as string[] }));
  const agents: any[] = [], received: any[] = [], events = new Map<string, any>();
  const links = new Map<string, any>(), archived = new Set<string>();
  const calls: string[] = [];
  const hooks = { beforeSend: undefined as (() => void) | undefined, beforeReport: undefined as (() => void) | undefined,
    afterArchiveReply: undefined as (() => void) | undefined, failLinks: 0, failReports: 0, loseReport: false };
  const changeRoom = (channel: string, pause: boolean, resume = false) => {
    // Real core needs another archive before changing a room-only reopen to source resume.
    if (!pause && resume && !archived.has(channel)) changeRoom(channel, true);
    if (pause) archived.add(channel); else archived.delete(channel);
    if (pause || resume) for (const [key, link] of links) if (key.startsWith(channel + ':')) {
      link.desired = pause ? 'paused' : 'running'; link.generation++; link.observed = 'pending'; link.detail = '';
    }
  };
  let fail = 0, missingAck = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const data of req) raw += data;
    const body = raw ? JSON.parse(raw) : {};
    calls.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === '/api/ui/snapshot') { send({ channels, agents }); return; }
    if (req.url === '/api/ui/projects/p/bots') {
      const bot = { id: 'b' + agents.length, name: body.name, role: 'bot', projectId: 'p' };
      agents.push(bot); send({ bot, token: 'fixture-only-' + bot.id }); return;
    }
    const channel = channels.find(c => req.url?.includes('/channels/' + c.id + '/'));
    if (!channel) { res.statusCode = 404; send({ error: 'missing' }); return; }
    if (req.url?.endsWith('/bots')) {
      const bot = { id: 'b' + agents.length, name: body.name, role: 'bot' }; agents.push(bot); channel.memberIds.push(bot.id);
      send({ bot, token: 'fixture-only-' + bot.id }); return;
    }
    if (req.url?.endsWith('/invite')) {
      channel.memberIds.push(agents.find(a => a.name === body.names[0]).id); send({ channel }); return;
    }
    if (req.url?.startsWith('/api/bot/') && req.url.includes('/links')) {
      const bot = agents.find(a => req.headers.authorization === 'Bearer fixture-only-' + a.id);
      assert.ok(bot && channel.memberIds.includes(bot.id));
      if (hooks.failLinks) { res.statusCode = hooks.failLinks; send({error:'fixture links'}); return; }
      if (req.method === 'GET') { send({links:[...links.entries()].filter(([key])=>key.startsWith(channel.id+':')).map(([,link])=>link)}); return; }
      if (req.url.endsWith('/links')) {
        const key=channel.id+':'+body.id;
        if (!links.has(key)) links.set(key,{...body,botId:bot.id,desired:archived.has(channel.id)?'paused':'running',generation:1,observed:'pending',detail:''});
        send({link:links.get(key)}); return;
      }
      const link=links.get(channel.id+':'+req.url.split('/').at(-2));
      const hook=hooks.beforeReport; hooks.beforeReport=undefined; hook?.();
      if (hooks.failReports) {res.statusCode=hooks.failReports;send({error:'fixture report'});return;}
      if (!link || body.generation!==link.generation || (['running','paused'].includes(body.observed)&&body.observed!==link.desired)) {
        res.statusCode=409;send({error:'Stale source command; reread links'});return;
      }
      Object.assign(link,body);
      if(hooks.loseReport){hooks.loseReport=false;req.socket.destroy();return;}
      send({link});return;
    }
    if (req.url?.startsWith('/api/bot/') && req.url.endsWith('/messages')) {
      const hook=hooks.beforeSend; hooks.beforeSend=undefined; hook?.();
      if (fail) { res.statusCode = fail; send({ error: 'fixture' }); return; }
      const bot = agents.find(a => req.headers.authorization === 'Bearer fixture-only-' + a.id);
      assert.ok(bot && channel.memberIds.includes(bot.id));
      const key = channel.id + ':' + body.eventId;
      let message = events.get(key);
      if (!message && archived.has(channel.id)) { res.statusCode=409;hooks.afterArchiveReply?.();hooks.afterArchiveReply=undefined;send({error:archiveError});return; }
      if (!message) { message = { id: String(events.size + 1), channelId: channel.id, authorId: bot.id, authorRole: 'bot', botEvent: { eventId: body.eventId }, body: body.body }; events.set(key, message); received.push(message); }
      if (missingAck) { missingAck = false; req.socket.destroy(); return; }
      send({ message }); return;
    }
    res.statusCode = 404; send({});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hiveUrl = 'http://127.0.0.1:' + (server.address() as any).port;
  init(home, { hiveUrl, host: new URL(url).host, ...(slack ? { cwd: home } : {}) });
  let gitlab = new GitLabBot(home, runner);
  t.after(async () => { gitlab.desired(false); for (let i=0;i<50 && gitlab.isRunning();i++) await delay(100); gitlab.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(home, { recursive: true, force: true }); });
  return { home, hiveUrl, channels, agents, received, links, hooks, calls, changeRoom,
    get gitlab() { return gitlab; }, reopen() { gitlab.close(); gitlab = new GitLabBot(home, runner); },
    fail(code: number) { fail = code; }, loseAck() { missingAck = true; } };
}
function snapshot(text = 'Invented observation') { return { observations: [{ key: 'one', value: text, body: text, url }] }; }
async function cli(home: string, args: string[]) {
  const child = spawn(process.execPath, [path.join(root, 'bin', definitionId + '.mjs'), '--home', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', d=>out+=d); child.stderr.on('data', d=>err+=d);
  const timer = setTimeout(()=>child.kill('SIGKILL'), 10000);
  try { const [code] = await once(child, 'close'); return { code, out, err }; } finally { clearTimeout(timer); }
}
test('follow reuses one bot across sources/channels; status and restart retain links without reading', async t => {
  const f = await setup(t);
  const one = await f.gitlab.follow(url, 'one'); await f.gitlab.follow(other, 'one'); await f.gitlab.follow(url, 'two');
  assert.equal((await f.gitlab.follow(url, 'one')).id, one.id);
  assert.equal(f.agents.length, 1); assert.equal(f.gitlab.subscriptions().length, 3);
  assert.equal(f.agents[0].name, label);
  assert.equal(f.received.length, 0); assert.equal(f.gitlab.status().monitorRunning, false);
  assert.ok(!JSON.stringify(f.gitlab.status()).includes('fixture-only'));
  assert.equal(statSync(path.join(f.home, 'state.db')).mode & 0o777, 0o600);
  f.reopen(); assert.equal(f.gitlab.subscriptions().length, 3);
});
test('new bots use readable numeric names when other identities already own the label', async t => {
  const f = await setup(t);
  f.agents.push({id:'existing-brain',name:label.toLowerCase(),role:'brain'}, {id:'existing-bot',name:label+'-2',role:'bot'});
  const link = await f.gitlab.follow(url, 'one');
  assert.equal(link.bot, label+'-3');
  assert.equal(f.agents.length, 3);
  assert.equal(f.received.length, 0);
});
test('a renamed bot keeps its identity and uses its current name for subsequent invitations', async t => {
  const f = await setup(t);
  await f.gitlab.follow(url, 'one');
  const botId = f.agents[0].id;
  f.agents[0].name = label+'-Work';
  f.reopen();
  const link = await f.gitlab.follow(url, 'two');
  assert.equal(link.bot, label+'-Work');
  assert.equal(f.agents.length, 1);
  assert.deepEqual(f.channels[1].memberIds, [botId]);
  assert.equal(f.gitlab.db.prepare('SELECT name FROM bots WHERE id=?').get(botId)!.name, label+'-Work');
  assert.equal(f.received.length, 0);
});
test('persistent snapshot dedup, observed edits/reversion and no deletion inference', async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one');
  let sub = f.gitlab.subscriptions()[0]!;
  assert.equal(f.gitlab.apply(sub, snapshot()), 1); await f.gitlab.deliver(); assert.equal(f.received.length, 1);
  f.reopen(); sub = f.gitlab.subscriptions()[0]!;
  const due = sub.next_at; await f.gitlab.follow(url, 'one'); assert.equal(f.gitlab.subscriptions()[0]!.next_at, due);
  assert.equal(f.gitlab.apply(sub, snapshot()), 0);
  assert.equal(f.gitlab.apply(sub, snapshot('Edited')), 1); await f.gitlab.deliver();
  assert.equal(f.gitlab.apply(sub, { observations: [] }), 0);
  assert.equal(f.gitlab.apply(sub, snapshot()), 1); await f.gitlab.deliver();
  assert.equal(f.received.length, 3);
});
test('baseline is quiet; bad snapshot rolls back all fingerprints and events', async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one', 'baseline'); const sub = f.gitlab.subscriptions()[0]!;
  assert.equal(f.gitlab.apply(sub, snapshot()), 0);
  assert.throws(()=>f.gitlab.apply(sub, { observations: [...snapshot('new').observations, { key: 'bad', value: 1, body: 'bad', url: 'https://wrong.invalid/' }] }));
  assert.equal(f.gitlab.apply(sub, snapshot('new')), 1);
  assert.throws(()=>f.gitlab.apply(sub, { observations: [...snapshot().observations, ...snapshot().observations] }), /Duplicate/);
});
test('lost acknowledgement retries same event; transient and terminal errors stay visible', async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot()); f.loseAck(); await f.gitlab.deliver();
  assert.equal(f.received.length, 1);
  f.gitlab.db.exec('UPDATE events SET next_at=0'); await f.gitlab.deliver(); assert.equal(f.received.length, 1);
  f.gitlab.apply(sub, snapshot('second')); f.fail(403); await f.gitlab.deliver();
  assert.equal(f.gitlab.db.prepare("SELECT COUNT(*) n FROM events WHERE state='blocked'").get()!.n, 1);
});
test('R02: bot HTTP 429 retries within a bound; abort and denials are not bypassed', {timeout:10000}, async t=>{
  const f=await setup(t);await f.gitlab.follow(url,'one');const sub=f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub,snapshot());f.fail(429);await f.gitlab.deliver();
  assert.equal(f.calls.filter(c=>c==='POST /api/bot/channels/one/messages').length,3);
  assert.equal(f.received.length,0);assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state,'pending');
  f.fail(0);f.gitlab.db.exec('UPDATE events SET next_at=0');await f.gitlab.deliver();assert.equal(f.received.length,1);
  f.gitlab.apply(sub,snapshot('next'));f.fail(403);const before=f.calls.length;await f.gitlab.deliver();
  assert.equal(f.calls.slice(before).filter(c=>c==='POST /api/bot/channels/one/messages').length,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.gitlab.request('/api/bot/channels/one/links',{},controller.signal));
});
test('unfollow cancels queued events and ignores a late read result', async t => {
  const f = await setup(t); const link = await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot()); f.gitlab.unfollow(link.id);
  assert.equal(f.gitlab.apply(sub, snapshot('late')), 0); await f.gitlab.deliver(); assert.equal(f.received.length, 0);
  assert.equal(f.gitlab.subscriptions()[0]!.enabled, 0);
});
test('bad targets never create bots and local identity cannot silently retarget', async t => {
  const f = await setup(t);
  await assert.rejects(f.gitlab.follow('https://wrong.invalid/x', 'one'));
  await assert.rejects(f.gitlab.follow(url, 'unknown')); assert.equal(f.agents.length, 0);
  assert.throws(()=>init(f.home, { hiveUrl: f.hiveUrl, host: 'other.invalid', ...(slack ? { cwd:f.home } : {}) }));
  assert.throws(()=>hiveOrigin('http://example.com'));
  assert.throws(()=>hiveOrigin('http://127.0.0.1/other'));
});
test('real CLI follow --no-start, status and unfollow make no provider calls', async t => {
  const f = await setup(t);
  const followed = await cli(f.home, ['follow', url, '--channel', 'one', '--no-start']);
  assert.equal(followed.code, 0, followed.err); const link = JSON.parse(followed.out);
  assert.equal(link.monitorRunning, false);
  assert.equal((await cli(f.home, ['status'])).code, 0);
  assert.equal((await cli(f.home, ['unfollow','--id',link.id])).code, 0);
  assert.equal(f.received.length, 0);
});
test('one owned daemon per profile, normal stop releases lock without touching other processes', {timeout:15000}, async t => {
  const f = await setup(t); await f.gitlab.start(); assert.equal(f.gitlab.isRunning(), true);
  await f.gitlab.start(); assert.throws(()=>f.gitlab.lock());
  const blocked = await cli(f.home, ['follow', url, '--channel', 'one', '--no-start']);
  assert.notEqual(blocked.code, 0); assert.equal(f.gitlab.subscriptions().length, 0);
  const stopped = await cli(f.home, ['stop']); assert.equal(stopped.code, 0, stopped.err);
  assert.equal(f.gitlab.isRunning(), false);
});

function inventedReader(onRead: (count: number) => void = () => {}) {
  let count = 0;
  const runner: Runner = async command => {
    onRead(++count);
    assert.equal(command.args[command.args.indexOf('--method') + 1], 'GET');
    return { stdout: JSON.stringify(command.args[1]!.includes('/discussions?') ? [] : {
      id: 45, iid: 7, project_id: 12, title: 'Synthetic lifecycle MR', state: 'opened', web_url: url,
      source_branch: 'fixture', target_branch: 'main', updated_at: '2030-01-01T12:00:00Z', author: { name: 'Example' },
    }) };
  };
  return { runner, count: () => count };
}
test('R03: follow in an archived room registers paused; reopen alone never resumes', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  f.changeRoom('one', true);
  const link = await f.gitlab.follow(url, 'one');
  await f.gitlab.cycle();
  assert.equal(reader.count(), 0); assert.equal(f.received.length, 0);
  assert.equal(f.links.get('one:' + link.id).observed, 'paused');
  f.changeRoom('one', false); await f.gitlab.cycle(); assert.equal(reader.count(), 0);
  f.changeRoom('one', false, true); await f.gitlab.cycle(); assert.equal(reader.count(), 2);
  assert.equal(f.received.length, 2); assert.equal(f.gitlab.subscriptions()[0]!.enabled, 1);
});
test('R03: same MR in two channels shares reads but archive pauses only one channel and preserves its queue', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const one = await f.gitlab.follow(url, 'one'); await f.gitlab.follow(url, 'two');
  await f.gitlab.cycle(); assert.equal(reader.count(), 2); assert.equal(f.received.length, 4);
  const sub = f.gitlab.subscriptions().find(s => s.id === one.id)!;
  f.gitlab.apply(sub, snapshot('queued before archive'));
  const before = f.gitlab.db.prepare("SELECT event FROM events WHERE state='pending'").get()!.event;
  f.changeRoom('one', true); await f.gitlab.cycle();
  assert.equal(reader.count(), 4); assert.equal(f.received.length, 4);
  assert.equal(f.gitlab.db.prepare("SELECT event FROM events WHERE state='pending'").get()!.event, before);
  assert.equal(f.links.get('one:' + one.id).observed, 'paused');
});
test('R03: archive during a provider GET discards the late snapshot and prevents the next GET', async t => {
  let archive = () => {};
  const reader = inventedReader(n => { if (n === 1) archive(); }), f = await setup(t, reader.runner);
  const one = await f.gitlab.follow(url, 'one'); await f.gitlab.follow(url, 'two');
  archive = () => f.changeRoom('one', true);
  // Force the archived subscription to be processed first regardless of hashed IDs.
  await f.gitlab.cycle(one.id);
  assert.equal(reader.count(), 1); assert.equal(f.received.length, 0);
  assert.equal(f.gitlab.db.prepare('SELECT COUNT(*) n FROM items').get()!.n, 0);
  await f.gitlab.cycle(); assert.equal(reader.count(), 3);
  assert.ok(f.received.every(m => m.channelId === 'two'));
});
test('R03: archive races a send; explicit resume releases the identical event, not a new revision', async t => {
  const f = await setup(t); const link = await f.gitlab.follow(url, 'one'), sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot());
  const original = f.gitlab.db.prepare('SELECT event FROM events').get()!.event;
  f.hooks.beforeSend = () => f.changeRoom('one', true);
  await f.gitlab.deliver();
  assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state, 'paused');
  assert.equal(f.received.length, 0);
  f.changeRoom('one', false); await f.gitlab.lifecycle.sync(sub); await f.gitlab.deliver();
  assert.equal(f.received.length, 0);
  f.changeRoom('one', false, true); await f.gitlab.lifecycle.sync(sub); await f.gitlab.deliver();
  assert.equal(f.received.length, 1); assert.equal(f.gitlab.db.prepare('SELECT event FROM events').get()!.event, original);
  assert.equal(f.links.get('one:' + link.id).observed, 'running');
});
test('R03: lost delivery acknowledgement followed by archive/restart/resume is deduplicated', async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one'); let sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot()); f.loseAck(); await f.gitlab.deliver(); assert.equal(f.received.length, 1);
  f.changeRoom('one', true); await f.gitlab.lifecycle.sync(sub); f.reopen(); sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.db.exec('UPDATE events SET next_at=0'); await f.gitlab.deliver(); assert.equal(f.received.length, 1);
  f.changeRoom('one', false, true); await f.gitlab.deliver();
  assert.equal(f.received.length, 1); assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state, 'sent');
});
test('R03: stale and lost lifecycle acknowledgements fail closed, then reconcile without provider duplication', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one');
  f.hooks.beforeReport = () => f.changeRoom('one', true);
  await f.gitlab.cycle(); assert.equal(reader.count(), 0);
  assert.equal(f.gitlab.lifecycle.state(link.id)!.applied, 'failed');
  f.hooks.loseReport = true; await f.gitlab.cycle(); assert.equal(reader.count(), 0);
  await f.gitlab.cycle(); assert.equal(f.gitlab.lifecycle.state(link.id)!.applied, 'paused');
  f.changeRoom('one', false, true); await f.gitlab.cycle(); assert.equal(reader.count(), 2);
  await f.gitlab.cycle(); assert.equal(f.received.length, 2);
});
test('R03: unavailable/malformed/regressed lifecycle never falls back to blind reading or sending', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot());
  for (const status of [404, 403, 503]) {
    f.hooks.failLinks = status; await f.gitlab.cycle();
    assert.equal(reader.count(), 0); assert.equal(f.received.length, 0);
    assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state, 'pending');
  }
  f.hooks.failLinks = 0;
  const remote = f.links.get('one:' + link.id); remote.generation = 4; f.changeRoom('one', true);
  await f.gitlab.lifecycle.sync(sub); remote.generation = 1; remote.desired = 'running';
  await f.gitlab.cycle(); assert.equal(reader.count(), 0);
  remote.generation = 'invalid'; await f.gitlab.cycle(); assert.equal(reader.count(), 0);
});
for (const status of [409, 403]) test(`ordinary HTTP ${status} stays blocked across channel pause/resume`, async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot()); f.fail(status); await f.gitlab.deliver();
  const original = f.gitlab.db.prepare('SELECT event FROM events').get()!.event;
  f.fail(0); f.changeRoom('one', true); await f.gitlab.lifecycle.sync(sub);
  f.changeRoom('one', false, true); await f.gitlab.lifecycle.sync(sub); await f.gitlab.deliver();
  assert.equal(f.received.length, 0); assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state, 'blocked');
  assert.equal(f.gitlab.db.prepare('SELECT event FROM events').get()!.event, original);
});
test('R03: unfollow and manual stop survive room resume and process restart', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot()); f.changeRoom('one', true); await f.gitlab.lifecycle.sync(sub);
  f.gitlab.unfollow(link.id); f.gitlab.desired(false); f.reopen();
  f.changeRoom('one', false, true); await f.gitlab.cycle(); await f.gitlab.reportStopped();
  assert.equal(reader.count(), 0); assert.equal(f.gitlab.isRunning(), false); assert.equal(f.gitlab.desired(), false);
  assert.equal(f.gitlab.db.prepare('SELECT state FROM events').get()!.state, 'cancelled');
  assert.equal(f.links.get('one:' + link.id).observed, 'failed');
  assert.match(f.links.get('one:' + link.id).detail, /unfollowed/);
});
test('R03: concurrent unfollow during acknowledgement prevents the subsequent GET', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one'); f.hooks.beforeReport = () => { f.gitlab.unfollow(link.id); };
  await f.gitlab.cycle(); assert.equal(reader.count(), 0); assert.equal(f.received.length, 0);
});
test('R03: a paused link is reconciled even when its provider next poll is far in the future', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one'); await f.gitlab.cycle();
  f.gitlab.db.exec('UPDATE subscriptions SET next_at=9999999999999; UPDATE source_lifecycle SET checked_at=0');
  f.changeRoom('one', true); await f.gitlab.cycle(undefined, true);
  assert.equal(f.links.get('one:' + link.id).observed, 'paused'); assert.equal(reader.count(), 2);
  f.reopen(); await f.gitlab.cycle(); assert.equal(reader.count(), 2);
  f.changeRoom('one', false, true); await f.gitlab.cycle(); assert.equal(reader.count(), 4);
});
test('R03: archive and explicit resume both race the rejected send; the resume is not lost', async t => {
  const f = await setup(t); await f.gitlab.follow(url, 'one'); const sub = f.gitlab.subscriptions()[0]!;
  f.gitlab.apply(sub, snapshot());
  f.hooks.beforeSend = () => f.changeRoom('one', true);
  f.hooks.afterArchiveReply = () => f.changeRoom('one', false, true);
  await f.gitlab.deliver(); assert.equal(f.received.length, 0);
  await f.gitlab.lifecycle.sync(sub); await f.gitlab.deliver(); assert.equal(f.received.length, 1);
  assert.equal(f.gitlab.db.prepare('SELECT COUNT(*) n FROM events').get()!.n, 1);
});
test('R03: failed pause report is retried after restart; enabled manual stop does not become a start', async t => {
  const reader = inventedReader(), f = await setup(t, reader.runner);
  const link = await f.gitlab.follow(url, 'one'); f.changeRoom('one', true); f.hooks.failReports = 503;
  await f.gitlab.cycle(); assert.equal(reader.count(), 0);
  assert.equal(f.links.get('one:' + link.id).observed, 'pending');
  assert.equal(f.gitlab.lifecycle.state(link.id)!.applied, 'failed');
  f.reopen(); f.hooks.failReports = 0; await f.gitlab.cycle();
  assert.equal(f.links.get('one:' + link.id).observed, 'paused');
  f.gitlab.desired(false); f.changeRoom('one', false, true); await f.gitlab.reportStopped();
  assert.equal(f.links.get('one:' + link.id).observed, 'failed');
  assert.match(f.links.get('one:' + link.id).detail, /explicitly stopped/);
  assert.equal(f.gitlab.subscriptions()[0]!.enabled, 1); assert.equal(f.gitlab.desired(), false);
  assert.equal(f.gitlab.isRunning(), false); assert.equal(reader.count(), 0);
});
