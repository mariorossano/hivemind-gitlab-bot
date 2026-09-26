import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('GitLab launcher prefers checkout source over a stale build, with explicit compiled opt-in and installed-package fallback', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitlab-launcher-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['bin', 'src', 'dist']) mkdirSync(path.join(dir, folder));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(dir, 'node_modules'));
  const entry = path.join(dir, 'bin', 'hivemind-gitlab.mjs');
  copyFileSync(new URL('../bin/hivemind-gitlab.mjs', import.meta.url), entry);
  const source = path.join(dir, 'src', 'cli.ts');
  writeFileSync(source, "const value: string = 'source'; console.log(value);");
  writeFileSync(path.join(dir, 'dist', 'cli.js'), "console.log('compiled');");
  const run = (compiled = '0') => execFileSync(process.execPath, [entry], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, HIVEMIND_FROM_DIST: compiled },
  }).trim();
  assert.equal(run(), 'source');
  assert.equal(run('1'), 'compiled');
  unlinkSync(source);
  assert.equal(run(), 'compiled');
});
