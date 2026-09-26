#!/usr/bin/env node
import { existsSync } from 'node:fs';
// Installed before loading TypeScript or initializing SQLite: an abandoned
// startup must never turn into a daemon after its invoking process has gone.
if (process.argv.includes('--managed-start')) {
  if (!process.send || !process.connected) throw new Error('Managed startup requires its parent IPC connection');
  const abandon = () => process.exit(1);
  const commit = value => {
    if (value !== 'gitlab-monitor-commit') return;
    process.off('disconnect', abandon); process.off('message', commit);
  };
  process.once('disconnect', abandon); process.on('message', commit);
}
const source = new URL('../src/cli.ts', import.meta.url);
const compiled = new URL('../dist/cli.js', import.meta.url);
// Match the core launcher: stale build artifacts must not shadow checkout edits.
// Installed packages have no source or tsx dependency and use compiled code.
if (existsSync(compiled) && (!existsSync(source) || process.env.HIVEMIND_FROM_DIST === '1')) {
  await import('../dist/cli.js');
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/cli.ts');
}
