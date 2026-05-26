import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: '_wiredhowseSnippet',
  target: ['es2020', 'chrome80', 'firefox78', 'safari14'],
  outfile: 'dist/v1/snippet.js',
  define: {
    'process.env.NODE_ENV': '"production"',
    __VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: `/* wiredHowse Magic Link v${pkg.version} — https://magic-link.wiredhowse.app */`,
  },
});

console.log('Snippet built → dist/v1/snippet.js');
