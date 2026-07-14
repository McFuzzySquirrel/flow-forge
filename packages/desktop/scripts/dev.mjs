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
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url }
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
