import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build (Task 2.1.1): the React app lives in renderer/ and builds to
// dist/renderer, which the Electron main process loads in production.
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true
  }
});
