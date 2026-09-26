import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { assertProject, configureProfile } from './profile.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema, definitionId, label, usageNotice, parseSource, read, type Config } from './provider.ts';
import { runCommand, type Runner } from './readers/process.ts';
import { excerpt, type Snapshot } from './readers/config.ts';
import { SourceLifecycle, LifecycleDeferred, HiveHttpError, archiveError } from './lifecycle.ts';
import { RepositoryWatch } from './watch.ts';
import { categories, eventTypes } from './watch-reader.ts';
import { LocalHiveSession, hiveOrigin } from './hive-session.ts';
import { launchMonitor, acceptMonitorStart } from './monitor-startup.ts';
export { hiveOrigin } from './hive-session.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subscription = { id: string; url: string; channel: string; bot: string; enabled: number; initialized: number; initial: string; next_at: number; failures: number; source_kind: string; event_filter: string|null; observed_after:number|null };
type Bot = { id: string; name: string; token: string };
export function privateJson(file: string, value: unknown) {
  writeFileSync(file + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file + '.next', 0o600); renameSync(file + '.next', file);
}
export function init(home: string, input: unknown) {
  const config = configSchema.parse(input); config.hiveUrl = hiveOrigin(config.hiveUrl);
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  const file = path.join(home, 'config.json');
  let existing: string | undefined;
  try { existing = readFileSync(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (hash(JSON.parse(existing)) !== hash(config)) throw new Error('Profile already configured; choose a new --home for a different configuration');
  } else privateJson(file, config);
  return { configured: true, home, definitionId };
}
function brief(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError') return 'Provider response did not match the expected schema';
  return error instanceof Error ? error.message.slice(0, 240) : 'Operation failed';
}
export class GitLabBot {
  readonly config: Config;
  readonly db: DatabaseSync;
  readonly lifecycle: SourceLifecycle;
  readonly watch: RepositoryWatch;
  readonly #session: LocalHiveSession;
  constructor(readonly home: string, readonly runner: Runner = runCommand) {
    this.config = configSchema.parse(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')));
    this.config.hiveUrl = hiveOrigin(this.config.hiveUrl);
    this.#session = new LocalHiveSession(this.config.hiveUrl);
    this.db = new DatabaseSync(path.join(home, 'state.db'));
    chmodSync(path.join(home, 'state.db'), 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bots(project TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL,token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL,channel TEXT NOT NULL,bot TEXT NOT NULL,enabled INTEGER NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,initial TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_poll INTEGER,last_queued INTEGER,usage TEXT,warnings TEXT,UNIQUE(url,channel)); CREATE TABLE IF NOT EXISTS items(subscription TEXT NOT NULL,item TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(subscription,item)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,subscription TEXT NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL DEFAULT "pending",attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,messageid TEXT);'.replace('"pending"', "'pending'"));
    const identity = hash([definitionId, this.config.hiveUrl, this.config.host]);
    const saved = this.db.prepare('SELECT value FROM meta WHERE key=?').get('identity') as any;
    if (saved && saved.value !== identity) { this.close(); throw new Error('Profile belongs to a different Hivemind/provider host; use a new --home'); }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('identity', identity);
    this.lifecycle = new SourceLifecycle(this.db, (...args) => this.request(...args), label);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cols=this.db.prepare('PRAGMA table_info(subscriptions)').all();
      if(!cols.some(c=>c.name==='source_kind'))this.db.exec("ALTER TABLE subscriptions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'mr'");
      if(!cols.some(c=>c.name==='event_filter'))this.db.exec('ALTER TABLE subscriptions ADD COLUMN event_filter TEXT');
      if(!cols.some(c=>c.name==='observed_after'))this.db.exec('ALTER TABLE subscriptions ADD COLUMN observed_after INTEGER');
      if(!this.db.prepare('PRAGMA table_info(items)').all().some(c=>c.name==='value'))this.db.exec('ALTER TABLE items ADD COLUMN value TEXT');
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
    this.watch = new RepositoryWatch(this);
  }
  close() { this.db.close(); }
  async request(route: string, options: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    for(let attempt=0;;attempt++) {
      const response = await this.#session.request(route, options, signal);
      if (!response.ok) {
        // Only the bot protocol's explicit admission throttle is retried here, never an approval denial.
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        if(response.status===429 && route.startsWith('/api/bot/') && attempt<2) {
          const seconds=Number(response.headers.get('Retry-After')??1);
          await delay(Math.min(10,Math.max(1,Number.isFinite(seconds)?seconds:1))*1000,undefined,{signal});
          continue; // Same URL/body/event ID; archive and generation fences still apply on the server.
        }
        throw new HiveHttpError(response.status, response.status === 409 && body?.error === archiveError);
      }
      return response.json();
    }
  }
  async follow(input: string, channelRef: string, initial = 'snapshot') {
    if (!['snapshot', 'baseline'].includes(initial)) throw new Error('Initial mode must be snapshot or baseline');
    const source = parseSource(input, this.config);
    return this.link(source.url,channelRef,initial,'mr');
  }
  async link(sourceUrl:string, channelRef:string, initial:string, kind:'mr'|'watch') {
    const snapshot = await this.request('/api/ui/snapshot');
    const channels = snapshot.channels.filter((c: any) => c.id === channelRef || c.name === channelRef);
    if (channels.length !== 1 || !['public', 'private'].includes(channels[0].type)) throw new Error('Choose one exact public/private channel ID (or a unique name)');
    const channel = channels[0];
    assertProject(this.home,channel.projectId,this.config.hiveUrl);
    let bot = this.db.prepare('SELECT id,name,token FROM bots WHERE project=?').get(channel.projectId) as Bot | undefined;
    const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (bot) {
      const current = snapshot.agents.find((a: any) => a.id === bot!.id && a.role === 'bot');
      if (!current) throw new Error('Saved bot is unavailable; use a fresh bot profile');
      if (current.name !== bot.name) {
        this.db.prepare('UPDATE bots SET name=? WHERE id=?').run(current.name, bot.id);
        bot.name = current.name;
      }
      if (!channel.memberIds.includes(bot.id)) await this.request('/api/ui/channels/' + encodeURIComponent(channel.id) + '/invite', post({ names: [bot.name] }));
    } else {
      const names = new Set(snapshot.agents.map((a: any) => String(a.name).toLowerCase()));
      let name = label;
      for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = label + '-' + suffix;
      const created = await this.request('/api/ui/projects/' + encodeURIComponent(channel.projectId) + '/bots', post({ name }));
      if (created.bot?.role !== 'bot' || typeof created.token !== 'string' || !created.token) throw new Error('Invalid bot registration receipt');
      bot = { id: created.bot.id, name: created.bot.name, token: created.token };
      this.db.prepare('INSERT INTO bots VALUES (?,?,?,?)').run(channel.projectId, bot.id, bot.name, bot.token);
      // Save the identity before inviting: a failed invitation reuses this bot on retry.
      await this.request('/api/ui/channels/' + encodeURIComponent(channel.id) + '/invite', post({ names: [bot.name] }));
    }
    const id = hash([sourceUrl, channel.id]).slice(0, 24);
    this.db.prepare('INSERT INTO subscriptions(id,url,channel,bot,enabled,initial,source_kind) VALUES (?,?,?,?,1,?,?) ON CONFLICT(url,channel) DO UPDATE SET next_at=CASE WHEN subscriptions.enabled=0 THEN 0 ELSE subscriptions.next_at END,enabled=1').run(id, sourceUrl, channel.id, bot.id, initial,kind);
    await this.lifecycle.sync(this.subscriptions().find(s => s.id === id)!, undefined, false);
    return { id, source: sourceUrl, channel: channel.id, bot: bot.name, state: 'following' };
  }
  unfollow(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('UPDATE subscriptions SET enabled=0 WHERE id=?').run(id).changes) throw new Error('Unknown subscription');
      this.db.prepare('UPDATE repository_watch SET enabled=0 WHERE subscription=?').run(id);
      this.db.prepare("UPDATE events SET state='cancelled' WHERE subscription=? AND state IN ('pending','blocked','paused')").run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, state: 'stopped' };
  }
  subscriptions() { return this.db.prepare('SELECT * FROM subscriptions ORDER BY id').all() as unknown as Subscription[]; }
  status() {
    return { definitionId, home: this.home, monitorRunning: this.isRunning(), watch:this.watch.status(), subscriptions: this.db.prepare('SELECT id,url,channel,enabled,source_kind,event_filter,last_poll,last_queued,last_error,failures,next_at,usage,warnings FROM subscriptions ORDER BY id').all(), lifecycle: this.db.prepare('SELECT * FROM source_lifecycle ORDER BY subscription').all(), events: this.db.prepare('SELECT state,COUNT(*) AS count FROM events GROUP BY state').all(), deliveryErrors: this.db.prepare('SELECT id,subscription,state,error,attempts,next_at,pause_generation FROM events WHERE error IS NOT NULL ORDER BY id LIMIT 50').all() };
  }
  apply(sub: Subscription, snapshot: Snapshot, generation?: number) {
    this.db.exec('BEGIN IMMEDIATE'); let queued = 0;
    try {
      const current = this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(sub.id) as unknown as Subscription;
      const state = this.lifecycle.state(sub.id);
      if (!current.enabled || state?.desired === 'paused' || (generation !== undefined &&
          (state?.generation !== generation || state?.applied !== 'running'))) { this.db.exec('ROLLBACK'); return 0; }
      const keys = new Set<string>();
      for (const observation of snapshot.observations) {
        if (keys.has(observation.key)) throw new Error('Duplicate observation key in provider snapshot');
        keys.add(observation.key);
        const previous = this.db.prepare('SELECT hash,revision,value FROM items WHERE subscription=? AND item=?').get(sub.id, observation.key) as any;
        // Resource-label history entries are events, not mutable snapshots. A renamed/deleted label
        // must not replay its old add/remove event with another revision.
        if(previous && observation.key.startsWith('label-event:'))continue;
        const fingerprint = hash(observation.value);
        if (previous?.hash === fingerprint) continue;
        const revision = (previous?.revision ?? 0) + 1;
        const origin = new URL(observation.url);
        if (origin.protocol !== 'https:' || origin.host !== this.config.host || origin.username || origin.password) throw new Error('Provider returned an unexpected origin');
        const allowed:string[]|null=current.event_filter?JSON.parse(current.event_filter):null;
        const value=observation.value as any;
        const duringSetup=!current.initialized && !!current.event_filter && current.observed_after!==null &&
          (observation.occurredAt ?? 0)>=current.observed_after && (observation.key.startsWith('note:') || observation.key.startsWith('label-event:'));
        let kinds=categories(observation.key,value,previous?.value?JSON.parse(previous.value):undefined);
        if(duringSetup && observation.key.startsWith('note:') && (value.createdAt ?? 0)<current.observed_after!)kinds=['comment_edit','discussion'];
        // Label event history is authoritative when requested; avoid duplicating a label-only MR snapshot change.
        if(observation.key==='mr' && allowed?.includes('label'))kinds=kinds.filter(k=>k!=='label');
        const selected=!allowed || kinds.some(c=>allowed.includes(c));
        if ((current.initialized || current.initial === 'snapshot' || duringSetup) && selected) {
          const event = { eventId: definitionId + ':' + sub.id + ':' + hash(observation.key).slice(0, 24) + ':' + revision, body: excerpt(observation.body, 3900), origin: { label, url: observation.url, ...(observation.author ? { author: observation.author.slice(0, 200) } : {}), ...(observation.occurredAt ? { occurredAt: observation.occurredAt } : {}) } };
          this.db.prepare('INSERT INTO events(subscription,event) VALUES (?,?)').run(sub.id, JSON.stringify(event)); queued++;
        }
        this.db.prepare('INSERT INTO items(subscription,item,hash,revision,value) VALUES (?,?,?,?,?) ON CONFLICT(subscription,item) DO UPDATE SET hash=excluded.hash,revision=excluded.revision,value=excluded.value').run(sub.id, observation.key, fingerprint, revision,JSON.stringify(observation.value));
      }
      this.db.prepare('UPDATE subscriptions SET initialized=1,last_poll=?,last_queued=?,next_at=?,failures=0,last_error=NULL,usage=?,warnings=? WHERE id=?').run(Date.now(), queued, Date.now() + this.config.intervalSeconds * 1000, JSON.stringify(snapshot.usage ?? null), JSON.stringify(snapshot.warnings ?? []), sub.id);
      this.db.exec('COMMIT'); return queued;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async cycle(id?: string, dueOnly = false, signal?: AbortSignal, limit = Infinity) {
    const discovery=!id || id===this.watch.current()?.subscription?await this.watch.cycle(dueOnly,signal):undefined;
    const subs = this.subscriptions().filter(s => !id || s.id === id);
    if (id && !subs.some(s => s.enabled)) throw new Error('Unknown or disabled subscription');
    const reads = new Map<string, Snapshot>();
    const results: any[] = discovery?[discovery]:[];
    let identity:Promise<void>|undefined;
    for (const sub of subs) {
      if (signal?.aborted) break;
      try {
        if(sub.source_kind==='watch')continue;
        const previous = this.lifecycle.state(sub.id);
        if (!sub.enabled && !previous) continue;
        // Check paused/non-due links too, but do not poll the control plane every second.
        if (dueOnly && previous && Date.now() - Number(previous.checked_at) < 5000 &&
            (!sub.enabled || previous.applied !== 'running' || sub.next_at > Date.now())) continue;
        const state = await this.lifecycle.sync(sub, signal);
        const current = this.subscriptions().find(s => s.id === sub.id)!;
        if (!state.running || (dueOnly && current.next_at > Date.now()) || results.length >= limit) continue;
        const guard = async () => {
          const latest = await this.lifecycle.sync(sub, signal);
          signal?.throwIfAborted();
          if (!latest.running || latest.generation !== state.generation) throw new LifecycleDeferred('Source lifecycle changed; snapshot deferred');
        };
        const readKey=JSON.stringify([sub.url,sub.event_filter]);
        let snapshot = previous?.desired === 'paused' ? undefined : reads.get(readKey);
        if (!snapshot) {
          if(sub.event_filter)await (identity ??= this.watch.checkIdentity(guard,signal));
          snapshot = await read(sub.url, this.config, this.home, async request => {
            await guard(); return this.runner(request);
          }, signal,sub.event_filter?JSON.parse(sub.event_filter):undefined);
          reads.set(readKey, snapshot);
        }
        await guard();
        signal?.throwIfAborted();
        results.push({ id: sub.id, observed: snapshot.observations.length, queued: this.apply(sub, snapshot, state.generation) });
      } catch (error) {
        if (signal?.aborted) break;
        reads.delete(JSON.stringify([sub.url,sub.event_filter]));
        if (error instanceof LifecycleDeferred) { results.push({ id: sub.id, deferred: true }); continue; }
        const message = brief(error);
        if (this.lifecycle.state(sub.id)?.applied !== 'failed') {
          const backoff = Math.min(86400000, this.config.intervalSeconds * 1000 * 2 ** Math.min(sub.failures, 8));
          this.db.prepare('UPDATE subscriptions SET failures=failures+1,last_error=?,next_at=? WHERE id=?').run(message, Date.now() + backoff, sub.id);
        }
        results.push({ id: sub.id, error: message });
      }
    }
    await this.deliver(signal); return results;
  }
  async deliver(signal?: AbortSignal) {
    const jobs = this.db.prepare("SELECT e.* FROM events e JOIN subscriptions s ON s.id=e.subscription WHERE s.enabled=1 AND e.state='pending' AND e.next_at<=? ORDER BY e.id LIMIT 200").all(Date.now()) as any[];
    for (const job of jobs) {
      if (signal?.aborted) break;
      if (this.db.prepare("SELECT 1 FROM events WHERE subscription=? AND id<? AND state IN ('pending','blocked','paused') LIMIT 1").get(job.subscription, job.id)) continue;
      const sub = this.db.prepare('SELECT * FROM subscriptions WHERE id=? AND enabled=1').get(job.subscription) as unknown as Subscription | undefined;
      if (!sub) continue;
      // A lifecycle failure holds the outbox; it is not a failed message delivery.
      try { if (!(await this.lifecycle.sync(sub, signal)).running) continue; }
      catch { continue; }
      signal?.throwIfAborted();
      if (!this.db.prepare("SELECT 1 FROM events e JOIN subscriptions s ON s.id=e.subscription WHERE e.id=? AND e.state='pending' AND s.enabled=1").get(job.id)) continue;
      const bot = this.db.prepare('SELECT * FROM bots WHERE id=?').get(sub.bot) as Bot;
      const event = JSON.parse(job.event);
      try {
        const receipt = await this.request('/api/bot/channels/' + encodeURIComponent(sub.channel) + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bot.token }, body: job.event }, signal);
        if (receipt.message?.channelId !== sub.channel || receipt.message?.authorId !== bot.id || receipt.message?.authorRole !== 'bot' || receipt.message?.botEvent?.eventId !== event.eventId) throw new Error('Invalid bot message receipt');
        this.db.prepare("UPDATE events SET state='sent',messageid=?,error=NULL WHERE id=?").run(receipt.message.id, job.id);
      } catch (error) {
        if (signal?.aborted) break;
        const message = brief(error);
        if (error instanceof HiveHttpError && error.archived) {
          // A known archive rejection did not commit. Re-read its versioned command.
          // If archive/reopen already advanced the generation, honor that explicit resume.
          const before = Number(this.lifecycle.state(sub.id)?.generation ?? 0);
          let generation = before + 1;
          try {
            const state = await this.lifecycle.sync(sub, signal);
            generation = state.desired === 'running' && state.generation > before ? state.generation - 1 : state.generation;
          } catch { /* preserve the event; retry the control plane next cycle */ }
          this.db.prepare("UPDATE events SET state='paused',pause_generation=?,attempts=attempts+1,error='Archived channel; awaiting explicit source resume' WHERE id=? AND state='pending'").run(generation, job.id);
          continue;
        }
        const status = /^Hivemind HTTP ([0-9]{3})$/.exec(message);
        const blocked = status && Number(status[1]) >= 400 && Number(status[1]) < 500 && !['408', '429'].includes(status[1]!);
        this.db.prepare('UPDATE events SET state=?,attempts=attempts+1,next_at=?,error=? WHERE id=?').run(blocked ? 'blocked' : 'pending', Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)), message, job.id);
      }
    }
  }
  async reportStopped(id?: string) {
    for (const sub of this.subscriptions().filter(s => (!id || s.id === id) && this.lifecycle.state(s.id))) {
      try { await this.lifecycle.sync(sub, undefined, true, true); }
      catch { /* status keeps the failed acknowledgement; never start a monitor here */ }
    }
  }
  lock(name = 'monitor') {
    const file = path.join(this.home, name + '.lock.db');
    const db = new DatabaseSync(file); chmodSync(file, 0o600);
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch (error) { db.close(); throw error; }
    return () => { db.exec('ROLLBACK'); db.close(); };
  }
  isRunning() {
    try { const unlock = this.lock(); unlock(); return false; }
    catch (error: any) { if (error.errcode === 5 || String(error.message).includes('database is locked')) return true; throw error; }
  }
  desired(value?: boolean) {
    if (value !== undefined) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('desired', value ? '1' : '0');
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get('desired') as any)?.value === '1';
  }
  async start() {
    // A stopping daemon keeps the lock while reporting its final source state.
    // Its abort signal cannot be undone by setting desired=true again.
    // Serialize startup with other starts and profile/identity changes, including
    // the interval before the child has loaded enough to acquire its monitor lock.
    const release = this.lock('setup');
    try {
      if (this.isRunning()) {
        if (!this.desired()) throw new Error('Monitor is stopping; wait until it is offline before starting');
        return;
      }
      this.desired(true);
      let log: number | undefined;
      try {
        const file = path.join(this.home, 'monitor.log');
        log = openSync(file, 'a', 0o600); chmodSync(file, 0o600);
        await launchMonitor(path.join(root, 'bin/hivemind-gitlab.mjs'), this.home, log, () => this.desired());
      } catch (error) { this.desired(false); throw error; }
      finally { if (log !== undefined) closeSync(log); }
    } finally { release(); }
  }
}

export async function main(args: string[]) {
  process.umask(0o077);
  const options = Object.fromEntries(['home', 'hive-url', 'host', 'executable', 'cwd', 'launch-mode', 'launcher', 'tool-name', 'model', 'effort', 'interval', 'max-pages', 'timeout', 'channel', 'initial', 'id', 'event-id', 'reason', 'max-polls', 'brain', 'label', 'authors', 'exclude-authors', 'events'].map(k => [k, { type: 'string' as const }]));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { ...options, help: { type: 'boolean' }, 'no-start': { type: 'boolean' }, 'confirm-archive': { type: 'boolean' }, 'managed-start': { type: 'boolean' } } });
  const command = positionals[0];
  const managedStart = values['managed-start'] === true;
  if (managedStart && (command !== 'run' || !process.send || !process.connected)) throw new Error('Managed startup requires its parent IPC connection');
  const value = (key: string) => (values as Record<string, unknown>)[key] as string | undefined;
  const home = path.resolve(value('home') ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), definitionId));
  if (!command || command === 'help' || values.help) {
    console.log(definitionId + '\n  init --hive-url http://127.0.0.1:PORT --host PROVIDER_HOST [provider options]\n  follow URL --channel ID [--initial snapshot|baseline] [--no-start]\n  watch REPOSITORY_URL --channel SUMMARY_CHANNEL --brain NAME [--label EXACT_LABEL] [--authors all|me|USER1,USER2] [--exclude-authors me|USER1,USER2] [--events all|'+eventTypes.join(',')+'] [--initial summary|follow] [--no-start]\n  stop-watch | resume-watch | take-existing --id WATCH_ID\n  list | status | unfollow --id ID\n  start | stop | run [--max-polls N] | poll [--id ID]\n  recover-archived --id SUB --event-id EVENT --confirm-archive --reason EVIDENCE\n  instructions\nEvery command accepts --home /absolute/profile. Follow/watch start polling unless --no-start. No reviews or source writes are assigned. ' + usageNotice); return;
  }
  if (command === 'instructions') { console.log(readFileSync(path.join(root, 'BOT-TOOLS.md'), 'utf8')); return; }
  if (command === 'invoke') {
    if (positionals.length !== 1) throw new Error('invoke accepts a JSON request on stdin only');
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new Error('Request too large'); }
    const { invoke } = await import('./bot-interface.ts');
    console.log(JSON.stringify(await invoke(home, JSON.parse(raw))));
    return;
  }
  if (command === 'configure') {
    if(positionals.length!==1)throw new Error('configure accepts settings on stdin only');
    let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>65536)throw new Error('Configuration too large');}
    try {console.log(JSON.stringify(configureProfile(home,JSON.parse(raw))));}
    catch(error) {console.log(JSON.stringify({configured:false,error:error instanceof Error&&error.name!=='ZodError'?error.message.slice(0,300):'Invalid bot settings; check the declared fields and values'}));process.exitCode=1;}
    return;
  }
  if (command === 'init') {
    const config: Record<string, unknown> = {};
    for (const [flag, key] of Object.entries({ 'hive-url': 'hiveUrl', host: 'host', executable: 'executable', cwd: 'cwd', 'launch-mode': 'launchMode', launcher: 'launcher', 'tool-name': 'toolName', model: 'model', effort: 'effort' })) if (value(flag)) config[key] = value(flag);
    for (const [flag, key] of Object.entries({ interval: 'intervalSeconds', 'max-pages': 'maxPages', timeout: 'timeoutSeconds' })) if (value(flag)) config[key] = Number(value(flag));
    console.log(JSON.stringify(init(home, config))); return;
  }
  if (!['follow', 'watch', 'stop-watch', 'resume-watch', 'take-existing', 'list', 'status', 'unfollow', 'start', 'stop', 'poll', 'run', 'recover-archived'].includes(command)) throw new Error('Unknown bot command');
  if(command!=='watch' && ['brain','label','authors','exclude-authors','events'].some(k=>value(k)!==undefined))throw new Error('Repository selection flags apply to watch only, not follow');
  if (positionals.length !== (['follow','watch'].includes(command) ? 2 : 1)) throw new Error('Unexpected or missing positional arguments');
  const gitlab = new GitLabBot(home);
  try {
    if (command === 'status' || command === 'list') { console.log(JSON.stringify(gitlab.status(), null, 2)); return; }
    if(['stop-watch','resume-watch','take-existing'].includes(command)) {
      const id=value('id');if(!id)throw new Error('Supply the exact watch --id');
      const release=gitlab.lock('setup');
      try {console.log(JSON.stringify(command==='take-existing'?gitlab.watch.takeExisting(id):await gitlab.watch.setEnabled(id,command==='resume-watch')));}
      finally{release();}return;
    }
    if(command==='watch') {
      const release=gitlab.lock('setup');let hold=()=>{};let configured;
      try {
        if(values['no-start'])hold=gitlab.lock();
        const list=(key:string,fallback:string[])=>value(key)===undefined?fallback:value(key)!.split(',').map(s=>s.trim());
        configured=await gitlab.watch.configure({repository:positionals[1],channel:value('channel'),brain:value('brain'),
          ...(value('label')!==undefined?{label:value('label')}:{}),authors:list('authors',['all']),excludeAuthors:list('exclude-authors',[]),
          events:value('events')==='all'?[...eventTypes]:list('events',[...eventTypes]),initial:value('initial')??'summary'});
      } finally {hold();release();}
      if(!values['no-start'])await gitlab.start();
      console.log(JSON.stringify({...configured,monitorRunning:gitlab.isRunning()}));return;
    }
    if (command === 'recover-archived') {
      const sub = gitlab.subscriptions().find(s => s.id === value('id'));
      const eventId = Number(value('event-id'));
      if (!sub || !Number.isSafeInteger(eventId) || eventId <= 0 || !values['confirm-archive'] || !value('reason'))
        throw new Error('Supply --id SUB --event-id EVENT --confirm-archive --reason EVIDENCE; never use for an unexplained 409');
      const release = gitlab.lock('setup');
      let hold = () => {};
      try { hold = gitlab.lock(); console.log(JSON.stringify(await gitlab.lifecycle.recover(sub, eventId, value('reason')!))); }
      finally { hold(); release(); }
      return;
    }
    if (command === 'follow') {
      if (!value('channel')) throw new Error('Supply --channel ID');
      let result;
      let hold = () => {};
      const release = gitlab.lock('setup');
      try {
        if (values['no-start']) {
          try { hold = gitlab.lock(); } catch { throw new Error('Stop the monitor before follow --no-start; otherwise it could read the new source immediately'); }
        }
        result = await gitlab.follow(positionals[1]!, value('channel')!, value('initial'));
      } finally { hold(); release(); }
      if (!values['no-start']) await gitlab.start();
      console.log(JSON.stringify({ ...result, monitorRunning: gitlab.isRunning() })); return;
    }
    if (command === 'unfollow') { if (!value('id')) throw new Error('Supply --id ID'); const result = gitlab.unfollow(value('id')!); if (!gitlab.isRunning()) await gitlab.reportStopped(value('id')); console.log(JSON.stringify(result)); return; }
    if (command === 'start') { await gitlab.start(); console.log(JSON.stringify({ monitorRunning: true })); return; }
    if (command === 'stop') {
      gitlab.desired(false);
      for (let i = 0; i < 40 && gitlab.isRunning(); i++) await delay(100);
      if (!gitlab.isRunning()) await gitlab.reportStopped();
      console.log(JSON.stringify({ stopRequested: true, monitorRunning: gitlab.isRunning() })); return;
    }
    const max = value('max-polls') ? Number(value('max-polls')) : Infinity;
    if (value('max-polls') && (!Number.isSafeInteger(max) || max < 1)) throw new Error('--max-polls must be a positive integer');
    // Direct run/poll must not overtake a managed child still bootstrapping.
    // That child's parent already owns setup; it alone may acquire monitor now.
    const releaseSetup = managedStart ? undefined : gitlab.lock('setup');
    let release = () => {};
    try {
      release = gitlab.lock();
      if (command === 'run' && !managedStart) gitlab.desired(true);
      // A one-shot poll is not a daemon, even when stale intent survived a
      // previous crash. A concurrent Start must wait for it to release monitor.
      if (command === 'poll') gitlab.desired(false);
    } catch (error) { release(); throw error; }
    finally { releaseSetup?.(); }
    const controller = new AbortController();
    const stop = () => { gitlab.desired(false); controller.abort(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const timer = setInterval(() => { if (command === 'run' && !gitlab.desired()) controller.abort(); }, 250);
    try {
      if (managedStart) {
        await acceptMonitorStart(() => gitlab.desired() && !controller.signal.aborted);
        if (!gitlab.desired()) controller.abort();
      }
      if (command === 'poll') {
        const results = await gitlab.cycle(value('id'), false, controller.signal);
        console.log(JSON.stringify(results));
        if (results.some(r => r.error) || gitlab.db.prepare("SELECT 1 FROM events WHERE state IN ('pending','blocked') LIMIT 1").get()) process.exitCode = 2;
        return;
      }
      let polls = 0;
      while (!controller.signal.aborted && polls < max) {
        const results = await gitlab.cycle(undefined, true, controller.signal, max - polls); polls += results.length;
        if (results.length) console.log(JSON.stringify(results));
        if (polls < max) await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    } finally { clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); await gitlab.reportStopped(); release(); }
  } finally { gitlab.close(); }
}
