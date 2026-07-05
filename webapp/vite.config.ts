import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Served from a plugin-specific subpath (/plugins/signalk-tidal-currents/),
// not domain root — base MUST be relative or asset URLs 404 there.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  publicDir: 'static-assets',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    sourcemap: true,
  },
});
