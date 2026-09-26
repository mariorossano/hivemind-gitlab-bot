import { DatabaseSync } from 'node:sqlite';

const version = 1;
const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE bots(project TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL,token TEXT NOT NULL);
CREATE TABLE subscriptions(
  id TEXT PRIMARY KEY,url TEXT NOT NULL,channel TEXT NOT NULL,bot TEXT NOT NULL,enabled INTEGER NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0,initial TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_poll INTEGER,last_queued INTEGER,usage TEXT,warnings TEXT,
  source_kind TEXT NOT NULL DEFAULT 'mr',event_filter TEXT,observed_after INTEGER,UNIQUE(url,channel)
);
CREATE TABLE items(
  subscription TEXT NOT NULL,item TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT,
  PRIMARY KEY(subscription,item)
);
CREATE TABLE events(
  id INTEGER PRIMARY KEY,subscription TEXT NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,messageid TEXT,pause_generation INTEGER
);
CREATE UNIQUE INDEX event_identity ON events(json_extract(event,'$.eventId'));
CREATE TABLE source_lifecycle(
  subscription TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,desired TEXT NOT NULL DEFAULT 'unknown',
  applied TEXT NOT NULL DEFAULT 'pending',checked_at INTEGER NOT NULL DEFAULT 0,error TEXT
);
CREATE TABLE repository_watch(
  id TEXT PRIMARY KEY,spec TEXT NOT NULL,subscription TEXT NOT NULL,project INTEGER NOT NULL,account INTEGER NOT NULL,
  hive_project TEXT NOT NULL,brain TEXT NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL DEFAULT 0,
  watermark INTEGER NOT NULL DEFAULT 0,take_existing INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT
);
CREATE TABLE watch_seen(iid INTEGER PRIMARY KEY,matched INTEGER NOT NULL);
CREATE TABLE watch_label_events(id INTEGER PRIMARY KEY);
CREATE TABLE watch_jobs(url TEXT PRIMARY KEY,mr TEXT NOT NULL,detected_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
CREATE TABLE mr_routes(url TEXT PRIMARY KEY,name TEXT NOT NULL,topic TEXT NOT NULL,channel TEXT,subscription TEXT,origin TEXT NOT NULL DEFAULT 'discovery');
`;

function shape(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
}
const reference = (() => {
  const db = new DatabaseSync(':memory:');
  try { db.exec(schema); return JSON.stringify(shape(db)); }
  finally { db.close(); }
})();

/** Validate without changing a saved profile or interpreting its contents as a fresh database. */
export function assertStorage(db: DatabaseSync) {
  if (db.prepare('PRAGMA user_version').get()!.user_version !== version || JSON.stringify(shape(db)) !== reference)
    throw new Error('Unsupported bot profile schema; profile left unchanged. Use the matching bot build and do not delete its data.');
}

/** One schema only. Initialize an empty database atomically; never convert existing data. */
export function initializeStorage(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get()!.user_version === 0 && shape(db).length === 0) {
      db.exec(schema);
      db.exec(`PRAGMA user_version=${version}`);
    }
    assertStorage(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
