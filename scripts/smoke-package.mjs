import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const [archive, coreArchive] = process.argv.slice(2);
if (!archive) throw new Error('Usage: npm run test:package -- /absolute/bot.tgz [/absolute/hivemind.tgz]');
const dir = await mkdtemp(path.join(os.tmpdir(), 'gitlab-external-package-'));
const exec = promisify(execFile);
try {
  await exec('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--prefix', dir, path.resolve(archive), ...(coreArchive ? [path.resolve(coreArchive)] : [])], { timeout: 120000 });
  const root = path.join(dir, 'node_modules/hivemind-gitlab');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).license, 'Apache-2.0');
  assert.match(readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Apache License[\s\S]+Version 2\.0/);
  assert.match(readFileSync(path.join(root, 'NOTICE'), 'utf8'), /Copyright 2026 Mario Rossano/);
  assert.ok(existsSync(path.join(root, 'dist/cli.js')));
  assert.ok(!existsSync(path.join(root, 'src')), 'Bot package must not depend on source');
  assert.ok(!existsSync(path.join(dir, 'node_modules/tsx')), 'Installed bot must not require a TS loader');
  assert.ok(existsSync(path.join(root, 'hivemind-bot.json')));
  const entry = path.join(root, 'bin/hivemind-gitlab.mjs');
  assert.match((await exec(process.execPath, [entry, '--help'], { timeout: 5000 })).stdout, /hivemind-gitlab/);
  const profile = path.join(dir, 'profile');
  const command = async (...args) => JSON.parse((await exec(process.execPath, [entry, ...args, '--home', profile],
    { timeout: 25000, killSignal: 'SIGKILL' })).stdout);
  await command('init', '--hive-url', 'http://127.0.0.1:1', '--host', 'gitlab.example.invalid');
  try {
    assert.equal((await command('start')).monitorRunning, true);
    assert.equal((await command('status')).monitorRunning, true);
  } finally {
    assert.equal((await command('stop')).monitorRunning, false);
  }
  if (coreArchive) {
    const coreRoot = path.join(dir, 'node_modules/hivemind');
    assert.ok(!existsSync(path.join(coreRoot, 'bots/gitlab')), 'Core must not contain the bot');
    const hive = async (...args) => (await exec(process.execPath,
      [path.join(coreRoot, 'bin/hivemind.mjs'), 'bots', ...args, '--home', path.join(dir, 'hive')], { timeout: 5000 })).stdout;
    assert.deepEqual(JSON.parse(await hive('list')), []);
    assert.equal(JSON.parse(await hive('add', path.join(root, 'hivemind-bot.json'))).id, 'hivemind-gitlab');
    assert.deepEqual(JSON.parse(await hive('list')).map(item => item.id), ['hivemind-gitlab']);
    await hive('remove', 'hivemind-gitlab');
    assert.deepEqual(JSON.parse(await hive('list')), []);
    console.log('Independent core/bot packages: explicit registration and removal verified');
  }
  console.log('Standalone compiled GitLab package: startup, status and stop verified');
} finally {
  await rm(dir, { recursive: true, force: true });
}
