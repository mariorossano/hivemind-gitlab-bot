import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { GitLabBot, init } from '../src/runtime.ts';

// Opt-in integration test: no production dependency on a sibling checkout.
// Only imports source code; never opens that checkout's profiles or server.
const source = process.env.HIVEMIND_TEST_SOURCE;
test('R03 integration: real Hivemind HTTP API, versioned archive/resume, persisted gitlab and deduplicated bot events',
  { skip: !source, timeout: 30000 }, async t => {
    const { Hive } = await import(pathToFileURL(path.join(source!, 'src/server/hive.ts')).href);
    const { createApp } = await import(pathToFileURL(path.join(source!, 'src/server/app.ts')).href);
    const { LocalHumanAuth } = await import(pathToFileURL(path.join(source!, 'src/server/local-auth.ts')).href);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gitlab-r03-core-'));
    const hive = new Hive(path.join(directory, 'hive.db'));
    const app = createApp(hive);
    const auth = new LocalHumanAuth();
    let beforeMessage: (() => void) | undefined;
    const server = createServer(async (req, res) => {
      if (!auth.handleHttp(req, res)) return;
      try {
        let body = ''; for await (const chunk of req) body += chunk;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        if (req.url?.endsWith('/messages')) { const hook = beforeMessage; beforeMessage = undefined; hook?.(); }
        const response = await app.fetch(new Request('http://' + req.headers.host + req.url, {
          method: req.method, headers, ...(body ? { body } : {}),
        }));
        res.statusCode = response.status; response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.statusCode = 500; res.end('{}'); }
    });
    let gitlab: GitLabBot | undefined;
    t.after(async () => {
      gitlab?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      hive.db.close(); rmSync(directory, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const {identity,channels}=hive;
    const human = identity.getAgent('human');
    const project = hive.projects.createProject(human, { name: 'GitLab fixture', slug: 'gitlab-fixture' });
    const brain = identity.join({ role: 'brain', project: project.slug }).agent;
    const channel = channels.createChannel(brain, { name: 'synthetic-mr', type: 'private', memberNames: [] });
    let request = 0;
    const room = (action: unknown) => hive.rooms.event(human, channel.id, {
      requestId: 'fixture-' + ++request, expectedRevision: hive.rooms.peek(channel.id)?.revision ?? 0, action,
    });
    const simple=typeof hive.rooms.view(human,channel.id).archived==='boolean';
    const reopen=(reason:string)=>({type:'reopen',reason,...(simple?{}:{resumeSources:true})});
    room({ type: 'configure', reason: 'Synthetic GitLab integration', contract: simple ? {
      instructions:'Observe invented MR. Fixture only. No provider connection. Human ends fixture.',
      coordinator:brain.name,participants:[],
    } : {
      mode: 'ongoing', purpose: 'Observe invented MR', rules: ['Fixture only'], limits: ['No provider connection'],
      coordinator: brain.name, participants: [], completion: ['Human ends fixture'], originTaskId: null,
    } });
    const home = path.join(directory, 'gitlab');
    init(home, { hiveUrl: 'http://127.0.0.1:' + (server.address() as any).port, host: 'gitlab.example.invalid' });
    const url = 'https://gitlab.example.invalid/demo/repo/-/merge_requests/7';
    let reads = 0;
    const runner = async () => { reads++; throw new Error('This scenario must not invoke a provider'); };
    gitlab = new GitLabBot(home, runner);
    const follow = await gitlab.follow(url, channel.id); const sub = gitlab.subscriptions()[0]!;
    assert.equal(hive.rooms.view(human, channel.id).links[0].id, follow.id);
    gitlab.apply(sub, { observations: [{ key: 'one', value: 1, body: 'Synthetic observation', url }] });
    const original = gitlab.db.prepare('SELECT event FROM events').get()!.event;
    room({ type: 'archive', reason: 'Pause synthetic source' });
    await gitlab.cycle(); assert.equal(reads, 0);
    assert.equal(hive.rooms.view(human, channel.id).links[0].observed, 'paused');
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n, 0);
    gitlab.close(); gitlab = new GitLabBot(home, runner);
    if(!simple) {
      room({ type: 'reopen', resumeSources: false, reason: 'Room only' });
      await gitlab.cycle(); assert.equal(reads, 0);
      room({ type: 'archive', reason: 'Prepare explicit source resume' });
    }
    room(reopen('Explicit source resume'));
    await gitlab.deliver(); await gitlab.deliver();
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n, 1);
    assert.equal(gitlab.db.prepare('SELECT event FROM events').get()!.event, original);
    assert.equal(gitlab.db.prepare('SELECT state FROM events').get()!.state, 'sent');
    assert.equal(hive.rooms.view(human, channel.id).links[0].observed, 'running');
    gitlab.apply(sub, { observations: [{ key: 'one', value: 2, body: 'Second synthetic observation', url }] });
    beforeMessage = () => room({ type: 'archive', reason: 'Archive racing delivery' });
    await gitlab.deliver();
    assert.equal(gitlab.db.prepare('SELECT state FROM events WHERE id=2').get()!.state, 'paused');
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n, 1);
    room(reopen('Resume raced event'));
    await gitlab.lifecycle.sync(sub); await gitlab.deliver();
    assert.equal(hive.db.prepare('SELECT COUNT(*) n FROM bot_events').get().n, 2);
    gitlab.unfollow(sub.id); await gitlab.reportStopped();
    assert.equal(hive.rooms.view(human, channel.id).links[0].observed, 'failed');
    assert.match(hive.rooms.view(human, channel.id).links[0].detail, /unfollowed/);
    assert.equal(gitlab.isRunning(), false); assert.equal(reads, 0);
  });
