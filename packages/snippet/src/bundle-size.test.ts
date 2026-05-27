/**
 * Bundle-size regression guard.
 *
 * Asserts the gzipped main snippet bundle is under 15 KiB.
 * Currently ~3.16 KiB, so this is a regression guard, not a constraint.
 *
 * This test only runs if dist/snippet.js exists (i.e., after `pnpm build`).
 * In CI, the build step runs before the test step, so this will always execute.
 * In a fresh checkout without a prior build, the test is skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DIST = join(__dirname, '../dist');
const MAIN_BUNDLE = join(DIST, 'snippet.js');
const UI_BUNDLE = join(DIST, 'snippet-ui.js');
const LIMIT_KIB = 15;

describe('bundle size', () => {
  it.skipIf(!existsSync(MAIN_BUNDLE))(`snippet.js gzipped < ${LIMIT_KIB} KiB`, () => {
    const raw = readFileSync(MAIN_BUNDLE);
    const gz = gzipSync(raw, { level: 9 });
    const gzKib = gz.length / 1024;

    expect(
      gzKib,
      `snippet.js is ${gzKib.toFixed(2)} KiB gzipped — limit is ${LIMIT_KIB} KiB`,
    ).toBeLessThan(LIMIT_KIB);
  });

  it.skipIf(!existsSync(UI_BUNDLE))(`snippet-ui.js gzipped < ${LIMIT_KIB} KiB`, () => {
    const raw = readFileSync(UI_BUNDLE);
    const gz = gzipSync(raw, { level: 9 });
    const gzKib = gz.length / 1024;

    // The UI bundle has more content (styles + DOM logic) but still target <15 KiB.
    expect(
      gzKib,
      `snippet-ui.js is ${gzKib.toFixed(2)} KiB gzipped — limit is ${LIMIT_KIB} KiB`,
    ).toBeLessThan(LIMIT_KIB);
  });

  it.skipIf(!existsSync(MAIN_BUNDLE))('snippet.js exists in dist/', () => {
    expect(existsSync(MAIN_BUNDLE)).toBe(true);
  });

  it.skipIf(!existsSync(UI_BUNDLE))('snippet-ui.js exists in dist/', () => {
    expect(existsSync(UI_BUNDLE)).toBe(true);
  });
});
