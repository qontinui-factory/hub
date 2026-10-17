import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Static site (plan D1): every exhibit is read from its frozen public snapshot
// at build time by scripts/fetch-exhibits.mjs, never at runtime.
export default defineConfig({
  site: 'https://build.qontinui.io',
  output: 'static',
  integrations: [react()],
});
