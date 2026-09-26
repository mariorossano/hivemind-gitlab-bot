import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js',
  bundle: true, format: 'esm', platform: 'node', target: 'node22.13',
  packages: 'external', logLevel: 'warning',
});
