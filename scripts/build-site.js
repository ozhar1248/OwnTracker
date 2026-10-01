import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from '../public/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'public');
const output = resolve(root, 'site');
if (config.mode !== 'supabase' || !config.publishableKey.startsWith('sb_publishable_')) throw new Error('Cloud publishable configuration is required for deployment.');
const cloudOrigin = new URL(config.supabaseUrl).origin;
if (!cloudOrigin.startsWith('https://')) throw new Error('Supabase URL must use HTTPS.');
mkdirSync(resolve(output, 'icons'), { recursive: true });
// An explicit allowlist keeps databases, source server files and tests out of the deployment.
const files = ['index.html', 'app.js', 'styles.css', 'domain.js', 'cloud-client.js', 'config.js', 'favicon.svg', 'install.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
for (const file of files) copyFileSync(resolve(source, file), resolve(output, file));
writeFileSync(resolve(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${cloudOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
  Cache-Control: no-cache
`);
console.log(`Deployment folder: ${output}`);
console.log('Upload this folder to a static HTTPS host. No Node server or database files are included.');
