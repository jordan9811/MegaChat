/**
 * Bundle src/passkey-wallet.mjs → public/passkey-wallet.bundle.js for the browser.
 * Re-run after any edit to src/passkey-wallet.mjs:  npm run build:passkey
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src/passkey-wallet.mjs');
const outfile = path.join(root, 'public/passkey-wallet.bundle.js');

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('✓ public/passkey-wallet.bundle.js — re-run npm run build:passkey after editing src/passkey-wallet.mjs');
