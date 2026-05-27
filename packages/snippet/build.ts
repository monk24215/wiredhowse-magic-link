/**
 * esbuild config — produces two browser bundles:
 *
 *   dist/snippet.js     — main snippet, embedded on customer sites via <script>
 *   dist/snippet-ui.js  — iframe contents, loaded at /v1/snippet/ui
 *
 * Both bundles target ES2020 / Chrome 80+ / Firefox 78+ / Safari 14+.
 * No Node.js dependencies. No polyfills. Minified.
 *
 * Usage:
 *   pnpm build                   — production build, API_BASE = magic-link.wiredhowse.app
 *   WH_API_BASE=http://localhost:3000 pnpm build  — local dev build
 *   WH_BUNDLE_ANALYZE=1 pnpm build               — print per-module sizes
 */

import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };
  const version = pkg.version;

  const API_BASE =
    process.env['WH_API_BASE'] ?? 'https://magic-link.wiredhowse.app';

  const sharedConfig: esbuild.BuildOptions = {
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020', 'chrome80', 'firefox78', 'safari14'],
    define: {
      'process.env.NODE_ENV': '"production"',
      __VERSION__: JSON.stringify(version),
      __API_BASE__: JSON.stringify(API_BASE),
    },
    sourcemap: process.env['NODE_ENV'] !== 'production',
  };

  // Build both bundles in parallel.
  const [mainResult] = await Promise.all([
    esbuild.build({
      ...sharedConfig,
      entryPoints: ['src/index.ts'],
      // No globalName: the IIFE sets window.wiredhowseAuth as a side effect.
      outfile: 'dist/snippet.js',
      banner: {
        js: `/* wiredHowse Magic Link v${version} — https://magic-link.wiredhowse.app */`,
      },
      metafile: true,
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: ['src/ui/index.ts'],
      outfile: 'dist/snippet-ui.js',
      banner: {
        js: `/* wiredHowse Magic Link UI v${version} — https://magic-link.wiredhowse.app */`,
      },
    }),
  ]);

  // ---------------------------------------------------------------------------
  // Bundle-size assertion — gzipped main bundle must be <15 KiB (spec req.)
  // ---------------------------------------------------------------------------

  const mainBytes = readFileSync('dist/snippet.js');
  const gzipped = gzipSync(mainBytes, { level: 9 });
  const gzKib = (gzipped.length / 1024).toFixed(2);
  const LIMIT_KIB = 15;

  console.log(`snippet.js    → ${(mainBytes.length / 1024).toFixed(2)} KiB raw, ${gzKib} KiB gzip`);
  console.log('snippet-ui.js → built');

  if (gzipped.length > LIMIT_KIB * 1024) {
    console.error(
      `\n❌  Bundle size limit exceeded: ${gzKib} KiB gzipped (limit: ${LIMIT_KIB} KiB).\n` +
        '   Review imports and remove any unnecessary code.\n',
    );
    process.exit(1);
  }

  console.log(`✓  snippet.js ${gzKib} KiB gzipped — within ${LIMIT_KIB} KiB limit`);

  // Log metafile for debugging large builds.
  if (process.env['WH_BUNDLE_ANALYZE'] && mainResult.metafile) {
    console.log('\n--- main bundle inputs ---');
    for (const [file, meta] of Object.entries(mainResult.metafile.inputs)) {
      console.log(`  ${file}: ${(meta.bytes / 1024).toFixed(2)} KiB`);
    }
  }
}

void main();
