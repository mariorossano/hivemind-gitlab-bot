import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertStorage, initializeStorage } from '../src/storage.ts';
import { GitLabBot } from '../src/runtime.ts';
import { configureProfile } from '../src/profile.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gitlab-storage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const request = { projectId: 'fixture', config: { hiveUrl: 'http://127.0.0.1:1', host: 'gitlab.example.invalid' } };
  configureProfile(home, request);
  return { home, request, file: path.join(home, 'state.db') };
}

test('current schema initializes atomically and reopening preserves queued events, identities and routes', t => {
  const f = fixture(t);
  const bot = new GitLabBot(f.home);
  bot.db.prepare('INSERT INTO bots VALUES (?,?,?,?)').run('fixture', 'bot', 'Fixture', 'synthetic-only-token');
  bot.db.prepare('INSERT INTO events(subscription,event) VALUES (?,?)').run('sub', JSON.stringify({ eventId: 'fixture-event' }));
  bot.db.prepare('INSERT INTO mr_routes(url,name,topic,origin) VALUES (?,?,?,?)').run('https://gitlab.example.invalid/g/r/-/merge_requests/1', 'room', 'Fixture', 'existing');
  const snapshot = (db: DatabaseSync) => ['bots', 'events', 'mr_routes'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot(bot.db);
  bot.db.exec('VACUUM');
  bot.close();
  const reopened = new GitLabBot(f.home);
  try {
    assert.doesNotThrow(() => assertStorage(reopened.db));
    assert.deepEqual(snapshot(reopened.db), before);
    assert.equal(reopened.db.prepare("SELECT name FROM sqlite_schema WHERE name='archive_recoveries'").get(), undefined);
    assert.equal(reopened.db.prepare('PRAGMA table_info(source_lifecycle)').all().some(column => column.name === 'paused_generation'), false);
  } finally { reopened.close(); }
});

for (const variant of ['unversioned', 'future', 'missing-column', 'missing-index', 'unrelated'] as const) {
  test(`unsupported ${variant} database is rejected without changing data or configuration`, t => {
    const f = fixture(t);
    const db = new DatabaseSync(f.file);
    if (variant === 'unrelated') {
      db.exec('CREATE TABLE sqlitex_private(value TEXT); INSERT INTO sqlitex_private VALUES (\'fixture evidence\')');
    } else {
      initializeStorage(db);
      db.exec("INSERT INTO meta VALUES ('fixture','keep'); INSERT INTO events(subscription,event) VALUES ('sub','{\"eventId\":\"keep\"}')");
      if (variant === 'unversioned') db.exec('PRAGMA user_version=0');
      if (variant === 'future') db.exec('PRAGMA user_version=99');
      if (variant === 'missing-column') db.exec('ALTER TABLE mr_routes DROP COLUMN origin');
      if (variant === 'missing-index') db.exec('DROP INDEX event_identity');
    }
    db.close();
    const paths = [f.file, path.join(f.home, 'config.json'), path.join(f.home, 'hivemind-project.json')];
    const before = paths.map(file => readFileSync(file));
    assert.throws(() => new GitLabBot(f.home), /Unsupported bot profile schema/);
    assert.throws(() => configureProfile(f.home, { ...f.request, config: { ...f.request.config, intervalSeconds: 600 } }), /Unsupported bot profile schema/);
    paths.forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]));
    // A rejected open must not leak a connection or leave an initialization transaction pending.
    const check = new DatabaseSync(f.file);
    try { check.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK'); }
    finally { check.close(); }
  });
}

test('CLI rejects obsolete commands and flags before opening a profile', t => {
  const f = fixture(t);
  const entry = fileURLToPath(new URL('../bin/hivemind-gitlab.mjs', import.meta.url));
  const invalid = [ ['recover-archived'], ...['model', 'effort', 'cwd', 'launch-mode', 'launcher', 'tool-name', 'event-id', 'reason'].map(flag => ['init', '--' + flag, 'fixture']), ['status', '--confirm-archive'] ];
  const config = readFileSync(path.join(f.home, 'config.json'));
  for (const args of invalid) {
    const result = spawnSync(process.execPath, [entry, '--home', f.home, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /Unknown bot command|Unknown option/);
  }
  assert.deepEqual(readFileSync(path.join(f.home, 'config.json')), config);
  assert.throws(() => readFileSync(f.file), { code: 'ENOENT' });
});
