import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');

test('launch instructions stay compact after scoped command expansion and ship with the full guide', () => {
  const manifest = JSON.parse(read('hivemind-bot.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.instructions, 'LAUNCH.md');
  const launch = read(manifest.instructions);
  for (const file of [manifest.instructions, 'BOT-TOOLS.md']) assert.ok(pkg.files.includes(file));
  assert.equal((launch.match(/\{\{command\}\}/g) ?? []).length, 1);
  assert.match(launch, /\{\{command\}\} instructions/);
  const command = `'/opt/${'x'.repeat(140)}/bin/bot.mjs' --home '/var/${'y'.repeat(140)}/profile'`;
  const expanded = launch.replaceAll('{{command}}', command);
  assert.ok(Buffer.byteLength(expanded) <= 2700, `Launch grew to ${Buffer.byteLength(expanded)} bytes`);
  for (const rule of [/bot_tools/, /call_bot_tool/, /Before first use/, /not authorization/,
    /denied/, /Human/, /stopped monitor/, /another SHA/, /never expose tokens/]) assert.match(launch, rule);
  const guide = read('BOT-TOOLS.md');
  for (const detail of [/Exclusions override/, /initial: summary/, /resumeSources/,
    /immutable repository/, /nextOffset/, /stop_watch/]) assert.match(guide, detail);
});

test('instructions returns the full guide without creating or requiring a profile', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'gitlab-docs-'));
  const profile = path.join(scratch, 'unconfigured-profile');
  try {
    const guide = execFileSync(process.execPath,
      [path.join(root, 'bin/hivemind-gitlab.mjs'), '--home', profile, 'instructions'],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(guide.trim(), read('BOT-TOOLS.md').trim());
    assert.ok(!existsSync(profile), 'Documentation must not create a profile or monitor');
    mkdirSync(profile);
    const sentinel = 'invalid config: documentation must not open this';
    writeFileSync(path.join(profile, 'config.json'), sentinel);
    const existing = execFileSync(process.execPath,
      [path.join(root, 'bin/hivemind-gitlab.mjs'), '--home', profile, 'instructions'],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(existing.trim(), guide.trim());
    assert.equal(readFileSync(path.join(profile, 'config.json'), 'utf8'), sentinel);
    assert.deepEqual(readdirSync(profile), ['config.json']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
