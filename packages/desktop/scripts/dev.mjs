/**
 * Dev harness (Task 2.1.1): starts the Vite dev server for the renderer,
 * then launches Electron pointed at it. `pnpm --filter @flowforge/desktop dev`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const server = await createServer({ configFile });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Vite dev server did not report a local URL');
console.log(`Renderer dev server: ${url}`);

const electronPath = (await import('electron')).default;
// On Linux, Electron's Chromium sandbox needs a root-owned setuid
// `chrome-sandbox` helper that npm/pnpm installs rarely provide. Rather than
// abort, run the *dev* harness with the sandbox disabled (production should
// set up the helper: `sudo chown root:root chrome-sandbox && sudo chmod 4755
// chrome-sandbox`).
const electronArgs = process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'];
const child = spawn(electronPath, electronArgs, {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url }
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
